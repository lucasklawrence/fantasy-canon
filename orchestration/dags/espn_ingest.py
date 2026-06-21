"""espn_ingest DAG — pull ESPN views for a season into idempotent snapshots (issue #14).

The **extract** step of the pipeline (ESPN → snapshots → normalize → storylines). One
mapped task per view fetches the raw payload and writes it to a partitioned, atomically
overwritten snapshot, so re-runs and backfills are idempotent. Fetching is pure Python
(``requests``) — no Node worker needed for ingest.

Config via Airflow Variables with env fallbacks (see orchestration/README.md):
``ESPN_LEAGUE_ID``, ``INGEST_SEASON``, ``INGEST_VIEWS`` (optional), ``SNAPSHOT_ROOT``
(optional), plus ``ESPN_S2``/``ESPN_SWID`` for private leagues.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta

from airflow.decorators import dag, task
from airflow.models import Variable
from espn import fetch_view
from snapshots import write_snapshot

DEFAULT_VIEWS = ("mTeam", "mRoster", "mScoreboard", "mTransactions2", "mSettings", "mDraftDetail")
DEFAULT_SNAPSHOT_ROOT = "/opt/airflow/data/snapshots"


def _cfg(key: str, default: str = "") -> str:
    """Prefer an Airflow Variable, fall back to the process env, then a default."""
    return Variable.get(key, default_var=os.environ.get(key, default))


@dag(
    dag_id="espn_ingest",
    description="Pull ESPN views for a season into idempotent, partitioned snapshots.",
    # Manual/triggered for now; an in-season weekly cadence lands with the wider pipeline.
    schedule=None,
    start_date=datetime(2025, 1, 1),
    catchup=False,
    default_args={"retries": 3, "retry_delay": timedelta(minutes=2)},
    tags=["fantasy-canon", "ingest"],
)
def espn_ingest():
    @task
    def resolve_views() -> list[str]:
        raw = _cfg("INGEST_VIEWS")
        parsed = [v.strip() for v in raw.split(",") if v.strip()]
        return parsed or list(DEFAULT_VIEWS)

    @task
    def ingest_view(view: str) -> str:
        league_id = _cfg("ESPN_LEAGUE_ID")
        season = _cfg("INGEST_SEASON")
        root = _cfg("SNAPSHOT_ROOT", DEFAULT_SNAPSHOT_ROOT)
        if not league_id:
            raise ValueError("ESPN_LEAGUE_ID is required")
        if not season.strip():
            raise ValueError("INGEST_SEASON is required")

        payload = fetch_view(
            league_id,
            int(season),
            view,
            espn_s2=os.environ.get("ESPN_S2") or None,
            swid=os.environ.get("ESPN_SWID") or None,
        )
        path = write_snapshot(root, int(season), view, payload)
        print(f"Wrote {view} snapshot -> {path}")
        return str(path)

    # One mapped task per view — independent fetch + write, independent retries.
    ingest_view.expand(view=resolve_views())


espn_ingest()
