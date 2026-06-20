"""Pure helpers for the ``weekly_broadcast`` DAG.

Kept deliberately airflow-free so the command construction unit-tests without a
scheduler. Builds the shell command that runs the bot's broadcast CLI
(``apps/bot/broadcast.ts``; see ``docs/decisions/0002-scheduling-airflow.md``).
"""

from __future__ import annotations

import shlex

# Default invocation. The worker must be able to run the bot's Node CLI — bake Node +
# the repo into the Airflow image or run a bot container — so this is overridable via
# the ``CANON_BROADCAST_CMD`` Airflow Variable / env. The trailing ``--`` lets pnpm pass
# the following flags through to the script.
DEFAULT_BROADCAST_CMD = "pnpm --dir /opt/fantasy-canon/apps/bot run broadcast --"

# Metrics the broadcaster renders today (mirrors BROADCAST_METRICS in broadcastRender.ts).
BROADCAST_METRICS = ("power-ranking", "standings")


def build_broadcast_command(
    *,
    base_cmd: str,
    channel_id: str,
    metric: str,
    season: str,
    league_id: str = "",
) -> str:
    """Return the shell command that posts one metric's card to Discord.

    Injected values are shell-quoted so league/channel ids can't break the command.
    Raises ``ValueError`` on missing required inputs so a misconfigured DAG fails loudly
    rather than invoking the CLI with blank args.
    """
    if not base_cmd.strip():
        raise ValueError("base_cmd is required")
    if not channel_id:
        raise ValueError("channel_id is required (set BROADCAST_CHANNEL_ID)")
    if metric not in BROADCAST_METRICS:
        raise ValueError(f"metric must be one of {BROADCAST_METRICS}, got {metric!r}")
    if not str(season).strip():
        raise ValueError("season is required (set BROADCAST_SEASON)")

    parts = [
        base_cmd.strip(),
        "--channel",
        shlex.quote(str(channel_id)),
        "--metric",
        shlex.quote(metric),
        "--season",
        shlex.quote(str(season)),
    ]
    if league_id:
        parts += ["--league", shlex.quote(str(league_id))]
    return " ".join(parts)
