"""Usage-based projections for your players, to set beside ESPN's.

The idea: opportunity (targets, carries, pass attempts) is far more stable week to week than
touchdowns, so project each player's opportunities from the last few games, multiply by their
points per opportunity pulled toward the position average (small samples are noisy), then
scale by how many points the betting market expects their team to score this week.

    projection = (expected targets x points per target + expected carries x points per carry
                  [+ expected attempts x points per attempt for QBs]) x team environment

It's a deliberately simple, transparent model. Its job is to disagree with ESPN in ways you can
explain ("his targets are down two weeks running"), and the season log scores both against
actual points so you can see which to trust.
"""

from collections import defaultdict

from .briefing import NFLVERSE_TO_ESPN, norm_name

WEIGHTS = [0.4, 0.3, 0.2, 0.1]  # most recent game first
PRIOR = {"tg": 25, "ca": 40, "att": 60}  # opportunities of league-average efficiency blended in
ENV_EXP = 0.7  # how strongly team scoring expectation scales a projection
GAP = 3.0  # points between ESPN and usage that's worth a flag


def _f(x) -> float:
    try:
        return float(x or 0)
    except ValueError:
        return 0.0


def _rec_pts(r):
    return _f(r["receptions"]) + 0.1 * _f(r["receiving_yards"]) + 6 * _f(r["receiving_tds"])


def _rush_pts(r):
    return 0.1 * _f(r["rushing_yards"]) + 6 * _f(r["rushing_tds"])


def _pass_pts(r):
    return 0.04 * _f(r["passing_yards"]) + 4 * _f(r["passing_tds"]) - 2 * _f(r["passing_interceptions"])


def index_stats(rows: list[dict]) -> dict:
    """-> {"players": {(team, name): [week rows, newest first]}, "means": per-position efficiency}."""
    players = defaultdict(list)
    tot = defaultdict(lambda: defaultdict(float))
    for r in rows:
        if r.get("season_type") != "REG":
            continue
        team = NFLVERSE_TO_ESPN.get(r["team"], r["team"])
        players[(team, norm_name(r["player_display_name"]))].append(r)
        pos = r["position"]
        t = tot[pos]
        t["tg"] += _f(r["targets"])
        t["rec"] += _rec_pts(r)
        t["ca"] += _f(r["carries"])
        t["rush"] += _rush_pts(r)
        t["att"] += _f(r["attempts"])
        t["pass"] += _pass_pts(r)
    for weeks in players.values():
        weeks.sort(key=lambda r: int(r["week"]), reverse=True)
    means = {
        pos: {
            "tg": t["rec"] / t["tg"] if t["tg"] else 1.6,
            "ca": t["rush"] / t["ca"] if t["ca"] else 0.6,
            "att": t["pass"] / t["att"] if t["att"] else 0.45,
        }
        for pos, t in tot.items()
    }
    return {"players": players, "means": means}


def _wavg(values: list[float]) -> float:
    w = WEIGHTS[: len(values)]
    return sum(v * x for v, x in zip(values, w, strict=False)) / sum(w) if w else 0.0


def implied_totals(briefing: dict) -> dict:
    """Team -> points the market expects it to score, from the game total and spread."""
    out = {}
    for g in briefing["games"]:
        total, line = g.get("total"), (g.get("spread_line") or {}).get("close")
        if total is None or line is None:
            continue
        home = float(total) / 2 - float(line) / 2  # home line is negative when home is favored
        out[g["home"]["abbr"]] = round(home, 1)
        out[g["away"]["abbr"]] = round(float(total) - home, 1)
    return out


def profile(name: str, team: str, pos: str, stats: dict, implied: dict, snaps=None) -> dict | None:
    weeks = stats["players"].get((team, norm_name(name)))
    if not weeks:
        return None
    recent = weeks[:4]
    means = stats["means"].get(pos, {"tg": 1.6, "ca": 0.6, "att": 0.45})

    def eff(kind, pts_fn):
        opp = sum(_f(r[{"tg": "targets", "ca": "carries", "att": "attempts"}[kind]]) for r in weeks)
        pts = sum(pts_fn(r) for r in weeks)
        return (pts + PRIOR[kind] * means[kind]) / (opp + PRIOR[kind])

    tg = _wavg([_f(r["targets"]) for r in recent])
    ca = _wavg([_f(r["carries"]) for r in recent])
    att = _wavg([_f(r["attempts"]) for r in recent]) if pos == "QB" else 0.0
    base = tg * eff("tg", _rec_pts) + ca * eff("ca", _rush_pts) + att * eff("att", _pass_pts)

    league_avg = sum(implied.values()) / len(implied) if implied else None
    env = (implied[team] / league_avg) ** ENV_EXP if league_avg and team in implied else 1.0

    tshare = [_f(r["target_share"]) for r in recent]
    trend = None
    if len(tshare) >= 3 and pos in ("WR", "TE", "RB"):
        last2, before = sum(tshare[:2]) / 2, sum(tshare[2:]) / len(tshare[2:])
        if last2 - before >= 0.05:
            trend = f"target share up: {before:.0%} → {last2:.0%}"
        elif before - last2 >= 0.05:
            trend = f"target share down: {before:.0%} → {last2:.0%}"
    snap = None
    if snaps is not None:
        from .briefing import snap_profile

        sp = snap_profile(team, name, snaps)
        snap = sp["avg"] if sp else None
    return {
        "proj": round(base * env, 1),
        "targets": round(tg, 1),
        "carries": round(ca, 1),
        "target_share": round(_wavg(tshare), 3) if tshare else None,
        "snap": snap,
        "ppr_avg": round(sum(_f(r["fantasy_points_ppr"]) for r in recent) / len(recent), 1),
        "implied": implied.get(team),
        "env": round(env, 2),
        "trend": trend,
        "games": len(weeks),
    }


def attach(team_summary: dict, stats: dict, implied: dict, snaps=None) -> None:
    """Add a usage projection to every skill player on the roster, plus gap flags and ranks."""
    gaps = []
    for p in team_summary["roster"]:
        if p.get("pos") not in ("QB", "RB", "WR", "TE") or not p.get("team"):
            continue
        u = profile(p["name"], p["team"], p["pos"], stats, implied, snaps)
        if u is None:
            continue
        if p["bye"] or p["status"] in ("OUT", "INJURY_RESERVE", "SUSPENSION"):
            u["proj"] = 0.0
        p["usage"] = u
        espn = p["proj"] or 0
        if abs(u["proj"] - espn) >= GAP and not p["bye"]:
            higher = "usage" if u["proj"] > espn else "ESPN"
            why = u["trend"] or (
                f"team expected to score {u['implied']}" if u["implied"] and abs(u["env"] - 1) >= 0.1 else ""
            )
            gaps.append(
                {
                    "player": p["name"],
                    "espn": espn,
                    "usage": u["proj"],
                    "text": f"{p['name']}: ESPN {espn}, usage {u['proj']} ({higher} higher"
                    + (f"; {why}" if why else "")
                    + ")",
                }
            )
    by_pos = defaultdict(list)
    for p in team_summary["roster"]:
        if "usage" in p:
            by_pos[p["pos"]].append(p)
    for group in by_pos.values():
        for key in ("proj", "usage"):
            ordered = sorted(group, key=lambda x: -(x["proj"] or 0) if key == "proj" else -x["usage"]["proj"])
            for i, p in enumerate(ordered, 1):
                p.setdefault("rank", {})["espn" if key == "proj" else "usage"] = i
    team_summary["gaps"] = sorted(gaps, key=lambda g: -abs(g["usage"] - g["espn"]))


def accuracy(projections: list[dict], stats: dict, week: int) -> dict | None:
    """Score saved projections ({name, team, espn, usage}) against actual PPR points."""
    errs = {"espn": [], "usage": []}
    for p in projections:
        weeks = stats["players"].get((p["team"], norm_name(p["name"])), [])
        actual = next((_f(r["fantasy_points_ppr"]) for r in weeks if int(r["week"]) == week), None)
        if actual is None or p.get("espn") is None or p.get("usage") is None:
            continue
        errs["espn"].append(abs(p["espn"] - actual))
        errs["usage"].append(abs(p["usage"] - actual))
    if not errs["espn"]:
        return None
    n = len(errs["espn"])
    return {"n": n, "espn": round(sum(errs["espn"]) / n, 1), "usage": round(sum(errs["usage"]) / n, 1)}
