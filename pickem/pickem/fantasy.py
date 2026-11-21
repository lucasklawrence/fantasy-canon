"""Your ESPN fantasy teams: standings, this week's matchup, and lineup problems.

Private leagues need the `espn_s2` and `SWID` cookies. Leagues come from PICKEM_LEAGUES as
`leagueId:teamId,leagueId:teamId`. All three are secrets because this repo is public: nothing
from here is committed, and CI prints only counts.
"""

import json
import os
import urllib.request
from datetime import datetime

LM = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{league}"
SLOTS = {0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "D/ST", 17: "K", 20: "Bench", 21: "IR", 23: "FLEX"}
BENCH = {20, 21}
OUT = {"OUT", "INJURY_RESERVE", "SUSPENSION", "DOUBTFUL"}
POSITIONS = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST"}
# ESPN fantasy proTeamId == ESPN site team id
PRO_TEAMS = {
    1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN",
    11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG",
    20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WSH",
    29: "CAR", 30: "JAX", 33: "BAL", 34: "HOU",
}  # fmt: skip


def leagues_from_env(env=os.environ) -> list[tuple[str, int]]:
    out = []
    for part in (env.get("PICKEM_LEAGUES") or "").split(","):
        if ":" in part:
            lid, tid = part.strip().split(":", 1)
            out.append((lid, int(tid)))
    return out


def credentials(env=os.environ) -> tuple[str, str] | None:
    s2, swid = env.get("ESPN_S2"), env.get("ESPN_SWID")
    return (s2, swid) if s2 and swid else None


def fetch_league(season: int, league_id: str, week: int, creds: tuple[str, str]) -> dict:
    views = "&".join(f"view={v}" for v in ("mTeam", "mRoster", "mMatchupScore", "mSettings", "mStatus"))
    url = LM.format(season=season, league=league_id) + f"?{views}&scoringPeriodId={week}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "fantasy-canon-pickem/0.1",
            "Cookie": f"espn_s2={creds[0]}; SWID={creds[1]}",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def _stat(player: dict, week: int, source: int) -> float | None:
    for s in player.get("stats") or []:
        same = s.get("scoringPeriodId") == week and s.get("statSourceId") == source
        # actuals come in several splits; the weekly total is split type 1
        if same and (source == 1 or s.get("statSplitTypeId") == 1):
            return round(s.get("appliedTotal", 0.0), 1)
    return None


def _player(entry: dict, week: int, kickoffs: dict, now: datetime) -> dict:
    p = entry["playerPoolEntry"]["player"]
    status = p.get("injuryStatus") or "ACTIVE"
    kick = kickoffs.get(str(p.get("proTeamId")))
    return {
        "id": p["id"],
        "name": p["fullName"],
        "pos": POSITIONS.get(p.get("defaultPositionId"), "?"),
        "team": PRO_TEAMS.get(p.get("proTeamId")),
        "slot": entry["lineupSlotId"],
        "slot_name": SLOTS.get(entry["lineupSlotId"], str(entry["lineupSlotId"])),
        "eligible": [s for s in p.get("eligibleSlots", []) if s in SLOTS and s not in BENCH],
        "status": status,
        "proj": _stat(p, week, 1),
        "actual": _stat(p, week, 0),
        "kickoff": kick,
        "locked": bool(kick and datetime.fromisoformat(kick) <= now),
        "bye": kick is None,
    }


def lineup_issues(roster: list[dict]) -> list[dict]:
    """Starters who won't play or are at risk, and bench players clearly better than a starter."""
    issues = []
    starters = [p for p in roster if p["slot"] not in BENCH]
    bench = [p for p in roster if p["slot"] == 20 and p["status"] not in OUT and not p["bye"]]
    for s in starters:
        if s["locked"]:
            continue
        if s["bye"]:
            issues.append(
                {"sev": "high", "player": s["name"], "text": f"{s['name']} ({s['slot_name']}) is on bye"}
            )
        elif s["status"] in OUT:
            label = s["status"].replace("_", " ").lower()
            issues.append(
                {"sev": "high", "player": s["name"], "text": f"{s['name']} ({s['slot_name']}) is {label}"}
            )
        elif s["status"] == "QUESTIONABLE":
            issues.append(
                {"sev": "med", "player": s["name"], "text": f"{s['name']} ({s['slot_name']}) is questionable"}
            )
    for s in starters:
        if s["locked"]:
            continue
        sp = 0 if (s["bye"] or s["status"] in OUT) else (s["proj"] or 0)
        better = [
            b for b in bench if s["slot"] in b["eligible"] and not b["locked"] and (b["proj"] or 0) >= sp + 3
        ]
        if better:
            b = max(better, key=lambda x: x["proj"] or 0)
            issues.append(
                {
                    "sev": "med" if sp else "high",
                    "player": s["name"],
                    "text": f"Bench {b['name']} ({b['proj']}) projects above {s['name']} ({sp}) at {s['slot_name']}",
                }
            )
    return issues


def summarize(league: dict, team_id: int, week: int, kickoffs: dict, now: datetime) -> dict:
    teams = {t["id"]: t for t in league["teams"]}
    me = teams[team_id]

    def tname(t):
        return t.get("name") or f"{t.get('location', '')} {t.get('nickname', '')}".strip()

    def rec(t):
        o = t["record"]["overall"]
        return f"{o['wins']}-{o['losses']}" + (f"-{o['ties']}" if o.get("ties") else "")

    def roster(t):
        return [_player(e, week, kickoffs, now) for e in t.get("roster", {}).get("entries", [])]

    def proj_total(r):
        return round(sum(p["proj"] or 0 for p in r if p["slot"] not in BENCH and not p["bye"]), 1)

    period = league.get("status", {}).get("currentMatchupPeriod", week)
    mine = [
        m
        for m in league.get("schedule", [])
        if team_id in (m.get("home", {}).get("teamId"), m.get("away", {}).get("teamId"))
    ]
    this = next((m for m in mine if m["matchupPeriodId"] == period), None)
    last = next((m for m in mine if m["matchupPeriodId"] == period - 1), None)

    def side(m, tid):
        return ("home", "away") if m["home"]["teamId"] == tid else ("away", "home")

    my_roster = roster(me)
    matchup = None
    if this and this.get("away"):
        us, them = side(this, team_id)
        opp = teams[this[them]["teamId"]]
        opp_roster = roster(opp)
        matchup = {
            "opp": tname(opp),
            "opp_record": rec(opp),
            # ESPN's own matchup projection when it has one, else the sum of starters' projections
            "proj": round(
                this[us].get("totalProjectedPointsLive")
                or this[us].get("totalProjectedPoints")
                or proj_total(my_roster),
                1,
            ),
            "opp_proj": round(
                this[them].get("totalProjectedPointsLive")
                or this[them].get("totalProjectedPoints")
                or proj_total(opp_roster),
                1,
            ),
            "win_prob": None
            if this[us].get("winProbability") is None
            else round(this[us]["winProbability"] * 100),
            "score": this[us].get("totalPointsLive", this[us].get("totalPoints")),
            "opp_score": this[them].get("totalPointsLive", this[them].get("totalPoints")),
        }
    last_result = None
    if last and last.get("away"):
        us, them = side(last, team_id)
        last_result = {
            "opp": tname(teams[last[them]["teamId"]]),
            "score": last[us].get("totalPoints"),
            "opp_score": last[them].get("totalPoints"),
            "won": last.get("winner", "").lower() == us,
        }
    standings = sorted(league["teams"], key=lambda t: t.get("playoffSeed") or 99)
    budget = (league.get("settings", {}).get("acquisitionSettings") or {}).get("acquisitionBudget")
    faab = None
    if budget:
        faab = sorted(
            (
                {
                    "team": tname(t),
                    "left": budget - ((t.get("transactionCounter") or {}).get("acquisitionBudgetSpent") or 0),
                    "me": t["id"] == team_id,
                }
                for t in league["teams"]
            ),
            key=lambda x: -x["left"],
        )
    return {
        "league_id": str(league.get("id")),
        "league": (league.get("settings", {}).get("name") or "").strip(),
        "size": len(league["teams"]),
        "playoff_spots": league.get("settings", {}).get("scheduleSettings", {}).get("playoffTeamCount"),
        "team": tname(me),
        "record": rec(me),
        "seed": me.get("playoffSeed"),
        "pf": round(me["record"]["overall"]["pointsFor"], 1),
        "pa": round(me["record"]["overall"]["pointsAgainst"], 1),
        "pf_rank": 1
        + sum(
            1
            for t in league["teams"]
            if t["record"]["overall"]["pointsFor"] > me["record"]["overall"]["pointsFor"]
        ),
        "week": period,
        "matchup": matchup,
        "last": last_result,
        "roster": my_roster,
        "issues": lineup_issues(my_roster),
        "faab": faab,
        "standings": [
            {"team": tname(t), "record": rec(t), "seed": t.get("playoffSeed"), "me": t["id"] == team_id}
            for t in standings
        ],
    }


def kickoffs_by_team(scoreboard: dict) -> dict:
    """ESPN fantasy proTeamId equals the ESPN site team id, so map it straight to kickoff time."""
    out = {}
    for ev in scoreboard.get("events", []):
        for c in ev["competitions"][0]["competitors"]:
            out[str(c["team"]["id"])] = ev["date"]
    return out


def my_teams(
    season: int, week: int, scoreboard: dict, now: datetime, env=os.environ, fetch=fetch_league
) -> list[dict]:
    creds = credentials(env)
    if not creds:
        return []
    kicks = kickoffs_by_team(scoreboard)
    return [
        summarize(fetch(season, lid, week, creds), tid, week, kicks, now)
        for lid, tid in leagues_from_env(env)
    ]
