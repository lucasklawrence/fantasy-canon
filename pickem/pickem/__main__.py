"""pickem CLI.

uv run python -m pickem snapshot [--week N]   fetch, save a snapshot, render out/latest.html
uv run python -m pickem grade [--week N]      grade finished weeks against their snapshots
uv run python -m pickem run                   grade, then snapshot (what the schedule runs)
uv run python -m pickem render                re-render out/latest.html from saved history, no fetch
"""

import argparse
import json

from . import SEASON, history, sources
from .briefing import build, current_week, finals

OUT = history.ROOT / "out"
TEMPLATE = history.ROOT / "pickem" / "template.html"


def render(data: dict) -> str:
    season = history.season_results(data["season"], history.HISTORY)
    out = TEMPLATE.read_text(encoding="utf-8")
    for token, value in (("/*__DATA__*/null", data), ("/*__SEASON__*/null", season)):
        out = out.replace(token, json.dumps(value, separators=(",", ":")).replace("</", "<\\/"))
    return out


def write_page(data: dict) -> None:
    OUT.mkdir(exist_ok=True)
    (OUT / "latest.html").write_text(render(data), encoding="utf-8")


def cmd_snapshot(week: int | None) -> None:
    week = week or current_week(sources, SEASON)
    data = build(sources, SEASON, week)
    path = history.save_snapshot(data)
    write_page(data)
    flagged = sum(1 for g in data["games"] if g["flags"])
    print(f"week {week}: {len(data['games'])} games, {flagged} flagged -> {path.relative_to(history.ROOT)}")


def cmd_grade(week: int | None) -> None:
    weeks = [week] if week else history.ungraded_weeks(SEASON)
    for wk in weeks:
        snaps = history.snapshots(SEASON, wk)
        if not snaps:
            print(f"week {wk}: no snapshots, nothing to grade")
            continue
        res = history.grade_week(finals(sources.scoreboard(SEASON, wk), SEASON, wk), snaps)
        history.save_results(res)
        done = [g for g in res["games"] if g["winner"]]
        chalk = sum(1 for g in done if g["winner"] == g["fav"])
        state = "final" if res["complete"] else "partial"
        print(f"week {wk}: {state}, favorites {chalk}/{len(done)}")


def main() -> None:
    p = argparse.ArgumentParser(prog="pickem")
    p.add_argument("command", choices=["snapshot", "grade", "run", "render"])
    p.add_argument("--week", type=int)
    a = p.parse_args()
    if a.command in ("grade", "run"):
        cmd_grade(a.week if a.command == "grade" else None)
    if a.command in ("snapshot", "run"):
        cmd_snapshot(a.week if a.command == "snapshot" else None)
    if a.command == "render":
        data = history.latest_snapshot()
        if data is None:
            raise SystemExit("no snapshots yet: run `python -m pickem snapshot` first")
        write_page(data)
        print(f"rendered week {data['week']} from snapshot {data['generated']}")


if __name__ == "__main__":
    main()
