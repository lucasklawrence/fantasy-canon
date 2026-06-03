"""Weekly fantasy football research pipeline.

Mimics a production data workflow: on a weekly schedule, invoke the
`/fantasy-research` Claude Code skill headlessly. The skill runs the
deep-research workflow (fan-out web search -> fetch -> adversarial verify ->
synthesize) and archives a cited report to research/ in the repo.

This is a STUB to grow into. It assumes:
  * the `claude` CLI is installed and authenticated on the Airflow worker
  * the worker has a checkout of this repo at REPO_DIR
  * the worker has network access for web search

During the NFL season you'll typically want this firing Tuesday morning
(post-Monday-night, pre-waivers). In the offseason, any weekday is fine.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.bash import BashOperator

# --- Config -----------------------------------------------------------------
# Point this at the Airflow worker's checkout of fantasy-canon.
REPO_DIR = os.environ.get("FANTASY_CANON_DIR", "/opt/fantasy-canon")

# The skill is invoked as a slash command in headless (-p) mode.
# --permission-mode acceptEdits lets it write the archive file unattended;
# web search/fetch run under the same non-interactive grant.
# (Use --dangerously-skip-permissions only in a fully isolated/CI sandbox.)
RESEARCH_TOPIC = "{{ dag_run.conf.get('topic', 'weekly fantasy update') }}"

CLAUDE_CMD = (
    'claude -p "/fantasy-research {topic}" '
    "--permission-mode acceptEdits "
    "--output-format text"
).format(topic=RESEARCH_TOPIC)

# After the agent writes the report, commit it so the archive is durable.
COMMIT_CMD = (
    'git add research/ && '
    'git diff --cached --quiet || '
    'git commit -m "research: weekly fantasy report {{ ds }}"'
)

default_args = {
    "owner": "lucas",
    "retries": 1,
    "retry_delay": timedelta(minutes=10),
    "depends_on_past": False,
}

with DAG(
    dag_id="fantasy_research_weekly",
    description="Weekly fact-checked fantasy football research via Claude Code",
    default_args=default_args,
    # Tuesday 09:00 UTC. Adjust cron as the season demands.
    schedule="0 9 * * 2",
    start_date=datetime(2026, 6, 1),
    catchup=False,
    max_active_runs=1,
    tags=["fantasy", "claude", "research"],
) as dag:

    run_research = BashOperator(
        task_id="run_fantasy_research",
        cwd=REPO_DIR,
        bash_command=CLAUDE_CMD,
        # The deep-research workflow can take several minutes.
        execution_timeout=timedelta(minutes=30),
    )

    commit_report = BashOperator(
        task_id="commit_report",
        cwd=REPO_DIR,
        bash_command=COMMIT_CMD,
    )

    run_research >> commit_report
