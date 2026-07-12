"""Unit tests for the normalize transforms and partitioned derived-table storage."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dags"))

from normalize import (  # noqa: E402
    clear_weekly_partitions,
    group_rows_by_week,
    normalize_team_week_scores,
    normalize_teams,
    normalize_transactions,
    read_all_weeks,
    read_table,
    table_path,
    write_table,
)

# ------------------------------------------------------------------------------- teams


def test_normalize_teams_builds_name_from_location_and_nickname():
    payload = {"teams": [{"id": 1, "location": "Big", "nickname": "Dogs", "abbrev": "BD"}]}
    assert normalize_teams(payload) == [
        {"teamId": 1, "name": "Big Dogs", "abbrev": "BD", "location": "Big", "nickname": "Dogs"}
    ]


def test_normalize_teams_falls_back_to_name_then_abbrev_then_id():
    payload = {
        "teams": [
            {"id": 2, "name": "Team Rocket"},
            {"id": 3, "abbrev": "ZZ"},
            {"id": 4},
        ]
    }
    names = [t["name"] for t in normalize_teams(payload)]
    assert names == ["Team Rocket", "ZZ", "Team 4"]


def test_normalize_teams_skips_teams_without_a_numeric_id_and_bad_payloads():
    payload = {"teams": [{"location": "No", "nickname": "Id"}, "nope", {"id": 5, "location": "A"}]}
    rows = normalize_teams(payload)
    assert [r["teamId"] for r in rows] == [5]
    assert normalize_teams(None) == []
    assert normalize_teams({}) == []


# -------------------------------------------------------------------- team_week_scores


def test_normalize_scores_home_away_gives_two_rows_with_opponent_and_result():
    payload = {
        "schedule": [
            {
                "matchupPeriodId": 1,
                "home": {"teamId": 1, "totalPoints": 120.5},
                "away": {"teamId": 2, "totalPoints": 98.2},
            }
        ]
    }
    assert normalize_team_week_scores(payload) == [
        {"week": 1, "teamId": 1, "points": 120.5, "oppId": 2, "result": "W"},
        {"week": 1, "teamId": 2, "points": 98.2, "oppId": 1, "result": "L"},
    ]


def test_normalize_scores_handles_teams_shape_and_scoring_period_fallback_and_missing_points():
    payload = {
        "schedule": [
            {"scoringPeriodId": 3, "teams": [{"teamId": 5, "totalPoints": 88}, {"teamId": 6}]}
        ]
    }
    # Missing totalPoints counts as 0, so team 6 still appears and loses.
    assert normalize_team_week_scores(payload) == [
        {"week": 3, "teamId": 5, "points": 88.0, "oppId": 6, "result": "W"},
        {"week": 3, "teamId": 6, "points": 0.0, "oppId": 5, "result": "L"},
    ]


def test_normalize_scores_marks_equal_points_as_a_tie():
    payload = {
        "schedule": [
            {
                "matchupPeriodId": 7,
                "home": {"teamId": 1, "totalPoints": 100},
                "away": {"teamId": 2, "totalPoints": 100},
            }
        ]
    }
    results = {r["teamId"]: r["result"] for r in normalize_team_week_scores(payload)}
    assert results == {1: "T", 2: "T"}


def test_normalize_scores_reads_matchups_when_schedule_absent_and_skips_weekless_or_lopsided():
    payload = {
        "matchups": [
            {
                "home": {"teamId": 1, "totalPoints": 10},
                "away": {"teamId": 2, "totalPoints": 20},
            },  # no week -> skip
            {"matchupPeriodId": 2, "home": {"teamId": 1, "totalPoints": 30}},  # no away -> skip
            {
                "matchupPeriodId": 2,
                "home": {"teamId": 1, "totalPoints": 40},
                "away": {"teamId": 2, "totalPoints": 35},
            },
        ]
    }
    assert normalize_team_week_scores(payload) == [
        {"week": 2, "teamId": 1, "points": 40.0, "oppId": 2, "result": "W"},
        {"week": 2, "teamId": 2, "points": 35.0, "oppId": 1, "result": "L"},
    ]


def test_normalize_scores_returns_empty_for_bad_payloads():
    assert normalize_team_week_scores(None) == []
    assert normalize_team_week_scores({}) == []
    assert normalize_team_week_scores({"schedule": "x"}) == []


# ------------------------------------------------------------------------ transactions


def test_normalize_transactions_extracts_core_fields_and_items():
    payload = {
        "transactions": [
            {
                "id": "tx-1",
                "type": "WAIVER",
                "status": "EXECUTED",
                "teamId": 4,
                "bidAmount": 17,
                "scoringPeriodId": 5,
                "processDate": 1700000000000,
                "items": [
                    {"type": "ADD", "playerId": 111, "toTeamId": 4},
                    {"type": "DROP", "playerId": 222, "fromTeamId": 4},
                ],
            }
        ]
    }
    assert normalize_transactions(payload) == [
        {
            "id": "tx-1",
            "type": "WAIVER",
            "status": "EXECUTED",
            "teamId": 4,
            "bid": 17,
            "week": 5,
            "time": 1700000000000,
            "items": [
                {"type": "ADD", "playerId": 111, "fromTeamId": None, "toTeamId": 4},
                {"type": "DROP", "playerId": 222, "fromTeamId": 4, "toTeamId": None},
            ],
        }
    ]


def test_normalize_transactions_resolves_team_id_from_nested_actions():
    # teamId nested inside an array-of-arrays action, as ESPN sometimes returns.
    payload = {"transactions": [{"id": 9, "actions": [[{"teamId": 8}]]}]}
    assert normalize_transactions(payload)[0]["teamId"] == 8


def test_normalize_transactions_time_falls_back_to_proposed_date():
    payload = {"transactions": [{"id": 1, "proposedDate": 1699999999999}]}
    row = normalize_transactions(payload)[0]
    assert row["time"] == 1699999999999
    assert row["bid"] is None and row["week"] is None and row["items"] == []


def test_normalize_transactions_returns_empty_for_bad_payloads():
    assert normalize_transactions(None) == []
    assert normalize_transactions({"transactions": "x"}) == []


# -------------------------------------------------------------------- partition helper


def test_group_rows_by_week_buckets_and_defaults_missing_week():
    rows = [
        {"week": 1, "teamId": 1},
        {"week": 1, "teamId": 2},
        {"week": 2, "teamId": 1},
        {"teamId": 3},  # no week -> default bucket 0
    ]
    grouped = group_rows_by_week(rows)
    assert sorted(grouped) == [0, 1, 2]
    assert len(grouped[1]) == 2
    assert grouped[0] == [{"teamId": 3}]


# ------------------------------------------------------------------------- table store


def test_season_level_table_path():
    assert table_path("/root", 2024, "teams") == Path("/root") / "season=2024" / "teams.json"


def test_week_level_table_path():
    assert (
        table_path("/root", 2024, "team_week_scores", week=7)
        == Path("/root") / "season=2024" / "week=7" / "team_week_scores.json"
    )


def test_write_table_wraps_rows_in_an_auditable_envelope(tmp_path):
    rows = [{"teamId": 1, "name": "A"}]
    write_table(str(tmp_path), 2024, "teams", rows, as_of="2024-01-02T03:04:05+00:00")
    envelope = read_table(str(tmp_path), 2024, "teams")
    assert envelope == {
        "table": "teams",
        "season": 2024,
        "week": None,
        "as_of": "2024-01-02T03:04:05+00:00",
        "row_count": 1,
        "rows": rows,
    }


def test_rewrite_of_a_partition_is_idempotent_overwrite(tmp_path):
    write_table(str(tmp_path), 2024, "team_week_scores", [{"v": 1}], as_of="t1", week=3)
    write_table(str(tmp_path), 2024, "team_week_scores", [{"v": 2}], as_of="t2", week=3)
    envelope = read_table(str(tmp_path), 2024, "team_week_scores", week=3)
    assert envelope["rows"] == [{"v": 2}]
    assert envelope["as_of"] == "t2"
    # Second write wins; no leftover temp file in the partition dir.
    files = sorted(p.name for p in (tmp_path / "season=2024" / "week=3").iterdir())
    assert files == ["team_week_scores.json"]


def test_week_partition_is_isolated_from_season_partition(tmp_path):
    write_table(str(tmp_path), 2024, "transactions", [{"scope": "season"}], as_of="t")
    write_table(str(tmp_path), 2024, "transactions", [{"scope": "week5"}], as_of="t", week=5)
    assert read_table(str(tmp_path), 2024, "transactions")["rows"] == [{"scope": "season"}]
    assert read_table(str(tmp_path), 2024, "transactions", week=5)["rows"] == [{"scope": "week5"}]


# --------------------------------------------------------- read across week partitions


def test_read_all_weeks_concatenates_partitions_in_week_order(tmp_path):
    write_table(
        str(tmp_path), 2024, "team_week_scores", [{"week": 2, "teamId": 1}], as_of="t", week=2
    )
    write_table(
        str(tmp_path), 2024, "team_week_scores", [{"week": 1, "teamId": 9}], as_of="t", week=1
    )
    rows = read_all_weeks(str(tmp_path), 2024, "team_week_scores")
    assert [(r["week"], r["teamId"]) for r in rows] == [(1, 9), (2, 1)]


def test_read_all_weeks_missing_season_or_table_returns_empty(tmp_path):
    assert read_all_weeks(str(tmp_path), 1999, "team_week_scores") == []
    write_table(str(tmp_path), 2024, "transactions", [{"week": 1}], as_of="t", week=1)
    assert read_all_weeks(str(tmp_path), 2024, "team_week_scores") == []  # other table absent


# --------------------------------------------------- idempotent weekly partition clear


def test_clear_weekly_partitions_removes_only_that_table(tmp_path):
    root = str(tmp_path)
    write_table(root, 2024, "waiver_spend", [{"week": 1}], as_of="t", week=1)
    write_table(root, 2024, "waiver_spend", [{"week": 2}], as_of="t", week=2)
    write_table(root, 2024, "transactions", [{"week": 1}], as_of="t", week=1)  # shares week=1 dir
    removed = clear_weekly_partitions(root, 2024, "waiver_spend")
    assert removed == 2
    assert read_all_weeks(root, 2024, "waiver_spend") == []
    assert read_all_weeks(root, 2024, "transactions") == [{"week": 1}]  # other table untouched


def test_clear_weekly_partitions_missing_season_is_a_noop(tmp_path):
    assert clear_weekly_partitions(str(tmp_path), 1999, "waiver_spend") == 0
