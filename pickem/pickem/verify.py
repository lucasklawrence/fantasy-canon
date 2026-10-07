"""Check the history is honest: written before kickoff, and graded the way the code says.

Two kinds of proof, both from things anyone can re-run. Grades that don't reproduce fail the
check. Rows that can't be shown to predate kickoff are reported as unproven without failing it,
because history that arrived through a squash-merged PR (the first snapshot) can't prove its timing.

- Timing. Every snapshot and projection log is committed to git by the schedule. A row only counts
  as pregame if the earliest commit holding its exact numbers is older than the game's kickoff.
  Commit dates can be backdated, so where GitHub's activity log has the push that brought a commit
  to main, that server-side push time is used instead (reported as "GitHub-attested").
- Grading. Results are recomputed from the committed inputs plus public data (ESPN finals,
  nflverse stats) and must match what's committed.
"""

import json
import os
import subprocess
from datetime import datetime
from pathlib import Path

from . import history, projections


def _git(*args: str, cwd: Path) -> str:
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout


def push_times(repo: str | None = None) -> dict[str, datetime]:
    """Commit sha -> when GitHub received the push that made it the tip of main. {} if unavailable."""
    repo = repo or os.environ.get("GITHUB_REPOSITORY", "lucasklawrence/fantasy-canon")
    try:
        out = subprocess.run(
            ["gh", "api", "--paginate", f"repos/{repo}/activity?ref=refs/heads/main&per_page=100",
             "--jq", ".[] | [.after, .timestamp] | @tsv"],
            capture_output=True, text=True, check=True, timeout=60,
        ).stdout  # fmt: skip
    except (OSError, subprocess.SubprocessError):
        return {}
    times = {}
    for line in out.splitlines():
        sha, _, when = line.partition("	")
        times[sha] = datetime.fromisoformat(when)
    return times


_PUSHES: dict[str, datetime] | None = None


def attested(sha: str) -> datetime | None:
    global _PUSHES
    if _PUSHES is None:
        _PUSHES = push_times()
    return _PUSHES.get(sha)


def file_versions(path: Path) -> list[tuple[datetime, dict]]:
    """Every committed version of a JSON file, oldest first, with the later of its commit time and
    GitHub's push time (so a backdated commit can't pass)."""
    repo = path.parent
    top = _git("rev-parse", "--show-toplevel", cwd=repo).strip()
    spec = path.resolve().relative_to(Path(top).resolve()).as_posix()
    out = []
    for line in _git("log", "--format=%H %cI", "--", path.name, cwd=repo).splitlines():
        sha, when = line.split(" ", 1)
        try:
            data = json.loads(_git("show", f"{sha}:{spec}", cwd=repo))
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            continue
        when = datetime.fromisoformat(when)
        pushed = attested(sha)
        out.append((max(when, pushed) if pushed else when, data))
    return sorted(out, key=lambda v: v[0])


def first_committed(path: Path) -> datetime | None:
    v = file_versions(path)
    return v[0][0] if v else None


def check_projection_timing(current: dict, versions: list[tuple[datetime, dict]]) -> dict:
    """For each row, find the earliest commit with the same numbers; it must predate kickoff."""
    ok, late, uncommitted = 0, [], 0
    for row in current["players"]:
        if row.get("backtest"):
            continue
        key = (row["espn"], row["usage"])
        first = next(
            (
                when
                for when, data in versions
                for r in data["players"]
                if r["id"] == row["id"] and (r["espn"], r["usage"]) == key
            ),
            None,
        )
        if first is None:
            uncommitted += 1
        elif first <= datetime.fromisoformat(row["kickoff"]):
            ok += 1
        else:
            late.append({"name": row["name"], "kickoff": row["kickoff"], "committed": first.isoformat()})
    return {"pregame": ok, "late": late, "uncommitted": uncommitted}


def check_snapshot_timing(results: dict, committed_at) -> dict:
    """Each graded game names the snapshot it used; that file must be committed before kickoff."""
    ok, late, uncommitted = 0, [], 0
    for g in results["games"]:
        when = committed_at(g["snapshot"])
        if when is None:
            uncommitted += 1
        elif when <= datetime.fromisoformat(g["kickoff"]):
            ok += 1
        else:
            late.append({"game": f"{g['away']}@{g['home']}", "kickoff": g["kickoff"], "committed": str(when)})
    return {"pregame": ok, "late": late, "uncommitted": uncommitted}


def snapshot_path(season: int, week: int, generated: str, base: Path = history.HISTORY) -> Path:
    stamp = generated.replace(":", "-").replace("+00-00", "Z")  # same naming as history.save_snapshot
    return history.week_dir(season, week, base) / "snapshots" / f"{stamp}.json"


def regrade_projections(
    season: int, week: int, stat_rows: list[dict], base: Path = history.HISTORY
) -> str | None:
    """ "same", "revised" (only nflverse actuals changed: a stat correction), "different", or None."""
    log = projections.load(season, week, base=base)
    saved = projections.load(season, week, "projection_results.json", base)
    if not log or not saved:
        return None
    fresh = projections.grade(log, stat_rows)
    if fresh is None:
        return "different"
    if fresh["players"] == saved["players"]:
        same = all(fresh["summary"].get(k) == v for k, v in saved["summary"].items())
        return "same" if same else "different"
    strip = lambda rows: [{k: v for k, v in r.items() if k != "actual"} for r in rows]
    return "revised" if strip(fresh["players"]) == strip(saved["players"]) else "different"


def finished(games: list[dict]) -> list[dict]:
    return [g for g in games if g.get("winner")]


def run(season: int, sources, base: Path = history.HISTORY) -> list[str]:
    """Human-readable report lines. Raises SystemExit(1) if a committed grade doesn't reproduce."""
    from .briefing import finals

    lines, failed = [], False
    stat_rows = sources.player_stats(season)
    for wd in sorted((base / str(season)).glob("w*")):
        week = int(wd.name[1:])
        log = projections.load(season, week, base=base)
        if log and not all(r.get("backtest") for r in log["players"]):
            t = check_projection_timing(
                log, file_versions(projections.path_for(season, week, "projections.json", base))
            )
            lines.append(
                f"week {week} projections: {t['pregame']} rows committed before kickoff, "
                f"{len(t['late'])} unproven, {t['uncommitted']} not committed yet"
            )
            lines += [
                f"  unproven {x['name']}: kickoff {x['kickoff']}, first committed {x['committed']}"
                for x in t["late"]
            ]
        elif log:
            lines.append(f"week {week} projections: backtest (rebuilt after the fact; timing not claimed)")
        outcome = regrade_projections(season, week, stat_rows, base)
        if outcome is not None:
            failed |= outcome == "different"
            lines.append(
                f"week {week} projection grades: "
                + {
                    "same": "reproduce",
                    "revised": "projections match; nflverse has since revised some stats "
                    f"(refresh with `grade --week {week}`)",
                    "different": "DO NOT reproduce",
                }[outcome]
            )
        res = history.load_results(season, week, base)
        if res:
            snaps = history.snapshots(season, week, base)
            regraded = history.grade_week(finals(sources.scoreboard(season, week), season, week), snaps)
            fresh = {g["id"]: g for g in regraded["games"]}
            match = all(fresh.get(g["id"]) == g for g in finished(res["games"]))
            t = check_snapshot_timing(
                {"games": finished(res["games"])},
                lambda g, w=week: first_committed(snapshot_path(season, w, g, base)),
            )
            failed |= not match
            lines.append(
                f"week {week} pick'em: grades {'reproduce' if match else 'DO NOT reproduce'}; "
                f"{t['pregame']} games from snapshots committed before kickoff, {len(t['late'])} unproven, "
                f"{t['uncommitted']} not committed yet"
            )
    if _PUSHES is not None:
        source = (
            "GitHub push log + commit dates" if _PUSHES else "commit dates only (GitHub push log unavailable)"
        )
        lines.append(f"timing source: {source}")
    if failed:
        lines.append("FAILED")
        print("\n".join(lines))
        raise SystemExit(1)
    lines.append("all checks passed")
    return lines
