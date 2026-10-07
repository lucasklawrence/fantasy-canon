"""pickem CLI.

uv run python -m pickem snapshot [--week N]   fetch, save a snapshot, render out/latest.html
uv run python -m pickem grade [--week N]      grade finished weeks against their snapshots
uv run python -m pickem run                   grade, then snapshot (what the schedule runs)
uv run python -m pickem render                re-render out/latest.html from saved history (+ your teams)
uv run python -m pickem alerts [--dry-run]    post new injury / line / lineup news to Discord
uv run python -m pickem checkin [--dry-run]   post the weekly fantasy check-in to Discord
"""

import argparse
import json
import os
import sys
import urllib.error
from datetime import UTC, datetime

from . import SEASON, alerts, fantasy, history, sources, usage
from .briefing import build, current_week, finals, index_snaps

OUT = history.ROOT / "out"
TEMPLATE = history.ROOT / "pickem" / "template.html"
STATE = history.ROOT / ".state" / "alerts.json"  # Actions cache in CI, never committed
PROJ_LOG = (
    history.ROOT / ".state" / "projections"
)  # your players' projections each week, also never committed


def load_dotenv() -> None:
    """Pick up ESPN/Discord settings from the repo's gitignored .env when running locally."""
    path = history.ROOT.parent / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and not key.startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def render(data: dict, teams: list[dict] | None = None) -> str:
    season = history.season_results(data["season"], history.HISTORY)
    out = TEMPLATE.read_text(encoding="utf-8")
    for token, value in (
        ("/*__DATA__*/null", data),
        ("/*__SEASON__*/null", season),
        ("/*__TEAMS__*/null", teams or []),
    ):
        out = out.replace(token, json.dumps(value, separators=(",", ":")).replace("</", "<\\/"))
    return out


def write_page(data: dict, teams: list[dict] | None = None) -> None:
    OUT.mkdir(exist_ok=True)
    (OUT / "latest.html").write_text(render(data, teams), encoding="utf-8")


def teams_for(week: int, briefing: dict | None = None) -> list[dict]:
    if not fantasy.credentials():
        return []
    try:
        teams = fantasy.my_teams(SEASON, week, sources.scoreboard(SEASON, week), datetime.now(UTC))
    except urllib.error.HTTPError as e:
        # Usually expired cookies. Keep going so injury/line news still posts.
        print(f"::warning::ESPN fantasy fetch failed (HTTP {e.code}); refresh ESPN_S2/ESPN_SWID")
        return []
    stats = usage.index_stats(sources.player_stats(SEASON))
    snaps = index_snaps(sources.nflverse_csv("snap_counts", SEASON))
    briefing = briefing or week_briefing(week)
    implied = usage.implied_totals(briefing) if briefing else {}
    for t in teams:
        usage.attach(t, stats, implied, snaps)
        log_projections(t, week)
    return teams


def week_briefing(week: int) -> dict | None:
    snaps = history.snapshots(SEASON, week)
    return snaps[-1] if snaps else None


def log_projections(team: dict, week: int) -> None:
    """Keep each player's last pre-kickoff projection (ESPN and usage) for scoring later."""
    path = PROJ_LOG / f"{team['league_id']}-w{week:02d}.json"
    old = {p["name"]: p for p in json.loads(path.read_text(encoding="utf-8"))} if path.exists() else {}
    rows = []
    for p in team["roster"]:
        if "usage" not in p:
            continue
        if p["locked"] and p["name"] in old:
            rows.append(old[p["name"]])  # game started: keep the pregame numbers
        else:
            rows.append(
                {"name": p["name"], "team": p["team"], "espn": p["proj"], "usage": p["usage"]["proj"]}
            )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows), encoding="utf-8")


def projection_record(league_id: str, through_week: int) -> dict | None:
    """Season-to-date average miss for ESPN vs usage projections on your players."""
    stats = usage.index_stats(sources.player_stats(SEASON))
    n = espn = mine = 0.0
    for wk in range(1, through_week + 1):
        path = PROJ_LOG / f"{league_id}-w{wk:02d}.json"
        if not path.exists():
            continue
        acc = usage.accuracy(json.loads(path.read_text(encoding="utf-8")), stats, wk)
        if acc:
            n += acc["n"]
            espn += acc["espn"] * acc["n"]
            mine += acc["usage"] * acc["n"]
    if not n:
        return None
    return {"n": int(n), "espn": round(espn / n, 1), "usage": round(mine / n, 1)}


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


def deliver(text: str, dry_run: bool) -> None:
    # Output stays out of CI logs (the repo is public); only counts are printed there.
    if dry_run:
        print(text)
    else:
        print(f"posted {alerts.post_discord(text)} message(s)")


def cmd_alerts(dry_run: bool) -> None:
    week = current_week(sources, SEASON)
    cur = build(sources, SEASON, week)
    state = alerts.load_state(STATE)
    prev = state.get("last") or next(iter(reversed(history.snapshots(SEASON, week))), None)
    found = alerts.news_changes(prev, cur) + alerts.lineup_alerts(teams_for(week, cur))
    fresh = alerts.unsent(found, state)
    if fresh:
        deliver(alerts.format_post(f"Week {week} update", fresh), dry_run)
    else:
        print("nothing new")
    if not dry_run:
        state["sent"] += [a["key"] for a in fresh]
        state["last"] = cur
        alerts.save_state(STATE, state)


def cmd_checkin(dry_run: bool) -> None:
    week = current_week(sources, SEASON)
    teams = teams_for(week)
    if not teams:
        raise SystemExit("No fantasy teams: set ESPN_S2, ESPN_SWID and PICKEM_LEAGUES")
    for t in teams:
        t["projection_record"] = projection_record(t["league_id"], week - 1)
    deliver(f"**Week {week} fantasy check-in**\n\n" + alerts.format_checkin(teams), dry_run)


def main() -> None:
    p = argparse.ArgumentParser(prog="pickem")
    p.add_argument("command", choices=["snapshot", "grade", "run", "render", "alerts", "checkin"])
    p.add_argument("--week", type=int)
    p.add_argument("--dry-run", action="store_true", help="print instead of posting to Discord")
    a = p.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # emoji in Windows consoles
    load_dotenv()
    if a.command in ("grade", "run"):
        cmd_grade(a.week if a.command == "grade" else None)
    if a.command in ("snapshot", "run"):
        cmd_snapshot(a.week if a.command == "snapshot" else None)
    if a.command == "render":
        data = history.latest_snapshot()
        if data is None:
            raise SystemExit("no snapshots yet: run `python -m pickem snapshot` first")
        teams = teams_for(data["week"], data)
        for t in teams:
            t["projection_record"] = projection_record(t["league_id"], data["week"] - 1)
        write_page(data, teams)
        print(f"rendered week {data['week']} from snapshot {data['generated']}, {len(teams)} fantasy team(s)")
    if a.command == "alerts":
        cmd_alerts(a.dry_run)
    if a.command == "checkin":
        cmd_checkin(a.dry_run)


if __name__ == "__main__":
    main()
