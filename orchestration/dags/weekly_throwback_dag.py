"""weekly_throwback DAG -- storyline tables -> 'on this week in history' Discord post (issue #17).

The **throwback** surface of the pipeline -- the tail of the cascade, downstream of ``storylines``.
Triggered when ``storylines`` emits ``STORYLINES_DATASET`` (and still manually triggerable), it
reads the storyline tables, picks one post on a rotation of post types, and hands it to the bot to
post -- the DAG selects *what* to post; the bot renders and posts it (no bot logic here, keeping the
sidecar boundary clean, per ADR 0002). The rotation still advances by ISO week, so the post type
varies week to week regardless of what triggered the run.

Runtime requirement: the ``post`` task shells out to the bot's Node CLI, so the Airflow worker must
be able to run it (bake Node + the repo into the image, or run a bot container) and the bot must
expose a ``throwback`` command -- see orchestration/README.md. Delivered paused; unpause once the
bot side + Discord secrets are in place (like ``weekly_broadcast``).

Config via Airflow Variables with env fallbacks (see orchestration/README.md):
``INGEST_SEASON``, ``STORYLINES_ROOT`` (read source), ``THROWBACK_CHANNEL_ID``,
``THROWBACK_LEAGUE_ID`` (optional), ``CANON_THROWBACK_CMD`` (optional); ``DISCORD_TOKEN`` from env.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from airflow.decorators import dag, task
from airflow.models import Variable
from conventions import pipeline_default_args
from datasets import STORYLINES_DATASET
from normalize import read_all_weeks, read_table
from throwback import (
    DEFAULT_THROWBACK_CMD,
    build_throwback_command,
    select_post_type,
    select_throwback,
)

DEFAULT_STORYLINES_ROOT = "/opt/airflow/data/storylines"


def _cfg(key: str, default: str = "") -> str:
    """Prefer an Airflow Variable, fall back to the process env, then a default."""
    return Variable.get(key, default_var=os.environ.get(key, default))


def _season_rows(root: str, season: int, table: str) -> list[dict]:
    """Rows of a season-level storyline table, or [] if it hasn't been materialized yet."""
    try:
        return read_table(root, season, table)["rows"]
    except FileNotFoundError:
        return []


@dag(
    dag_id="weekly_throwback",
    description="Post an 'on this week in history' throwback from the storyline tables to Discord.",
    # Data-aware: triggered when storylines emits STORYLINES_DATASET (the cascade tail). Delivered
    # paused (Airflow default) -- unpause once the bot's throwback CLI + Discord secrets are wired
    # up. For a fixed weekly post time (and to skip backfills), swap this for a cron, e.g. the
    # SCHEDULE_* passes in conventions.py.
    schedule=[STORYLINES_DATASET],
    start_date=datetime(2025, 1, 1),
    catchup=False,
    default_args=pipeline_default_args(),
    tags=["fantasy-canon", "throwback"],
)
def weekly_throwback():
    @task
    def resolve_context() -> dict:
        season = _cfg("INGEST_SEASON")
        if not season.strip():
            raise ValueError("INGEST_SEASON is required")
        # Rotate the post type by ISO week so consecutive weekly runs cycle through the types.
        rotation_index = datetime.now(timezone.utc).isocalendar().week
        return {
            "season": int(season),
            "storylines_root": _cfg("STORYLINES_ROOT", DEFAULT_STORYLINES_ROOT),
            "channel_id": _cfg("THROWBACK_CHANNEL_ID"),
            "league_id": _cfg("THROWBACK_LEAGUE_ID", os.environ.get("ESPN_LEAGUE_ID", "")),
            "rotation_index": rotation_index,
        }

    @task
    def select(ctx: dict) -> dict:
        """Read the storyline tables and pick this week's throwback (post type + row ref).

        Returns the descriptor ``{post_type, ref, title}`` or ``{}`` when every storyline table is
        empty -- the ``post`` task then skips instead of invoking the CLI with nothing to render.
        """
        root, season = ctx["storylines_root"], ctx["season"]
        selected = select_throwback(
            select_post_type(ctx["rotation_index"]),
            luck=_season_rows(root, season, "luck"),
            churn=_season_rows(root, season, "churn"),
            rivalries=_season_rows(root, season, "rivalries"),
            waiver_spend=read_all_weeks(root, season, "waiver_spend"),
        )
        if selected is None:
            print("weekly_throwback: no storyline data to post; skipping")
            return {}
        print(f"weekly_throwback selected [{selected['post_type']}]: {selected['title']}")
        return selected

    @task.bash
    def post(ctx: dict, selected: dict) -> str:
        # An empty selection (no storyline data) posts nothing -- succeed with a no-op so the run
        # stays green rather than failing on missing data.
        if not selected:
            return "echo 'weekly_throwback: nothing to post; skipping'"
        return build_throwback_command(
            base_cmd=_cfg("CANON_THROWBACK_CMD", DEFAULT_THROWBACK_CMD),
            channel_id=ctx["channel_id"],
            post_type=selected["post_type"],
            ref=selected["ref"],
            season=str(ctx["season"]),
            league_id=ctx["league_id"],
        )

    context = resolve_context()
    post(context, select(context))


weekly_throwback()
