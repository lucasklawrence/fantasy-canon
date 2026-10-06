"""Snapshot storage and grading.

Layout (committed to git by the scheduled workflow):
    history/<season>/w<NN>/snapshots/<YYYY-MM-DDTHH-MM>Z.json   every briefing run
    history/<season>/w<NN>/results.json                          graded once games are final
"""

import json
from pathlib import Path

from .briefing import favorite

ROOT = Path(__file__).resolve().parent.parent
HISTORY = ROOT / "history"


def week_dir(season: int, week: int, base: Path = HISTORY) -> Path:
    return base / str(season) / f"w{week:02d}"


def save_snapshot(data: dict, base: Path = HISTORY) -> Path:
    stamp = data["generated"].replace(":", "-").replace("+00-00", "Z")
    path = week_dir(data["season"], data["week"], base) / "snapshots" / f"{stamp}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    return path


def snapshots(season: int, week: int, base: Path = HISTORY) -> list[dict]:
    d = week_dir(season, week, base) / "snapshots"
    if not d.exists():
        return []
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(d.glob("*.json"))]


def latest_snapshot(base: Path = HISTORY) -> dict | None:
    files = sorted(base.glob("*/w*/snapshots/*.json"), key=lambda p: (p.parts[-4], p.parts[-3], p.name))
    return json.loads(files[-1].read_text(encoding="utf-8")) if files else None


def last_pregame(snaps: list[dict], game_id: str, kickoff: str) -> dict | None:
    """The game as it looked in the latest snapshot taken before kickoff."""
    best = None
    for s in snaps:
        if s["generated"] >= kickoff.replace("Z", "+00:00"):
            continue
        for g in s["games"]:
            if g["id"] == game_id:
                best = {**g, "_generated": s["generated"]}
    return best


def grade_week(final: dict, snaps: list[dict]) -> dict:
    """Score the market favorite and every flag against final results.

    `final` is a briefing (or anything with games carrying id/kickoff/winner/score); the
    pregame view of each game comes from the snapshots so nothing is graded with hindsight.
    """
    games = []
    for fg in final["games"]:
        pre = last_pregame(snaps, fg["id"], fg["kickoff"])
        if pre is None:
            continue
        fav = favorite(pre["market"])
        games.append(
            {
                "id": fg["id"],
                "kickoff": fg["kickoff"],
                "away": fg["away"]["abbr"],
                "home": fg["home"]["abbr"],
                "winner": fg["winner"],
                "score": fg["score"],
                "fav": fav,
                "fav_p": None if pre["market"] is None else round(max(pre["market"], 1 - pre["market"]), 3),
                "fpi_fav": None if pre["fpi"] is None else favorite(pre["fpi"]),
                "flags": [{k: x[k] for k in ("kind", "side", "sev", "vs_fav")} for x in pre["flags"]],
                "snapshot": pre.get("_generated"),
            }
        )
    done = [g for g in games if g["winner"]]
    return {
        "season": final["season"],
        "week": final["week"],
        "complete": len(done) == len(final["games"]) and len(final["games"]) > 0,
        "games": games,
    }


def save_results(results: dict, base: Path = HISTORY) -> Path:
    path = week_dir(results["season"], results["week"], base) / "results.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(results, indent=1), encoding="utf-8")
    return path


def load_results(season: int, week: int, base: Path = HISTORY) -> dict | None:
    p = week_dir(season, week, base) / "results.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None


def season_results(season: int, base: Path = HISTORY) -> list[dict]:
    d = base / str(season)
    if not d.exists():
        return []
    return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(d.glob("w*/results.json"))]


def ungraded_weeks(season: int, base: Path = HISTORY) -> list[int]:
    """Weeks that have snapshots but no complete results yet."""
    d = base / str(season)
    if not d.exists():
        return []
    weeks = []
    for wd in sorted(d.glob("w*")):
        wk = int(wd.name[1:])
        r = load_results(season, wk, base)
        if (wd / "snapshots").exists() and not (r and r["complete"]):
            weeks.append(wk)
    return weeks
