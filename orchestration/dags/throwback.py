"""Pure helpers for the ``weekly_throwback`` DAG (issue #17).

The **throwback** surface: an "on this week in history" post the sidecar sends to Discord on a
weekly rotation. Two jobs live here, both kept airflow-free so they unit-test without a scheduler
(and free of any bot logic, keeping the sidecar boundary clean -- see ADR 0002):

1. **Selection** -- ``select_post_type`` rotates through a fixed list of post types week to week;
   ``select_throwback`` reads the storyline tables ``storylines`` wrote (luck / churn / rivalries /
   waiver_spend) and picks the single most-notable row for that type. If the rotation's table is
   empty it *falls through* to the next type that has data, so a run still posts something as long
   as any storyline exists.

2. **Bot hand-off** -- ``build_throwback_command`` builds the shell command that shells out to the
   bot's throwback CLI (mirroring ``canon_broadcast.build_broadcast_command``). The DAG decides
   *what* to post (post type + a compact ``ref`` identifying the row); the bot renders and posts it.
"""

from __future__ import annotations

import shlex
from typing import Optional

# The weekly rotation. Ordered; a run posts ``THROWBACK_POST_TYPES[week % len]`` (falling through
# to the next type with data). Keep in sync with the post types the bot's throwback CLI can render.
THROWBACK_POST_TYPES = ("rivalry", "waiver_legend", "luck", "churn")

# Default invocation of the bot's throwback CLI. Like the broadcaster, the worker must be able to
# run the bot's Node CLI (bake Node + the repo into the Airflow image, or run a bot container), so
# this is overridable via the ``CANON_THROWBACK_CMD`` Airflow Variable / env. The trailing ``--``
# lets pnpm pass the following flags through to the script.
DEFAULT_THROWBACK_CMD = "pnpm --dir /opt/fantasy-canon/apps/bot run throwback --"


def select_post_type(rotation_index: int) -> str:
    """The post type for a given rotation index (e.g. the ISO week number), wrapping the list."""
    return THROWBACK_POST_TYPES[rotation_index % len(THROWBACK_POST_TYPES)]


# --------------------------------------------------------------------- per-type selectors
#
# Each picks the single most-notable row for its post type and returns a throwback descriptor
# ``{post_type, ref, title}`` (``ref`` = a compact id the bot resolves back to the row), or None
# when its table is empty. Selection is order-independent (explicit max key), so a caller need not
# rely on the storyline table already being sorted.


def _select_rivalry(rivalries: list[dict]) -> Optional[dict]:
    """The most lopsided head-to-head (largest win differential; break ties by total points)."""
    if not rivalries:
        return None
    row = max(
        rivalries,
        key=lambda r: (
            abs(_int(r.get("aWins")) - _int(r.get("bWins"))),
            _num(r.get("aPoints")) + _num(r.get("bPoints")),
            -_int(r.get("teamA")),
        ),
    )
    a, b = _int(row.get("teamA")), _int(row.get("teamB"))
    a_wins, b_wins = _int(row.get("aWins")), _int(row.get("bWins"))
    return {
        "post_type": "rivalry",
        "ref": f"{a}:{b}",
        "title": f"Biggest rivalry: Team {a} vs Team {b} ({a_wins}-{b_wins})",
    }


def _select_waiver_legend(waiver_spend: list[dict]) -> Optional[dict]:
    """The single biggest FAAB splash (largest per-week spend; break ties by earliest week)."""
    if not waiver_spend:
        return None
    row = max(
        waiver_spend,
        key=lambda r: (_num(r.get("spend")), -_int(r.get("week")), -_int(r.get("teamId"))),
    )
    week, team, spend = _int(row.get("week")), _int(row.get("teamId")), _num(row.get("spend"))
    return {
        "post_type": "waiver_legend",
        "ref": f"{week}:{team}",
        "title": f"Waiver legend: Team {team} spent ${spend:g} in week {week}",
    }


def _select_luck(luck: list[dict]) -> Optional[dict]:
    """The most extreme luck swing -- luckiest or unluckiest (largest absolute luck)."""
    if not luck:
        return None
    row = max(luck, key=lambda r: (abs(_num(r.get("luck"))), -_int(r.get("teamId"))))
    team, value = _int(row.get("teamId")), _num(row.get("luck"))
    label = "Luckiest" if value >= 0 else "Unluckiest"
    return {
        "post_type": "luck",
        "ref": f"{team}",
        "title": f"{label}: Team {team} ({value:+g} wins vs expected)",
    }


def _select_churn(churn: list[dict]) -> Optional[dict]:
    """The most active roster -- the team with the most moves (break ties by lower team id)."""
    if not churn:
        return None
    row = max(churn, key=lambda r: (_int(r.get("moves")), -_int(r.get("teamId"))))
    team, moves = _int(row.get("teamId")), _int(row.get("moves"))
    return {
        "post_type": "churn",
        "ref": f"{team}",
        "title": f"Most active: Team {team} with {moves} roster moves",
    }


_SELECTORS = {
    "rivalry": lambda t: _select_rivalry(t["rivalries"]),
    "waiver_legend": lambda t: _select_waiver_legend(t["waiver_spend"]),
    "luck": lambda t: _select_luck(t["luck"]),
    "churn": lambda t: _select_churn(t["churn"]),
}


def select_throwback(
    post_type: str,
    *,
    luck: list[dict],
    churn: list[dict],
    rivalries: list[dict],
    waiver_spend: list[dict],
) -> Optional[dict]:
    """Select the throwback to post, starting at ``post_type`` and falling through the rotation.

    Tries the requested type's table first; if it's empty, walks the remaining rotation in order
    and returns the first type that has data. Returns the descriptor ``{post_type, ref, title}``
    (whose ``post_type`` may differ from the argument if it fell through), or None if every
    storyline table is empty -- in which case the DAG has nothing to post and skips.
    """
    if post_type not in _SELECTORS:
        raise ValueError(f"post_type must be one of {tuple(_SELECTORS)}, got {post_type!r}")
    tables = {"luck": luck, "churn": churn, "rivalries": rivalries, "waiver_spend": waiver_spend}
    start = THROWBACK_POST_TYPES.index(post_type)
    order = THROWBACK_POST_TYPES[start:] + THROWBACK_POST_TYPES[:start]
    for candidate in order:
        selected = _SELECTORS[candidate](tables)
        if selected is not None:
            return selected
    return None


def build_throwback_command(
    *,
    base_cmd: str,
    channel_id: str,
    post_type: str,
    ref: str,
    season: str,
    league_id: str = "",
) -> str:
    """Return the shell command that posts one throwback to Discord via the bot's throwback CLI.

    Injected values are shell-quoted so ids/refs can't break the command. Raises ``ValueError`` on
    missing/invalid inputs so a misconfigured DAG fails loudly rather than invoking the CLI with
    blank args. The bot resolves ``post_type`` + ``ref`` + ``season`` back to the storyline row and
    renders it -- selection stays here, rendering stays in the bot.
    """
    if not base_cmd.strip():
        raise ValueError("base_cmd is required")
    if not channel_id:
        raise ValueError("channel_id is required (set THROWBACK_CHANNEL_ID)")
    if post_type not in THROWBACK_POST_TYPES:
        raise ValueError(f"post_type must be one of {THROWBACK_POST_TYPES}, got {post_type!r}")
    if not str(ref).strip():
        raise ValueError("ref is required")
    if not str(season).strip():
        raise ValueError("season is required (set INGEST_SEASON)")

    parts = [
        base_cmd.strip(),
        "--channel",
        shlex.quote(str(channel_id)),
        "--post-type",
        shlex.quote(post_type),
        "--ref",
        shlex.quote(str(ref)),
        "--season",
        shlex.quote(str(season)),
    ]
    if league_id:
        parts += ["--league", shlex.quote(str(league_id))]
    return " ".join(parts)


# --------------------------------------------------------------------------------- coercion
#
# Local, defensive coercers (identical semantics to normalize/storylines): storyline rows are
# read back from JSON, so a selector keys on numbers without tripping over a stray null/string.


def _num(val) -> float:
    """Coerce to float, else 0.0 -- for max() keys where a missing value should sort lowest."""
    try:
        return float(val)
    except (TypeError, ValueError):
        return 0.0


def _int(val) -> int:
    """Coerce to int via float, else 0."""
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return 0
