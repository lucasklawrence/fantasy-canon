"""Normalize raw ESPN snapshots into partitioned, idempotent derived tables (issue #15).

The **transform** step of the pipeline (ESPN -> snapshots -> normalize -> storylines). Pure
functions turn raw ESPN view payloads into flat rows for three derived tables:

    teams              (season-level)   <- mTeam
    team_week_scores   (per week)       <- mScoreboard schedule
    transactions       (per week)       <- mTransactions2

Storage mirrors ``snapshots.py``: partitioned JSON, atomically overwritten so a re-run or
backfill replaces a partition in place (the idempotency contract the storylines step relies
on). Each table file is an envelope carrying an ``as_of`` timestamp so revised numbers become
an auditable time series -- the partition is the audit grain, since a re-run rewrites the
whole partition:

    {root}/season={season}/{table}.json                 # season-level (teams)
    {root}/season={season}/week={week}/{table}.json      # per week (scores, transactions)

The transforms mirror the TS parsers already used by the bot (``weeklyScores.ts``,
``teamNames.ts``, ``transactions.ts``) so both sides read ESPN the same way. Stdlib only, so
they unit-test without Airflow or the network.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Any, Optional

# --------------------------------------------------------------------------- coercion


def _num(val: Any) -> Optional[float]:
    """Coerce to a finite float, else None (mirrors ensureNumber in weeklyScores.ts)."""
    try:
        n = float(val)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _int(val: Any) -> Optional[int]:
    """Coerce to int via a finite float, else None."""
    n = _num(val)
    return int(n) if n is not None else None


def _str(val: Any) -> str:
    """A string value or '' (mirrors the `typeof x === 'string' ? x : ''` guards in TS)."""
    return val if isinstance(val, str) else ""


def _str_or_none(val: Any) -> Optional[str]:
    """A string value or None (preserves absent enum-ish fields as null)."""
    return val if isinstance(val, str) else None


# ------------------------------------------------------------------------------- teams


def normalize_teams(mteam_payload: Any) -> list[dict]:
    """Flatten an mTeam payload into team rows (mirrors buildTeamNameMap/formatTeamName)."""
    rows: list[dict] = []
    if not isinstance(mteam_payload, dict):
        return rows
    teams = mteam_payload.get("teams")
    if not isinstance(teams, list):
        return rows
    for team in teams:
        if not isinstance(team, dict):
            continue
        team_id = _int(team.get("id"))
        if team_id is None:
            continue
        rows.append(
            {
                "teamId": team_id,
                "name": _team_name(team, team_id),
                "abbrev": _str(team.get("abbrev")),
                "location": _str(team.get("location")),
                "nickname": _str(team.get("nickname")),
            }
        )
    return rows


def _team_name(team: dict, team_id: int) -> str:
    """Display name: 'location nickname', else name, else abbrev, else 'Team <id>'."""
    location = _str(team.get("location"))
    nickname = _str(team.get("nickname"))
    if location or nickname:
        return f"{location} {nickname}".strip()
    name = _str(team.get("name"))
    if name:
        return name
    abbrev = _str(team.get("abbrev"))
    if abbrev:
        return abbrev
    return f"Team {team_id}"


# -------------------------------------------------------------------- team_week_scores


def normalize_team_week_scores(mscoreboard_payload: Any) -> list[dict]:
    """Flatten an mScoreboard schedule into per-team weekly rows with opponent + result.

    Mirrors ``extractWeeklyMatchups`` (weeklyScores.ts): reads ``schedule`` (falling back to
    ``matchups``), takes the week from ``matchupPeriodId`` (falling back to
    ``scoringPeriodId``), and resolves each matchup to exactly two sides (``home``/``away`` or
    a two-entry ``teams[]``). Each side becomes a row ``{week, teamId, points, oppId, result}``
    with ``result`` in ``W``/``L``/``T``. Matchups that don't resolve to two valid sides are
    skipped (byes, malformed entries).
    """
    rows: list[dict] = []
    for matchup in _matchup_source(mscoreboard_payload):
        if not isinstance(matchup, dict):
            continue
        week = _int(matchup.get("matchupPeriodId"))
        if week is None:
            week = _int(matchup.get("scoringPeriodId"))
        if week is None:
            continue
        home = _side(matchup.get("home"))
        away = _side(matchup.get("away"))
        if home is None or away is None:
            teams = matchup.get("teams")
            if isinstance(teams, list) and len(teams) == 2:
                home = _side(teams[0])
                away = _side(teams[1])
        if home is None or away is None:
            continue
        rows.append(_score_row(week, home, away))
        rows.append(_score_row(week, away, home))
    return rows


def _matchup_source(payload: Any) -> list:
    """The schedule array, preferring `schedule` then `matchups` (both optional)."""
    if not isinstance(payload, dict):
        return []
    schedule = payload.get("schedule")
    if isinstance(schedule, list):
        return schedule
    matchups = payload.get("matchups")
    if isinstance(matchups, list):
        return matchups
    return []


def _side(side: Any) -> Optional[dict]:
    """One matchup side as {teamId, points}, or None without a valid teamId.

    A missing/invalid score counts as 0 so the team still appears that week.
    """
    if not isinstance(side, dict):
        return None
    team_id = _int(side.get("teamId"))
    if team_id is None:
        return None
    points = _num(side.get("totalPoints"))
    return {"teamId": team_id, "points": points if points is not None else 0.0}


def _score_row(week: int, side: dict, opp: dict) -> dict:
    return {
        "week": week,
        "teamId": side["teamId"],
        "points": side["points"],
        "oppId": opp["teamId"],
        "result": _result(side["points"], opp["points"]),
    }


def _result(points: float, opp_points: float) -> str:
    if points > opp_points:
        return "W"
    if points < opp_points:
        return "L"
    return "T"


# ------------------------------------------------------------------------ transactions


def normalize_transactions(mtransactions_payload: Any) -> list[dict]:
    """Flatten an mTransactions2 payload into transaction rows.

    Each row is ``{id, type, status, teamId, bid, week, time, items}``. ``teamId`` resolves
    from a top-level ``teamId`` or a nested ``actions[].teamId`` (mirrors
    ``getTransactionTeamId`` in transactions.ts). ``items`` captures adds/drops/trades as
    ``{type, playerId, fromTeamId, toTeamId}``. ``week`` comes from ``scoringPeriodId``;
    ``time`` from ``processDate`` (falling back to ``proposedDate``), left as raw epoch ms.
    """
    rows: list[dict] = []
    if not isinstance(mtransactions_payload, dict):
        return rows
    txs = mtransactions_payload.get("transactions")
    if not isinstance(txs, list):
        return rows
    for tx in txs:
        if not isinstance(tx, dict):
            continue
        time = _int(tx.get("processDate"))
        if time is None:
            time = _int(tx.get("proposedDate"))
        rows.append(
            {
                "id": _tx_id(tx),
                "type": _str_or_none(tx.get("type")),
                "status": _str_or_none(tx.get("status")),
                "teamId": _transaction_team_id(tx),
                "bid": _int(tx.get("bidAmount")),
                "week": _int(tx.get("scoringPeriodId")),
                "time": time,
                "items": _tx_items(tx.get("items")),
            }
        )
    return rows


def _tx_id(tx: dict) -> Any:
    """The transaction id, preserving its raw str/int type (or None)."""
    tid = tx.get("id")
    return tid if isinstance(tid, (str, int)) else None


def _transaction_team_id(tx: dict) -> Optional[int]:
    """Team id from a top-level `teamId`, else the first `actions[].teamId` found.

    ESPN nests actions as objects or arrays-of-objects, so both are searched (mirrors
    getTransactionTeamId in transactions.ts).
    """
    direct = _int(tx.get("teamId"))
    if direct is not None:
        return direct
    actions = tx.get("actions")
    if not isinstance(actions, list):
        return None
    for action in actions:
        if isinstance(action, dict):
            tid = _int(action.get("teamId"))
            if tid is not None:
                return tid
        elif isinstance(action, list):
            for part in action:
                if isinstance(part, dict):
                    tid = _int(part.get("teamId"))
                    if tid is not None:
                        return tid
    return None


def _tx_items(items: Any) -> list[dict]:
    """Adds/drops/trades as {type, playerId, fromTeamId, toTeamId}."""
    out: list[dict] = []
    if not isinstance(items, list):
        return out
    for item in items:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "type": _str_or_none(item.get("type")),
                "playerId": _int(item.get("playerId")),
                "fromTeamId": _int(item.get("fromTeamId")),
                "toTeamId": _int(item.get("toTeamId")),
            }
        )
    return out


# ------------------------------------------------------------------ partition + storage


def group_rows_by_week(rows: list[dict], *, default_week: int = 0) -> dict[int, list[dict]]:
    """Bucket rows by their ``week`` field for per-(season, week) partition writes.

    Rows with a missing/None week fall into ``default_week`` (0) so nothing is dropped.
    """
    grouped: dict[int, list[dict]] = {}
    for row in rows:
        week = row.get("week")
        week = week if isinstance(week, int) else default_week
        grouped.setdefault(week, []).append(row)
    return grouped


def table_path(root: str, season: int, table: str, week: Optional[int] = None) -> Path:
    """Deterministic path for a (season, table[, week]) partition."""
    base = Path(root) / f"season={season}"
    if week is not None:
        base = base / f"week={week}"
    return base / f"{table}.json"


def write_table(
    root: str,
    season: int,
    table: str,
    rows: list[dict],
    *,
    as_of: str,
    week: Optional[int] = None,
) -> Path:
    """Atomically write a derived-table partition, overwriting any prior one.

    The file is an envelope carrying ``as_of`` (the audit grain -- a re-run overwrites the
    whole partition) plus ``season``/``week``/``table``/``row_count`` so reads are
    self-describing. The temp-file + ``os.replace`` write means a crashed task never leaves a
    half-written table for the storylines step to choke on.
    """
    envelope = {
        "table": table,
        "season": season,
        "week": week,
        "as_of": as_of,
        "row_count": len(rows),
        "rows": rows,
    }
    path = table_path(root, season, table, week)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(envelope, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)  # atomic on POSIX and Windows for same-filesystem renames
    return path


def read_table(root: str, season: int, table: str, week: Optional[int] = None) -> dict:
    """Read a derived-table partition back as its envelope dict."""
    return json.loads(table_path(root, season, table, week).read_text(encoding="utf-8"))
