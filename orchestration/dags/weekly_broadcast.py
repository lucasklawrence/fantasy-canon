"""weekly_broadcast DAG — posts weekly Fantasy Canon cards to Discord (issue #51).

Once a week, renders the power-ranking and standings cards and posts them to the
league channel by invoking the bot's broadcast CLI (``apps/bot/broadcast.ts``). This
is the scheduled half of #51; the rendering/posting lives in the bot, per
``docs/decisions/0002-scheduling-airflow.md``.

Runtime requirement: the task shells out to the Node CLI, so the Airflow worker must
be able to run it — bake Node + the repo into the Airflow image, or run a bot
container — and override ``CANON_BROADCAST_CMD`` accordingly. Config comes from Airflow
Variables with env fallbacks; secrets (``DISCORD_TOKEN``, ESPN cookies) come from the
worker env. See orchestration/README.md.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta

from airflow.decorators import dag, task
from airflow.models import Variable
from canon_broadcast import BROADCAST_METRICS, DEFAULT_BROADCAST_CMD, build_broadcast_command


def _cfg(key: str, default: str = "") -> str:
    """Prefer an Airflow Variable, fall back to the process env, then a default."""
    return Variable.get(key, default_var=os.environ.get(key, default))


@dag(
    dag_id="weekly_broadcast",
    description="Post weekly power-ranking & standings cards to the league Discord channel.",
    # Tuesdays 16:00 UTC — the research cadence puts power rankings on Tuesday.
    schedule="0 16 * * 2",
    start_date=datetime(2025, 1, 1),
    catchup=False,
    default_args={"retries": 2, "retry_delay": timedelta(minutes=5)},
    tags=["fantasy-canon", "broadcast"],
)
def weekly_broadcast():
    @task.bash
    def post(metric: str) -> str:
        return build_broadcast_command(
            base_cmd=_cfg("CANON_BROADCAST_CMD", DEFAULT_BROADCAST_CMD),
            channel_id=_cfg("BROADCAST_CHANNEL_ID"),
            metric=metric,
            season=_cfg("BROADCAST_SEASON"),
            league_id=_cfg("BROADCAST_LEAGUE_ID", os.environ.get("ESPN_LEAGUE_ID", "")),
        )

    # One mapped task per metric — they post independently and retry independently.
    post.expand(metric=list(BROADCAST_METRICS))


weekly_broadcast()
