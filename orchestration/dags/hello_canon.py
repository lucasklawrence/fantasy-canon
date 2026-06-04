"""Smoke-test DAG for the Fantasy Canon orchestration sidecar (issue #13, epic #12).

Proves the local Airflow loop end to end: the scheduler parses this file, the
webserver shows it, and a manual trigger runs both tasks green. It also reads the
ESPN_LEAGUE_ID env so you can confirm config is wired through before real DAGs land.

Real DAGs (espn_ingest, normalize, storylines, weekly_throwback) replace this in
issues #14-#17. Once those exist, this file can be deleted.
"""

from __future__ import annotations

import os
from datetime import datetime

from airflow.decorators import dag, task


@dag(
    dag_id="hello_canon",
    description="Smoke test: verifies local Airflow parses, schedules, and runs.",
    schedule=None,  # manual trigger only
    start_date=datetime(2025, 1, 1),
    catchup=False,
    tags=["fantasy-canon", "smoke-test"],
)
def hello_canon():
    @task
    def check_config() -> str:
        """Surface the league id so we can see env flows from compose into a task."""
        league_id = os.environ.get("ESPN_LEAGUE_ID") or "(unset — set it in orchestration/.env)"
        print(f"ESPN_LEAGUE_ID = {league_id}")
        return league_id

    @task
    def greet(league_id: str) -> None:
        print(f"Fantasy Canon orchestration is alive. League: {league_id}")

    greet(check_config())


hello_canon()
