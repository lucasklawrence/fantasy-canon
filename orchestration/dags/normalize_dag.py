"""normalize DAG -- snapshots -> teams / team_week_scores / transactions (issue #15).

The transform stage, downstream of ``espn_ingest``. Reads the raw snapshots ingest wrote
(via ``read_snapshot``) and writes partitioned, idempotent derived tables (via
``write_table``). It runs as its own DAG so the transform stage is independently
triggerable/backfillable -- the storylines DAG (issue #16) will consume these tables in turn.

Config via Airflow Variables with env fallbacks (see orchestration/README.md):
``INGEST_SEASON``, ``SNAPSHOT_ROOT`` (read source), ``NORMALIZED_ROOT`` (write dest).
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

from airflow.decorators import dag, task
from airflow.models import Variable
from normalize import (
    group_rows_by_week,
    normalize_team_week_scores,
    normalize_teams,
    normalize_transactions,
    write_table,
)
from snapshots import read_snapshot

DEFAULT_SNAPSHOT_ROOT = "/opt/airflow/data/snapshots"
DEFAULT_NORMALIZED_ROOT = "/opt/airflow/data/normalized"


def _cfg(key: str, default: str = "") -> str:
    """Prefer an Airflow Variable, fall back to the process env, then a default."""
    return Variable.get(key, default_var=os.environ.get(key, default))


def _write_weekly(ctx: dict, table: str, rows: list) -> list[str]:
    """Write one partition per (season, week) for a weekly table; return the paths."""
    paths: list[str] = []
    for week, week_rows in sorted(group_rows_by_week(rows).items()):
        path = write_table(
            ctx["normalized_root"],
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
    dag_id="normalize",
    description="Normalize raw ESPN snapshots into partitioned, idempotent derived tables.",
    # Manual/triggered for now; wired downstream of espn_ingest with the wider pipeline.
    schedule=None,
    start_date=datetime(2025, 1, 1),
    catchup=False,
    default_args={"retries": 3, "retry_delay": timedelta(minutes=2)},
    tags=["fantasy-canon", "normalize"],
)
def normalize():
    @task
    def resolve_context() -> dict:
        season = _cfg("INGEST_SEASON")
        if not season.strip():
            raise ValueError("INGEST_SEASON is required")
        # One `as_of` per run so every table written by this run shares an audit stamp.
        return {
            "season": int(season),
            "snapshot_root": _cfg("SNAPSHOT_ROOT", DEFAULT_SNAPSHOT_ROOT),
            "normalized_root": _cfg("NORMALIZED_ROOT", DEFAULT_NORMALIZED_ROOT),
            "as_of": datetime.now(timezone.utc).isoformat(),
        }

    @task
    def normalize_teams_table(ctx: dict) -> str:
        payload = read_snapshot(ctx["snapshot_root"], ctx["season"], "mTeam")
        rows = normalize_teams(payload)
        path = write_table(ctx["normalized_root"], ctx["season"], "teams", rows, as_of=ctx["as_of"])
        print(f"Wrote teams table ({len(rows)} rows) -> {path}")
        return str(path)

    @task
    def normalize_scores_table(ctx: dict) -> list[str]:
        payload = read_snapshot(ctx["snapshot_root"], ctx["season"], "mScoreboard")
        rows = normalize_team_week_scores(payload)
        return _write_weekly(ctx, "team_week_scores", rows)

    @task
    def normalize_transactions_table(ctx: dict) -> list[str]:
        payload = read_snapshot(ctx["snapshot_root"], ctx["season"], "mTransactions2")
        rows = normalize_transactions(payload)
        return _write_weekly(ctx, "transactions", rows)

    context = resolve_context()
    # The three tables are independent; each fans out from the shared context.
    normalize_teams_table(context)
    normalize_scores_table(context)
    normalize_transactions_table(context)


normalize()
