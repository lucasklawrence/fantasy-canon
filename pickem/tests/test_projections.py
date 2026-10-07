from datetime import UTC, datetime

from pickem import projections, verify


def stat(name, team, week, pos="WR", tg=8, rec=6, ryd=70, ppr=13.0):
    return {
        "player_display_name": name, "team": team, "week": str(week), "position": pos, "season_type": "REG",
        "targets": str(tg), "receptions": str(rec), "receiving_yards": str(ryd), "receiving_tds": "0",
        "carries": "0", "rushing_yards": "0", "rushing_tds": "0", "attempts": "0", "passing_yards": "0",
        "passing_tds": "0", "passing_interceptions": "0", "target_share": "0.2", "fantasy_points_ppr": str(ppr),
    }  # fmt: skip


def espn_player(pid, name, team_id, pos_id, week, proj, status=None):
    return {
        "player": {
            "id": pid,
            "fullName": name,
            "proTeamId": team_id,
            "defaultPositionId": pos_id,
            "injuryStatus": status,
            "stats": [
                {"scoringPeriodId": week, "statSourceId": 1, "appliedTotal": proj},
                {"scoringPeriodId": week - 1, "statSourceId": 0, "appliedTotal": 99.0},
            ],
        }
    }


def test_parse_pool_keeps_this_weeks_projection_for_skill_players():
    payload = {
        "players": [
            espn_player(1, "Amon-Ra St. Brown", 8, 3, 6, 17.04),
            espn_player(2, "Some Kicker", 8, 5, 6, 8.0),
            espn_player(3, "Free Agent", 0, 3, 6, 4.0),
        ]
    }
    assert projections.parse_pool(payload, 6) == [
        {"id": 1, "name": "Amon-Ra St. Brown", "team": "DET", "pos": "WR", "status": "ACTIVE", "espn": 17.0}
    ]


def test_build_week_freezes_started_games_and_uses_only_earlier_weeks():
    rows = [stat("A", "KC", w) for w in (1, 2)] + [stat("A", "KC", 3, tg=30, ppr=60.0)]
    pool = [
        {"id": 1, "name": "A", "team": "KC", "pos": "WR", "status": "ACTIVE", "espn": 12.0},
        {"id": 2, "name": "B", "team": "DET", "pos": "WR", "status": "OUT", "espn": 0.0},
        {"id": 3, "name": "C", "team": "SF", "pos": "WR", "status": "ACTIVE", "espn": 9.0},  # SF on bye
    ]
    kicks = {"KC": "2026-09-28T17:00Z", "DET": "2026-09-28T20:25Z"}
    now = datetime(2026, 9, 28, 12, tzinfo=UTC)
    log = projections.build_week(
        pool, rows + [stat("B", "DET", 1)], {"KC": 24, "DET": 24}, kicks, 2026, 3, now
    )
    a, b = log["players"]
    assert (a["name"], b["name"]) == ("A", "B")  # bye team skipped, ordered by kickoff
    assert a["targets"] == 8.0  # the week-3 explosion isn't visible to a week-3 projection
    assert b["usage"] == 0.0  # ruled out

    later = datetime(2026, 9, 28, 18, tzinfo=UTC)  # KC has kicked off, DET hasn't
    pool[0]["espn"], pool[1]["espn"] = 20.0, 5.0
    again = projections.build_week(pool, rows, {"KC": 24, "DET": 24}, kicks, 2026, 3, later, prev=log)
    assert [p["espn"] for p in again["players"]] == [12.0, 5.0]


def test_grade_scores_only_players_who_played_and_waits_for_stats():
    log = {
        "season": 2026,
        "week": 5,
        "players": [
            {"id": 1, "name": "A", "team": "KC", "pos": "WR", "espn": 10.0, "usage": 14.0, "avg": 11.0},
            {"id": 2, "name": "B", "team": "KC", "pos": "WR", "espn": 10.0, "usage": 6.0, "avg": 9.0},
            {"id": 3, "name": "Scratch", "team": "KC", "pos": "WR", "espn": 9.0, "usage": 9.0, "avg": 9.0},
        ],
    }
    assert projections.grade(log, [stat("A", "KC", 4)]) is None
    res = projections.grade(log, [stat("A", "KC", 5, ppr=16.0), stat("B", "KC", 5, ppr=4.0)])
    s = res["summary"]
    assert s["n"] == 2 and s["espn"] == 6.0 and s["usage"] == 2.0 and s["blend"] == 4.0
    assert (s["fade"], s["fade_hit"], s["boost"], s["boost_hit"], s["usage_closer"]) == (1, 1, 1, 1, 2)
    assert res["backtest"] is False


def test_projection_timing_needs_a_commit_before_kickoff():
    row = {"id": 1, "name": "A", "kickoff": "2026-10-11T17:00Z", "espn": 10.0, "usage": 12.0}
    early = (datetime(2026, 10, 11, 13, tzinfo=UTC), {"players": [{**row, "espn": 9.0}]})
    pre = (datetime(2026, 10, 11, 16, tzinfo=UTC), {"players": [row]})
    post = (datetime(2026, 10, 11, 18, tzinfo=UTC), {"players": [row]})
    assert verify.check_projection_timing({"players": [row]}, [early, pre, post])["pregame"] == 1
    late = verify.check_projection_timing({"players": [row]}, [early, post])
    assert late["pregame"] == 0 and late["late"][0]["name"] == "A"
    assert verify.check_projection_timing({"players": [row]}, [early])["uncommitted"] == 1


def test_snapshot_timing_and_filename_match_history():
    res = {
        "games": [
            {
                "away": "BUF",
                "home": "KC",
                "kickoff": "2026-10-11T20:25Z",
                "snapshot": "2026-10-11T13:00+00:00",
            }
        ]
    }
    when = {"2026-10-11T13:00+00:00": datetime(2026, 10, 11, 13, 4, tzinfo=UTC)}
    assert verify.check_snapshot_timing(res, when.get)["pregame"] == 1
    assert verify.snapshot_path(2026, 6, "2026-10-11T13:00+00:00").name == "2026-10-11T13-00Z.json"


def test_closing_lines_turn_total_and_spread_into_team_totals():
    sb = {
        "events": [
            {
                "id": "9",
                "competitions": [
                    {
                        "competitors": [
                            {"homeAway": "home", "team": {"abbreviation": "GB"}},
                            {"homeAway": "away", "team": {"abbreviation": "ATL"}},
                        ]
                    }
                ],
            }
        ]
    }
    summary = {"pickcenter": [{"overUnder": 43.5, "pointSpread": {"home": {"close": {"line": "-4.5"}}}}]}
    assert projections.closing_lines(sb, lambda _id: summary) == {"GB": 24.0, "ATL": 19.5}


def test_file_versions_reads_each_commit_of_a_history_file(tmp_path, monkeypatch):
    import json
    import os
    import subprocess

    monkeypatch.setattr(verify, "_PUSHES", {})  # no GitHub lookups from tests
    git = lambda *a, **env: subprocess.run(
        ["git", *a], cwd=tmp_path, check=True, capture_output=True, env=env or None
    )
    git("init", "-q")
    f = tmp_path / "w06" / "projections.json"
    f.parent.mkdir()
    for i, stamp in enumerate(("2026-10-11T12:00:00+00:00", "2026-10-11T16:30:00+00:00")):
        f.write_text(json.dumps({"players": [{"id": 1, "espn": float(i)}]}))
        git("add", ".")
        env = {**os.environ, "GIT_COMMITTER_DATE": stamp, "GIT_AUTHOR_DATE": stamp,
               "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}  # fmt: skip
        git("commit", "-q", "-m", str(i), **env)
    versions = verify.file_versions(f)
    assert [v[1]["players"][0]["espn"] for v in versions] == [0.0, 1.0]
    assert versions[0][0] == datetime(2026, 10, 11, 12, tzinfo=UTC)
