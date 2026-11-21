"""Weekly projection log: ESPN's projection beside ours for every fantasy-relevant player.

Nothing here touches a private league. ESPN's PPR projections come from its public player pool,
actual points from nflverse, so the whole log is committed and anyone can re-check it:

1. Before each kickoff window the schedule writes `history/<season>/wNN/projections.json`. A
   player's row is frozen once his game kicks off, so the committed file holds the last pregame
   numbers. Git commit times prove when each row was written (`python -m pickem verify`).
2. Once nflverse publishes the week's stats, `projection_results.json` scores ESPN, the usage
   model, a 50/50 blend, and a naive last-four-games average against actual PPR points.

Rows marked `"backtest": true` were rebuilt after the fact (ESPN's stored projection for the
week, usage from earlier weeks only). They're scored, but they aren't proof of anything.
"""

import json
from datetime import datetime
from pathlib import Path

from . import usage
from .briefing import norm_name
from .fantasy import POSITIONS, PRO_TEAMS
from .history import HISTORY, week_dir

ESPN_POOL = (
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/"
    "leaguedefaults/3?scoringPeriodId={week}&view=kona_player_info"
)  # leaguedefaults/3 = standard PPR scoring
POOL_SIZE = 300  # most-rostered QB/RB/WR/TE; covers every startable player in a 12-team league
OUT = {"OUT", "INJURY_RESERVE", "SUSPENSION"}
DISAGREE = 3.0  # points apart before a disagreement counts in the head-to-head
# Declared 2026-10-07, after the weeks 2-4 backtest and before any live week: 70% ESPN + 30% usage.
# It edged ESPN there (5.36 vs 5.41 points), too little to trust until live weeks agree.
LEAN = 0.7


def pool_filter(season: int, week: int, limit: int = POOL_SIZE) -> dict:
    return {
        "players": {
            "filterSlotIds": {"value": [0, 2, 4, 6]},
            "limit": limit,
            "sortPercOwned": {"sortPriority": 1, "sortAsc": False},
            "filterStatsForTopScoringPeriodIds": {"value": 1, "additionalValue": [f"11{season}{week}"]},
        }
    }


def parse_pool(payload: dict, week: int) -> list[dict]:
    """ESPN kona_player_info -> [{id, name, team, pos, status, espn}] for one week."""
    rows = []
    for entry in payload.get("players", []):
        p = entry.get("player", entry)
        proj = next(
            (
                s.get("appliedTotal", 0.0)
                for s in p.get("stats") or []
                if s.get("scoringPeriodId") == week and s.get("statSourceId") == 1
            ),
            None,
        )
        pos, team = POSITIONS.get(p.get("defaultPositionId")), PRO_TEAMS.get(p.get("proTeamId"))
        if proj is None or pos not in ("QB", "RB", "WR", "TE") or not team:
            continue
        rows.append(
            {
                "id": p["id"],
                "name": p["fullName"],
                "team": team,
                "pos": pos,
                "status": p.get("injuryStatus") or "ACTIVE",
                "espn": round(proj, 1),
            }
        )
    return rows


def stats_before(rows: list[dict], week: int) -> list[dict]:
    """Only the weeks a projection made before `week` could have seen."""
    return [r for r in rows if int(r["week"]) < week]


def build_week(
    pool: list[dict],
    stat_rows: list[dict],
    implied: dict,
    kickoffs: dict,
    season: int,
    week: int,
    now: datetime,
    prev: dict | None = None,
    backtest: bool = False,
) -> dict:
    """One week's log. Rows for games already started are carried over from `prev` unchanged."""
    stats = usage.index_stats(stats_before(stat_rows, week))
    frozen = {}
    if prev:
        for r in prev["players"]:
            if r.get("kickoff") and datetime.fromisoformat(r["kickoff"]) <= now:
                frozen[r["id"]] = r
    players = list(frozen.values())
    for p in pool:
        kick = kickoffs.get(p["team"])
        if p["id"] in frozen or kick is None:  # locked, or on bye
            continue
        if not backtest and datetime.fromisoformat(kick) <= now:
            continue  # started before we logged it: never write a "pregame" row after kickoff
        u = usage.profile(p["name"], p["team"], p["pos"], stats, implied)
        mine = None if u is None else (0.0 if p["status"] in OUT else u["proj"])
        players.append(
            {
                **p,
                "kickoff": kick,
                "usage": mine,
                "avg": u["ppr_avg"] if u else None,
                "targets": u["targets"] if u else None,
                "carries": u["carries"] if u else None,
                "implied": implied.get(p["team"]),
                **({"backtest": True} if backtest else {}),
            }
        )
    players.sort(key=lambda r: (r["kickoff"], r["team"], -(r["espn"] or 0)))
    return {
        "season": season,
        "week": week,
        "generated": now.isoformat(timespec="minutes"),
        "players": players,
    }


def path_for(season: int, week: int, name: str, base: Path = HISTORY) -> Path:
    return week_dir(season, week, base) / name


def load(season: int, week: int, name: str = "projections.json", base: Path = HISTORY) -> dict | None:
    p = path_for(season, week, name, base)
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def save(data: dict, name: str = "projections.json", base: Path = HISTORY) -> Path:
    p = path_for(data["season"], data["week"], name, base)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    return p


def actual_points(stat_rows: list[dict], week: int) -> dict:
    """(team, normalized name) -> PPR points for one week, from nflverse."""
    from .briefing import NFLVERSE_TO_ESPN

    out = {}
    for r in stat_rows:
        if int(r["week"]) == week and r.get("season_type") == "REG":
            team = NFLVERSE_TO_ESPN.get(r["team"], r["team"])
            out[(team, norm_name(r["player_display_name"]))] = float(r["fantasy_points_ppr"] or 0)
    return out


def _mae(pairs):
    return round(sum(abs(a - b) for a, b in pairs) / len(pairs), 2) if pairs else None


def grade(log: dict, stat_rows: list[dict]) -> dict | None:
    """Score a week's log. Only players who recorded a stat line count; None until stats exist."""
    actual = actual_points(stat_rows, log["week"])
    if not actual:
        return None
    scored = []
    for r in log["players"]:
        pts = actual.get((r["team"], norm_name(r["name"])))
        if pts is None or r["usage"] is None or r["espn"] <= 0:
            continue
        scored.append({"id": r["id"], "name": r["name"], "pos": r["pos"], "espn": r["espn"],
                       "usage": r["usage"], "avg": r["avg"], "actual": round(pts, 1)})  # fmt: skip
    return {
        "season": log["season"],
        "week": log["week"],
        "backtest": any(r.get("backtest") for r in log["players"]),
        "summary": summarize(scored),
        "by_pos": {
            pos: summarize([s for s in scored if s["pos"] == pos]) for pos in ("QB", "RB", "WR", "TE")
        },
        "players": scored,
    }


def summarize(scored: list[dict]) -> dict:
    """Mean absolute error for each method, plus how ESPN-vs-usage disagreements turned out.

    The direction counts answer the lineup question. When usage is 3+ lower than ESPN ("fade"),
    how often did the player finish under ESPN's number, against how often anyone does
    (`below_rate`)? Same for "boost" (usage 3+ higher, finished over ESPN's number).
    """
    pairs = lambda key: [(s[key], s["actual"]) for s in scored if s.get(key) is not None]
    split = [s for s in scored if abs(s["usage"] - s["espn"]) >= DISAGREE]
    fade = [s for s in split if s["usage"] < s["espn"]]
    boost = [s for s in split if s["usage"] > s["espn"]]
    return {
        "n": len(scored),
        "espn": _mae(pairs("espn")),
        "usage": _mae(pairs("usage")),
        "blend": _mae([((s["espn"] + s["usage"]) / 2, s["actual"]) for s in scored]),
        "lean": _mae([(LEAN * s["espn"] + (1 - LEAN) * s["usage"], s["actual"]) for s in scored]),
        "avg": _mae(pairs("avg")),
        "disagreements": len(split),
        "usage_closer": sum(1 for s in split if abs(s["usage"] - s["actual"]) < abs(s["espn"] - s["actual"])),
        "below_rate": round(sum(1 for s in scored if s["actual"] < s["espn"]) / len(scored), 3)
        if scored
        else None,
        "fade": len(fade),
        "fade_hit": sum(1 for s in fade if s["actual"] < s["espn"]),
        "boost": len(boost),
        "boost_hit": sum(1 for s in boost if s["actual"] > s["espn"]),
    }


def season(season_: int, base: Path = HISTORY) -> dict | None:
    """Every graded week, with backtest and live weeks pooled separately (only live ones prove anything)."""
    weeks, pooled = [], {"live": [], "backtest": []}
    for d in sorted((base / str(season_)).glob("w*")):
        res = load(season_, int(d.name[1:]), "projection_results.json", base)
        if not res:
            continue
        weeks.append({"week": res["week"], "backtest": res["backtest"], **res["summary"]})
        pooled["backtest" if res["backtest"] else "live"] += res["players"]
    if not weeks:
        return None
    return {"weeks": weeks, **{k: summarize(v) if v else None for k, v in pooled.items()}}


def kickoffs_by_abbr(scoreboard: dict) -> dict:
    """Team abbreviation -> kickoff. Teams on bye aren't in the scoreboard."""
    out = {}
    for ev in scoreboard.get("events", []):
        for c in ev["competitions"][0]["competitors"]:
            out[c["team"]["abbreviation"]] = ev["date"]
    return out


def closing_lines(scoreboard: dict, summary) -> dict:
    """Implied team totals for any week (past ones too) from ESPN's closing total and spread."""
    games = []
    for ev in scoreboard.get("events", []):
        pc = (summary(ev["id"]).get("pickcenter") or [{}])[0]
        teams = {c["homeAway"]: c["team"]["abbreviation"] for c in ev["competitions"][0]["competitors"]}
        home_line = ((pc.get("pointSpread") or {}).get("home") or {}).get("close", {}).get("line")
        games.append(
            {
                "total": pc.get("overUnder"),
                "spread_line": {"close": home_line},
                "home": {"abbr": teams["home"]},
                "away": {"abbr": teams["away"]},
            }
        )
    return usage.implied_totals({"games": games})
