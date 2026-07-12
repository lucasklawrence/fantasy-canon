"""Compute storyline metrics from the normalized derived tables (issue #16).

The **storylines** step of the pipeline (ESPN -> snapshots -> normalize -> **storylines**).
Pure functions turn the normalized derived tables (``teams`` / ``team_week_scores`` /
``transactions``) into flat rows for four storyline tables the bot/renderer can read:

    luck            (season-level)  <- team_week_scores      wins vs expected wins
    churn           (season-level)  <- transactions          roster moves per week
    waiver_spend    (per week)      <- transactions          FAAB spent per (week, team)
    rivalries       (season-level)  <- team_week_scores      head-to-head records

No ESPN calls here -- a clean dependency boundary: this reads only what ``normalize`` wrote and
writes storyline tables through the same partitioned, idempotent envelope store
(``write_table``), so a re-run overwrites a partition in place. Stdlib only, so the transforms
unit-test without Airflow or the network.

**Expected wins (luck).** The bot's ``expectedWins.ts`` estimates expected wins with a seeded
Monte Carlo (shuffle the league each week, pair adjacent). That is only reproducible bit-for-bit
by re-implementing its exact PRNG, and the pipeline's contract (issue #16: "match spot-checked
manual calculations") wants a value you can verify by hand. So we compute the *analytical*
all-play expectation -- ``allPlayWinPct * games`` -- which is the value that Monte Carlo
converges to (the test in ``expectedWins.test.ts`` asserts exactly this identity for full weeks)
and is deterministic. ``luck = actualWins - expectedWins``: positive is lucky, negative unlucky.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any, Optional

# --------------------------------------------------------------------------- coercion

# Kept local (rather than importing normalize's privates) so the transforms stay
# self-contained; identical semantics to the coercers in normalize.py.


def _num(val: Any) -> Optional[float]:
    """Coerce to a finite float, else None."""
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
    """A string value or ''."""
    return val if isinstance(val, str) else ""


# ------------------------------------------------------------------ read derived tables


def read_all_weeks(root: str, season: int, table: str) -> list[dict]:
    """Concatenate the rows of every ``week=`` partition of a per-week derived table.

    ``normalize`` writes weekly tables as ``season=<yyyy>/week=<n>/<table>.json``. Storyline
    metrics are season-wide, so they need all weeks at once; this globs the partitions, reads
    each envelope, and returns the rows in ascending week order. Missing season/table -> ``[]``.
    """
    season_dir = Path(root) / f"season={season}"
    if not season_dir.is_dir():
        return []
    partitions: list[tuple[int, list]] = []
    for week_dir in season_dir.glob("week=*"):
        try:
            week = int(week_dir.name.split("=", 1)[1])
        except (ValueError, IndexError):
            continue
        table_file = week_dir / f"{table}.json"
        if not table_file.is_file():
            continue
        rows = json.loads(table_file.read_text(encoding="utf-8")).get("rows")
        if isinstance(rows, list):
            partitions.append((week, rows))
    out: list[dict] = []
    for _, rows in sorted(partitions, key=lambda kv: kv[0]):
        out.extend(rows)
    return out


def season_week_count(scores: list[dict]) -> int:
    """The season length as the largest ``week`` seen in team_week_scores (0 if none).

    Uses max-week rather than a distinct-week count, matching the ``maxWeek`` convention the
    bot's faabPace uses, so "per week" denominators are the season length.
    """
    weeks = [w for w in (_int(r.get("week")) for r in scores) if w is not None]
    return max(weeks) if weeks else 0


# -------------------------------------------------------------------------------- luck


def compute_luck(scores: list[dict]) -> list[dict]:
    """Per-team luck: actual wins minus expected (all-play) wins, from team_week_scores.

    Reads ``{week, teamId, points, result}`` rows (two per matchup). The *actual* record comes
    from ``result`` (W/L/T). The *all-play* record compares each team's points to every other
    team that played the same week (ties count in the denominator, mirroring
    ``computeAllPlayRecord``). ``expectedWins = allPlayWinPct * games`` where ``games`` is the
    number of weeks the team played; ``luck = wins - expectedWins``. Ranked luckiest first.
    """
    by_week: dict[int, list[tuple[int, float]]] = {}
    actual: dict[int, dict[str, int]] = {}
    weeks_played: dict[int, set[int]] = {}
    for row in scores:
        team = _int(row.get("teamId"))
        week = _int(row.get("week"))
        if team is None or week is None:
            continue
        points = _num(row.get("points"))
        by_week.setdefault(week, []).append((team, points if points is not None else 0.0))
        rec = actual.setdefault(team, {"wins": 0, "losses": 0, "ties": 0})
        result = row.get("result")
        if result == "W":
            rec["wins"] += 1
        elif result == "L":
            rec["losses"] += 1
        elif result == "T":
            rec["ties"] += 1
        weeks_played.setdefault(team, set()).add(week)

    all_play: dict[int, dict[str, int]] = {}
    for entries in by_week.values():
        for i, (team_i, points_i) in enumerate(entries):
            rec = all_play.setdefault(team_i, {"wins": 0, "losses": 0, "ties": 0})
            for j, (_team_j, points_j) in enumerate(entries):
                if i == j:
                    continue
                if points_i > points_j:
                    rec["wins"] += 1
                elif points_i < points_j:
                    rec["losses"] += 1
                else:
                    rec["ties"] += 1

    rows: list[dict] = []
    for team in sorted(set(actual) | set(all_play)):
        a = actual.get(team, {"wins": 0, "losses": 0, "ties": 0})
        ap = all_play.get(team, {"wins": 0, "losses": 0, "ties": 0})
        ap_total = ap["wins"] + ap["losses"] + ap["ties"]
        win_pct = ap["wins"] / ap_total if ap_total > 0 else 0.0
        games = len(weeks_played.get(team, set()))
        expected = win_pct * games
        rows.append(
            {
                "teamId": team,
                "wins": a["wins"],
                "losses": a["losses"],
                "ties": a["ties"],
                "allPlayWins": ap["wins"],
                "allPlayLosses": ap["losses"],
                "allPlayTies": ap["ties"],
                "allPlayWinPct": round(win_pct, 6),
                "games": games,
                "expectedWins": round(expected, 6),
                "luck": round(a["wins"] - expected, 6),
            }
        )
    rows.sort(key=lambda r: (-r["luck"], r["teamId"]))
    return rows


# ------------------------------------------------------------------------------- churn


def compute_churn(transactions: list[dict], *, weeks: int) -> list[dict]:
    """Per-team roster churn from executed transactions.

    Item-level: a player added to a team (``toTeamId``) is an *add*, one removed (``fromTeamId``)
    a *drop*; ``moves = adds + drops`` and ``churnPerWeek = moves / weeks`` (the season length).
    A trade contributes to both teams' moves through its item ``from``/``to`` ids; ``trades`` is
    a separate tally of trade transactions the row's ``teamId`` was party to. Only *settled*
    transactions count (``status`` == ``EXECUTED`` or absent). There is no TS implementation to
    mirror -- the shape follows docs/02 ("churn = moves / weeks"). Ranked most-active first.
    """
    adds: dict[int, int] = {}
    drops: dict[int, int] = {}
    trades: dict[int, int] = {}
    for tx in transactions:
        status = tx.get("status")
        if status is not None and status != "EXECUTED":
            continue
        for item in tx.get("items") or []:
            if not isinstance(item, dict):
                continue
            to_team = _int(item.get("toTeamId"))
            from_team = _int(item.get("fromTeamId"))
            if to_team is not None:
                adds[to_team] = adds.get(to_team, 0) + 1
            if from_team is not None:
                drops[from_team] = drops.get(from_team, 0) + 1
        if "TRADE" in _str(tx.get("type")).upper():
            team = _int(tx.get("teamId"))
            if team is not None:
                trades[team] = trades.get(team, 0) + 1

    rows: list[dict] = []
    for team in sorted(set(adds) | set(drops) | set(trades)):
        a = adds.get(team, 0)
        d = drops.get(team, 0)
        moves = a + d
        rows.append(
            {
                "teamId": team,
                "adds": a,
                "drops": d,
                "trades": trades.get(team, 0),
                "moves": moves,
                "weeks": weeks,
                "churnPerWeek": round(moves / weeks, 6) if weeks > 0 else 0.0,
            }
        )
    rows.sort(key=lambda r: (-r["moves"], r["teamId"]))
    return rows


# ------------------------------------------------------------------------ waiver_spend

# The FAAB-spend gate, mirroring isWaiverSpend (apps/bot/src/lib/transactions.ts): a
# positive-bid, executed waiver claim. Non-waiver adds (free agents) and $0 claims don't count.
WAIVER_TYPES = frozenset({"WAIVER", "WAIVER_ERROR", "WAIVER_ADJUSTMENT"})


def is_waiver_spend(tx: dict) -> bool:
    """True for a positive-bid, executed waiver transaction (mirrors isWaiverSpend)."""
    bid = _num(tx.get("bid"))
    if bid is None or bid <= 0:
        return False
    if _str(tx.get("type")).upper() not in WAIVER_TYPES:
        return False
    status = tx.get("status")
    if status is not None and status != "EXECUTED":
        return False
    return True


def compute_waiver_spend_by_week(transactions: list[dict]) -> list[dict]:
    """Aggregate FAAB spend into ``{week, teamId, spend}`` rows, week then team order.

    Sums ``bid`` per (week, team) over waiver transactions that pass ``is_waiver_spend``. This is
    the "waiver spend per week" the storyline surfaces; the DAG writes one partition per week.
    """
    spend: dict[tuple[int, int], float] = {}
    for tx in transactions:
        if not is_waiver_spend(tx):
            continue
        week = _int(tx.get("week"))
        team = _int(tx.get("teamId"))
        if week is None or team is None:
            continue
        bid = _num(tx.get("bid")) or 0.0
        spend[(week, team)] = spend.get((week, team), 0.0) + bid
    rows = [
        {"week": week, "teamId": team, "spend": round(total, 2)}
        for (week, team), total in spend.items()
    ]
    rows.sort(key=lambda r: (r["week"], r["teamId"]))
    return rows


# --------------------------------------------------------------------------- rivalries


def compute_rivalries(scores: list[dict]) -> list[dict]:
    """Head-to-head rivalry records for every pairing, from team_week_scores.

    ``team_week_scores`` has two rows per matchup (one per side). For each unordered pair
    (``teamA`` = lower id, ``teamB`` = higher id) accumulate wins and points-for: the win is
    counted once from the teamA-side row's ``result`` (W -> aWins, L -> bWins, T -> neither), and
    each side's points come from its own row. Mirrors ``buildAllRivalries`` (rivalries.ts).
    Ranked most-lopsided first (by absolute win differential).
    """
    recs: dict[tuple[int, int], dict] = {}
    for row in scores:
        team = _int(row.get("teamId"))
        opp = _int(row.get("oppId"))
        if team is None or opp is None or team == opp:
            continue
        points = _num(row.get("points"))
        points = points if points is not None else 0.0
        team_a, team_b = (team, opp) if team < opp else (opp, team)
        rec = recs.setdefault(
            (team_a, team_b),
            {
                "teamA": team_a,
                "teamB": team_b,
                "aWins": 0,
                "bWins": 0,
                "aPoints": 0.0,
                "bPoints": 0.0,
            },
        )
        if team == team_a:
            rec["aPoints"] += points
            result = row.get("result")
            if result == "W":
                rec["aWins"] += 1
            elif result == "L":
                rec["bWins"] += 1
        else:
            rec["bPoints"] += points

    rows: list[dict] = []
    for rec in recs.values():
        rows.append(
            {
                "teamA": rec["teamA"],
                "teamB": rec["teamB"],
                "aWins": rec["aWins"],
                "bWins": rec["bWins"],
                "aPoints": round(rec["aPoints"], 2),
                "bPoints": round(rec["bPoints"], 2),
            }
        )
    rows.sort(key=lambda r: (-abs(r["aWins"] - r["bWins"]), r["teamA"], r["teamB"]))
    return rows
