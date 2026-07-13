"""storylines DAG -- normalized tables -> luck / churn / waiver_spend / rivalries (issue #16).

The storyline stage, downstream of ``normalize``. Reads the derived tables normalize wrote
(``teams`` / ``team_week_scores`` / ``transactions``) and writes partitioned, idempotent
storyline tables (via ``write_table``) the bot/renderer can read. No ESPN calls -- a clean
dependency boundary: pure transforms over the derived tables. Triggered when ``normalize`` emits
``NORMALIZED_DATASET`` (and still manually triggerable/backfillable); its data-quality gate emits
``STORYLINES_DATASET`` to trigger ``weekly_throwback`` -- see ``dags/datasets.py``.

Config via Airflow Variables with env fallbacks (see orchestration/README.md):
``INGEST_SEASON``, ``NORMALIZED_ROOT`` (read source), ``STORYLINES_ROOT`` (write dest).
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from airflow.decorators import dag, task
from airflow.models import Variable
from conventions import (
    check_min_rows,
    check_no_null_fields,
    pipeline_default_args,
    run_data_quality,
)
from datasets import NORMALIZED_DATASET, STORYLINES_DATASET
from normalize import (
    clear_weekly_partitions,
    group_rows_by_week,
    read_all_weeks,
    read_table,
    write_table,
)
from storylines import (
    compute_churn,
    compute_luck,
    compute_rivalries,
    compute_waiver_spend_by_week,
    season_week_count,
)

DEFAULT_NORMALIZED_ROOT = "/opt/airflow/data/normalized"
DEFAULT_STORYLINES_ROOT = "/opt/airflow/data/storylines"


def _cfg(key: str, default: str = "") -> str:
    """Prefer an Airflow Variable, fall back to the process env, then a default."""
    return Variable.get(key, default_var=os.environ.get(key, default))


def _write_weekly(ctx: dict, table: str, rows: list) -> list[str]:
    """Write one partition per (season, week) for a weekly table; return the paths."""
    paths: list[str] = []
    for week, week_rows in sorted(group_rows_by_week(rows).items()):
        path = write_table(
            ctx["storylines_root"],
            ctx["season"],
            table,
            week_rows,
            as_of=ctx["as_of"],
            week=week,
        )
        print(f"Wrote {table} week={week} ({len(week_rows)} rows) -> {path}")
        paths.append(str(path))
    return paths


@dag(
    dag_id="storylines",
    description="Compute luck / churn / waiver-spend / rivalry metrics from the normalized tables.",
    # Data-aware: triggered when normalize emits NORMALIZED_DATASET. Still manually triggerable.
    schedule=[NORMALIZED_DATASET],
    start_date=datetime(2025, 1, 1),
    catchup=False,
    default_args=pipeline_default_args(),
    tags=["fantasy-canon", "storylines"],
)
def storylines():
    @task
    def resolve_context() -> dict:
        season = _cfg("INGEST_SEASON")
        if not season.strip():
            raise ValueError("INGEST_SEASON is required")
        # One `as_of` per run so every table written by this run shares an audit stamp.
        return {
            "season": int(season),
            "normalized_root": _cfg("NORMALIZED_ROOT", DEFAULT_NORMALIZED_ROOT),
            "storylines_root": _cfg("STORYLINES_ROOT", DEFAULT_STORYLINES_ROOT),
            "as_of": datetime.now(timezone.utc).isoformat(),
        }

    @task
    def luck_table(ctx: dict) -> str:
        scores = read_all_weeks(ctx["normalized_root"], ctx["season"], "team_week_scores")
        rows = compute_luck(scores)
        path = write_table(ctx["storylines_root"], ctx["season"], "luck", rows, as_of=ctx["as_of"])
        print(f"Wrote luck table ({len(rows)} rows) -> {path}")
        return str(path)

    @task
    def churn_table(ctx: dict) -> str:
        scores = read_all_weeks(ctx["normalized_root"], ctx["season"], "team_week_scores")
        transactions = read_all_weeks(ctx["normalized_root"], ctx["season"], "transactions")
        rows = compute_churn(transactions, weeks=season_week_count(scores))
        path = write_table(ctx["storylines_root"], ctx["season"], "churn", rows, as_of=ctx["as_of"])
        print(f"Wrote churn table ({len(rows)} rows) -> {path}")
        return str(path)

    @task
    def waiver_spend_table(ctx: dict) -> list[str]:
        transactions = read_all_weeks(ctx["normalized_root"], ctx["season"], "transactions")
        rows = compute_waiver_spend_by_week(transactions)
        # Clear first so a rerun where a week goes empty doesn't leave a stale partition behind
        # (weekly tables only write weeks that have rows) -- keeps the overwrite truly idempotent.
        clear_weekly_partitions(ctx["storylines_root"], ctx["season"], "waiver_spend")
        return _write_weekly(ctx, "waiver_spend", rows)

    @task
    def rivalries_table(ctx: dict) -> str:
        scores = read_all_weeks(ctx["normalized_root"], ctx["season"], "team_week_scores")
        rows = compute_rivalries(scores)
        path = write_table(
            ctx["storylines_root"], ctx["season"], "rivalries", rows, as_of=ctx["as_of"]
        )
        print(f"Wrote rivalries table ({len(rows)} rows) -> {path}")
        return str(path)

    @task(outlets=[STORYLINES_DATASET])
    def quality_gate(ctx: dict, _written: list) -> None:
        """Fail the DAG if a storyline table looks wrong (no rows, null ids).

        Runs after every table is written (``_written`` carries the upstream XComs only to order
        this task last); re-reads the tables from disk and runs the shared checks so a bad load is
        caught loudly here instead of silently feeding the bot/renderer.

        On success it emits ``STORYLINES_DATASET``, triggering the ``weekly_throwback`` DAG -- so
        the throwback only fires when the storyline tables passed their quality checks.
        """
        luck = read_table(ctx["storylines_root"], ctx["season"], "luck")["rows"]
        churn = read_table(ctx["storylines_root"], ctx["season"], "churn")["rows"]
        rivalries = read_table(ctx["storylines_root"], ctx["season"], "rivalries")["rows"]
        run_data_quality(
            # luck has one row per team, so an empty luck table means the season failed to load.
            check_min_rows(luck, table="luck"),
            check_no_null_fields(luck, table="luck", fields=["teamId"]),
            check_no_null_fields(churn, table="churn", fields=["teamId"]),
            check_no_null_fields(rivalries, table="rivalries", fields=["teamA", "teamB"]),
        )
        print("data-quality gate passed")

    context = resolve_context()
    # The four storyline tables are independent; each fans out from the shared context.
    written = [
        luck_table(context),
        churn_table(context),
        waiver_spend_table(context),
        rivalries_table(context),
    ]
    # Gate runs last: passing the four XComs makes it depend on all of them.
    quality_gate(context, written)


storylines()
