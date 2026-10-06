"""Build one week's briefing from ESPN + nflverse payloads.

Pure functions except `build`, which takes a `sources` module (or a stub with the same
functions) so tests never touch the network.
"""

import re
from collections import defaultdict
from datetime import UTC, datetime

NFLVERSE_TO_ESPN = {"LA": "LAR", "WAS": "WSH"}  # nflverse abbreviations that differ from ESPN's

UNITS = {
    "QB": "QB",
    "T": "OL", "OT": "OL", "G": "OL", "OG": "OL", "C": "OL", "OL": "OL",
    "WR": "Skill", "TE": "Skill", "RB": "Skill", "FB": "Skill",
    "DE": "DL", "DT": "DL", "NT": "DL", "DL": "DL",
    "LB": "LB", "ILB": "LB", "OLB": "LB",
    "CB": "DB", "S": "DB", "SS": "DB", "FS": "DB", "DB": "DB",
    "K": "ST", "P": "ST", "LS": "ST", "PK": "ST",
}  # fmt: skip
OUT_STATUSES = {"Out", "Injured Reserve", "Doubtful", "Suspension", "Physically Unable to Perform", "Reserve"}
STARTER_SNAP = 0.60  # best-3-games snap share that counts as a starter

INDOOR = {
    "AT&T Stadium", "Caesars Superdome", "Ford Field", "Lucas Oil Stadium", "U.S. Bank Stadium",
    "Mercedes-Benz Stadium", "Allegiant Stadium", "SoFi Stadium", "State Farm Stadium", "NRG Stadium",
}  # fmt: skip


def norm_name(name: str) -> str:
    name = re.sub(r"[^a-z ]", "", name.lower().replace("-", " "))
    return " ".join(w for w in name.split() if w not in {"jr", "sr", "ii", "iii", "iv", "v"})


def implied(ml) -> float:
    ml = float(ml)
    return -ml / (-ml + 100) if ml < 0 else 100 / (ml + 100)


def no_vig(away_ml, home_ml) -> float | None:
    """Home win probability with the bookmaker margin removed."""
    try:
        a, h = implied(away_ml), implied(home_ml)
    except (TypeError, ValueError):
        return None
    return h / (a + h)


# ---------- snap share ----------


def index_snaps(rows: list[dict]):
    """-> (team -> set of weeks played, (team, name) -> {week: max(off, def) snap pct})."""
    team_weeks = defaultdict(set)
    player_weeks = defaultdict(dict)
    for r in rows:
        if r["game_type"] != "REG":
            continue
        team = NFLVERSE_TO_ESPN.get(r["team"], r["team"])
        wk = int(r["week"])
        team_weeks[team].add(wk)
        pct = max(float(r["offense_pct"] or 0), float(r["defense_pct"] or 0))
        player_weeks[(team, norm_name(r["player"]))][wk] = pct
    return team_weeks, player_weeks


def snap_profile(team: str, name: str, snaps) -> dict | None:
    team_weeks, player_weeks = snaps
    weeks = sorted(team_weeks.get(team, []))
    if not weeks:
        return None
    pw = player_weeks.get((team, norm_name(name)))
    if pw is None:
        return {"avg": 0.0, "peak": 0.0, "last": 0.0, "missed": 0}
    recent = weeks[-3:]
    # A player hurt earlier in the season still counts as a starter: use their best
    # 3 games actually played, not zeros from games missed.
    best = sorted((pw[w] for w in weeks if pw.get(w, 0) > 0), reverse=True)[:3]
    missed = 0
    for w in reversed(weeks):
        if pw.get(w, 0) > 0:
            break
        missed += 1
    return {
        "avg": round(sum(pw.get(w, 0) for w in recent) / len(recent), 2),
        "peak": round(sum(best) / len(best), 2) if best else 0.0,
        "last": round(pw.get(weeks[-1], 0), 2),
        "missed": missed,
    }


def index_practice(rows: list[dict], week: int) -> dict:
    out = {}
    for r in rows:
        if r["season_type"] == "REG" and int(r["week"]) == week:
            team = NFLVERSE_TO_ESPN.get(r["team"], r["team"])
            out[(team, norm_name(r["full_name"]))] = r["practice_status"]
    return out


# ---------- per-team block ----------


def team_block(comp_team: dict, summary: dict, game_date: datetime, season: int, snaps, practice) -> dict:
    team = comp_team["team"]
    abbr, tid = team["abbreviation"], team["id"]
    record = next((r["summary"] for r in comp_team.get("records", []) if r.get("type") == "total"), "")

    point_diff = None
    for grp in summary.get("standings", {}).get("groups", []):
        for e in grp.get("standings", {}).get("entries", []):
            if e.get("id") == tid:
                stats = {s["name"]: s.get("value") for s in e.get("stats", [])}
                if stats.get("pointsFor") is not None:
                    point_diff = int(stats["pointsFor"] - stats["pointsAgainst"])

    results, last_date = [], None
    for blk in summary.get("lastFiveGames", []):
        if blk["team"]["id"] != tid:
            continue
        for ev in blk.get("events", []):
            if ev["gameDate"] < f"{season}-09-01":  # skip preseason
                continue
            results.append(
                {
                    "wk": ev.get("week"),
                    "res": ev.get("gameResult"),
                    "score": ev.get("score"),
                    "opp": ev["opponent"]["abbreviation"],
                    "at": ev.get("atVs"),
                }
            )
            d = datetime.fromisoformat(ev["gameDate"])
            last_date = max(last_date, d) if last_date else d
    results.sort(key=lambda r: r["wk"] or 0)

    injuries = []
    for blk in summary.get("injuries", []):
        if blk["team"]["id"] != tid:
            continue
        for inj in blk.get("injuries", []):
            ath = inj["athlete"]
            pos = ath.get("position", {}).get("abbreviation", "")
            prof = snap_profile(abbr, ath["displayName"], snaps)
            status = inj.get("status", "")
            det = inj.get("details", {}) or {}
            injuries.append(
                {
                    "name": ath["displayName"],
                    "pos": pos,
                    "unit": UNITS.get(pos, "Other"),
                    "status": status,
                    "out": status in OUT_STATUSES,
                    "q": status == "Questionable",
                    "injury": " ".join(
                        x for x in (det.get("type"), det.get("detail")) if x and x != "Not Specified"
                    ),
                    "return": det.get("returnDate"),
                    "snap": prof["avg"] if prof else None,
                    "peak": prof["peak"] if prof else None,
                    "played_last": bool(prof and prof["last"] > 0),
                    "missed": prof["missed"] if prof else None,
                    "starter": bool(prof and max(prof["avg"], prof["peak"]) >= STARTER_SNAP),
                    "practice": practice.get((abbr, norm_name(ath["displayName"]))),
                }
            )
    injuries.sort(key=lambda i: (not i["starter"], not i["out"], i["unit"]))
    return {
        "abbr": abbr,
        "name": team["displayName"],
        "record": record,
        "pd": point_diff,
        "results": results,
        "rest": (game_date - last_date).days if last_date else None,
        "injuries": injuries,
    }


# ---------- flags ----------


def favorite(market: float | None) -> str:
    return "home" if (market if market is not None else 0.5) >= 0.5 else "away"


def flags_for(g: dict) -> list[dict]:
    """Everything that might make the market favorite a bad pick. Each flag has a `kind` so the
    season grader can measure how often that kind of flag was right."""
    f = []

    def add(kind, side, sev, text):
        f.append({"kind": kind, "side": side, "sev": sev, "text": text})

    for side in ("away", "home"):
        t = g[side]
        lost = defaultdict(list)
        for i in t["injuries"]:
            if i["starter"] and (i["out"] or i["q"]):
                lost[i["unit"]].append(i)
        for i in lost.get("QB", []):
            when = (
                "new this week"
                if i["played_last"]
                else f"has missed {i['missed']} game(s)"
                if i["missed"]
                else ""
            )
            add(
                "qb",
                side,
                "high" if i["played_last"] or i["q"] else "med",
                f"{t['abbr']} QB {i['name']} {i['status'].lower()}" + (f" ({when})" if when else ""),
            )
        ol_out = [i for i in lost.get("OL", []) if i["out"]]
        ol_q = [i for i in lost.get("OL", []) if i["q"]]
        if len(ol_out) >= 2 or (ol_out and ol_q):
            fresh = sum(1 for i in ol_out if i["played_last"])
            add(
                "ol",
                side,
                "high" if len(ol_out) >= 2 and fresh else "med",
                f"{t['abbr']} O-line: {len(ol_out)} starter(s) out"
                + (f", {len(ol_q)} questionable" if ol_q else "")
                + (f" ({fresh} new this week)" if fresh else " (all multi-week, likely priced in)"),
            )
        new_out = [
            i for i in t["injuries"] if i["starter"] and i["out"] and i["played_last"] and i["unit"] != "QB"
        ]
        if len(new_out) >= 2:
            add(
                "new_starters",
                side,
                "med",
                f"{t['abbr']} lost {len(new_out)} starters who played last week: "
                + ", ".join(f"{i['name']} ({i['pos']})" for i in new_out[:4]),
            )
        for unit, label in (("DB", "DBs"), ("DL", "D-linemen"), ("Skill", "skill players")):
            n = len([i for i in lost.get(unit, []) if i["out"]])
            if n >= 2:
                add("unit", side, "med", f"{t['abbr']} missing {n} starting {label}")

    m, mo, fpi = g["market"], g["market_open"], g["fpi"]
    if m is not None and mo is not None:
        move = m - mo
        if abs(move) >= 0.05:
            side = "home" if move > 0 else "away"
            add(
                "move",
                side,
                "med",
                f"Line moved {abs(move) * 100:.0f} pts toward {g[side]['abbr']} since open",
            )
        if (mo - 0.5) * (m - 0.5) < 0:
            add("flip", favorite(m), "high", "Favorite flipped since the line opened")
    if m is not None and fpi is not None and abs(fpi - m) >= 0.08:
        side = "home" if fpi > m else "away"
        add(
            "fpi",
            side,
            "med",
            f"ESPN FPI likes {g[side]['abbr']} {abs(fpi - m) * 100:.0f} pts more than the market",
        )
    ra, rh = g["away"]["rest"], g["home"]["rest"]
    if ra is not None and rh is not None and abs(ra - rh) >= 3:
        side = "away" if ra > rh else "home"
        add("rest", side, "low", f"Rest edge {g[side]['abbr']}: {max(ra, rh)} days vs {min(ra, rh)}")
    w = g.get("weather") or {}
    if not g["indoor"] and ((w.get("gust") or 0) >= 20 or (w.get("precipitation") or 0) >= 50):
        add("weather", "both", "low", f"Weather: gusts {w.get('gust')} mph, {w.get('precipitation')}% precip")
    if g["neutral"]:
        add("neutral", "both", "low", "Neutral site, no real home field")

    # Does this flag argue for the underdog? Injury flags hurt the side they name; market and
    # model flags favor the side they name.
    fav = favorite(m)
    dog = "away" if fav == "home" else "home"
    for x in f:
        if x["kind"] in ("qb", "ol", "new_starters", "unit"):
            x["vs_fav"] = x["side"] == fav
        elif x["kind"] in ("move", "fpi", "rest"):
            x["vs_fav"] = x["side"] == dog
        else:
            x["vs_fav"] = False
    order = {"high": 0, "med": 1, "low": 2}
    f.sort(key=lambda x: order[x["sev"]])
    return f


# ---------- game + week ----------


def game_block(ev: dict, summary: dict, season: int, snaps, practice) -> dict:
    comp = ev["competitions"][0]
    gdate = datetime.fromisoformat(ev["date"])
    teams = {c["homeAway"]: c for c in comp["competitors"]}
    pc = (summary.get("pickcenter") or [{}])[0]
    ml, sp = pc.get("moneyline", {}), pc.get("pointSpread", {})

    def line(block, side, when, key="odds"):
        return ((block.get(side) or {}).get(when) or {}).get(key)

    fpi = None
    try:
        fpi = float(summary["predictor"]["homeTeam"]["gameProjection"]) / 100
    except (KeyError, TypeError, ValueError):
        pass
    venue = summary.get("gameInfo", {}).get("venue", {})
    winner = None
    if ev["status"]["type"]["state"] == "post":
        winner = next((s for s, c in teams.items() if c.get("winner")), "tie")
    g = {
        "id": ev["id"],
        "kickoff": ev["date"],
        "status": ev["status"]["type"]["state"],
        "winner": winner,
        "score": {s: teams[s].get("score") for s in ("away", "home")},
        "away": team_block(teams["away"], summary, gdate, season, snaps, practice),
        "home": team_block(teams["home"], summary, gdate, season, snaps, practice),
        "market": no_vig(line(ml, "away", "close"), line(ml, "home", "close")),
        "market_open": no_vig(line(ml, "away", "open"), line(ml, "home", "open")),
        "fpi": fpi,
        "spread": pc.get("details"),
        "total": pc.get("overUnder"),
        "ml": {s: {w: line(ml, s, w) for w in ("open", "close")} for s in ("away", "home")},
        "spread_line": {w: line(sp, "home", w, "line") for w in ("open", "close")},
        "venue": venue.get("fullName"),
        "indoor": bool(venue.get("indoor")) or venue.get("fullName", "") in INDOOR,
        "neutral": comp.get("neutralSite", False),
        "weather": summary.get("gameInfo", {}).get("weather"),
        "link": f"https://www.espn.com/nfl/game/_/gameId/{ev['id']}",
    }
    if g["weather"]:
        g["weather"] = {k: g["weather"].get(k) for k in ("temperature", "gust", "precipitation")}
    g["flags"] = flags_for(g)
    return g


def finals(sb: dict, season: int, week: int) -> dict:
    """Just ids, teams and winners from a scoreboard: enough to grade without 16 summary calls."""
    games = []
    for ev in sb["events"]:
        teams = {c["homeAway"]: c for c in ev["competitions"][0]["competitors"]}
        winner = None
        if ev["status"]["type"]["state"] == "post":
            winner = next((s for s, c in teams.items() if c.get("winner")), "tie")
        games.append(
            {
                "id": ev["id"],
                "kickoff": ev["date"],
                "winner": winner,
                "score": {s: teams[s].get("score") for s in ("away", "home")},
                "away": {"abbr": teams["away"]["team"]["abbreviation"]},
                "home": {"abbr": teams["home"]["team"]["abbreviation"]},
            }
        )
    return {"season": season, "week": week, "games": games}


def current_week(sources, season: int) -> int:
    """The week to brief: ESPN's current week, or the next one once every game is final."""
    sb = sources.scoreboard(season)
    week = sb["week"]["number"]
    if all(e["status"]["type"]["state"] == "post" for e in sb["events"]):
        week += 1
    return week


def build(sources, season: int, week: int, now: datetime | None = None) -> dict:
    sb = sources.scoreboard(season, week)
    snaps = index_snaps(sources.nflverse_csv("snap_counts", season))
    practice = index_practice(sources.nflverse_csv("injuries", season), week)
    games = [game_block(ev, sources.summary(ev["id"]), season, snaps, practice) for ev in sb["events"]]
    games.sort(key=lambda g: g["kickoff"])
    return {
        "season": season,
        "week": week,
        "generated": (now or datetime.now(UTC)).isoformat(timespec="minutes"),
        "practice_available": bool(practice),
        "games": games,
    }
