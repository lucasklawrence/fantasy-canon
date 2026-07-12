"""Unit tests for the storyline transforms (luck / churn / waiver_spend / rivalries).

The numeric fixtures are small enough to spot-check by hand -- the "Done when" of issue #16.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dags"))

from normalize import (  # noqa: E402  (build/read partitions like the DAG does)
    clear_weekly_partitions,
    group_rows_by_week,
    read_all_weeks,
    read_table,
    write_table,
)
from storylines import (  # noqa: E402
    compute_churn,
    compute_luck,
    compute_rivalries,
    compute_waiver_spend_by_week,
    is_waiver_spend,
    season_week_count,
)

# --------------------------------------------------------------------------------- luck


def _four_team_two_week_scores() -> list[dict]:
    """4 teams, 2 weeks. Points fixed so all-play (hence expected wins) is hand-computable.

    wk1 points 1:100 2:90 3:80 4:70   matchups 1-4 (1 W), 2-3 (2 W)
    wk2 points 1:60 2:95 3:85 4:75    matchups 1-2 (2 W), 3-4 (3 W)
    Actual wins: t1=1, t2=2, t3=1, t4=0.
    All-play over 6 comparisons each: t1 3/6, t2 5/6, t3 3/6, t4 1/6 -> expected = winPct*2.
    Luck = wins - expected: t1 0, t2 +1/3, t3 0, t4 -1/3.
    """
    return [
        {"week": 1, "teamId": 1, "points": 100, "oppId": 4, "result": "W"},
        {"week": 1, "teamId": 4, "points": 70, "oppId": 1, "result": "L"},
        {"week": 1, "teamId": 2, "points": 90, "oppId": 3, "result": "W"},
        {"week": 1, "teamId": 3, "points": 80, "oppId": 2, "result": "L"},
        {"week": 2, "teamId": 1, "points": 60, "oppId": 2, "result": "L"},
        {"week": 2, "teamId": 2, "points": 95, "oppId": 1, "result": "W"},
        {"week": 2, "teamId": 3, "points": 85, "oppId": 4, "result": "W"},
        {"week": 2, "teamId": 4, "points": 75, "oppId": 3, "result": "L"},
    ]


def test_compute_luck_ranks_luckiest_first_and_matches_hand_math():
    rows = compute_luck(_four_team_two_week_scores())
    # Ranked by luck desc, then teamId asc.
    assert [r["teamId"] for r in rows] == [2, 1, 3, 4]
    by_team = {r["teamId"]: r for r in rows}

    # Luckiest: team 2 won 2 but "should" have won 5/6*2 = 1.666667.
    assert by_team[2]["wins"] == 2
    assert by_team[2]["allPlayWins"] == 5
    assert by_team[2]["allPlayLosses"] == 1
    assert by_team[2]["allPlayWinPct"] == 0.833333
    assert by_team[2]["games"] == 2
    assert by_team[2]["expectedWins"] == 1.666667
    assert by_team[2]["luck"] == 0.333333

    # Exactly average teams have zero luck.
    assert by_team[1]["luck"] == 0.0
    assert by_team[3]["luck"] == 0.0

    # Unluckiest: team 4 won 0 but "should" have won 1/6*2 = 0.333333.
    assert by_team[4]["expectedWins"] == 0.333333
    assert by_team[4]["allPlayWinPct"] == 0.166667
    assert by_team[4]["luck"] == -0.333333


def test_compute_luck_counts_ties_in_allplay_denominator():
    # Three teams, one week, two tie on top.
    scores = [
        {"week": 1, "teamId": 1, "points": 100, "oppId": 2, "result": "T"},
        {"week": 1, "teamId": 2, "points": 100, "oppId": 1, "result": "T"},
        {"week": 1, "teamId": 3, "points": 80, "oppId": 0, "result": "L"},
    ]
    by_team = {r["teamId"]: r for r in compute_luck(scores)}
    # team 1: beats 3, ties 2 -> 1 win / (1+0+1) = 0.5 winPct over its 2 comparisons.
    assert by_team[1]["allPlayWins"] == 1
    assert by_team[1]["allPlayTies"] == 1
    assert by_team[1]["allPlayWinPct"] == 0.5


def test_compute_luck_empty():
    assert compute_luck([]) == []


# -------------------------------------------------------------------------------- churn


def test_compute_churn_counts_adds_drops_trades_and_per_week():
    transactions = [
        # waiver add/drop for team 1
        {
            "type": "WAIVER",
            "status": "EXECUTED",
            "teamId": 1,
            "items": [
                {"type": "ADD", "toTeamId": 1},
                {"type": "DROP", "fromTeamId": 1},
            ],
        },
        # free-agent add for team 2
        {"type": "FREEAGENT", "status": "EXECUTED", "teamId": 2, "items": [{"toTeamId": 2}]},
        # trade: player 1->2 and player 2->1 (each side an add and a drop)
        {
            "type": "TRADE_ACCEPT",
            "status": "EXECUTED",
            "teamId": 1,
            "items": [
                {"fromTeamId": 1, "toTeamId": 2},
                {"fromTeamId": 2, "toTeamId": 1},
            ],
        },
        # canceled waiver -> ignored entirely
        {"type": "WAIVER", "status": "CANCELED", "teamId": 3, "items": [{"toTeamId": 3}]},
    ]
    rows = compute_churn(transactions, weeks=3)
    assert rows == [
        {
            "teamId": 1,
            "adds": 2,
            "drops": 2,
            "trades": 1,
            "moves": 4,
            "weeks": 3,
            "churnPerWeek": 1.333333,
        },
        {
            "teamId": 2,
            "adds": 2,
            "drops": 1,
            "trades": 0,
            "moves": 3,
            "weeks": 3,
            "churnPerWeek": 1.0,
        },
    ]


def test_compute_churn_zero_weeks_gives_zero_rate():
    transactions = [{"status": "EXECUTED", "teamId": 1, "items": [{"toTeamId": 1}]}]
    assert compute_churn(transactions, weeks=0)[0]["churnPerWeek"] == 0.0


def test_compute_churn_status_is_case_insensitive():
    # A lower-case "executed" status still counts (normalize preserves ESPN's raw case).
    transactions = [{"status": "executed", "teamId": 1, "items": [{"toTeamId": 1}]}]
    assert compute_churn(transactions, weeks=1)[0]["adds"] == 1


# ------------------------------------------------------------------------- waiver_spend


def test_is_waiver_spend_gate():
    assert is_waiver_spend({"type": "WAIVER", "status": "EXECUTED", "bid": 5})
    assert is_waiver_spend({"type": "WAIVER_ADJUSTMENT", "bid": 1})  # status absent ok
    assert is_waiver_spend({"type": "waiver", "status": "executed", "bid": 3})  # case-insensitive
    assert not is_waiver_spend({"type": "WAIVER", "bid": 0})  # zero bid
    assert not is_waiver_spend({"type": "FREEAGENT", "bid": 5})  # not a waiver
    assert not is_waiver_spend({"type": "WAIVER", "status": "PENDING", "bid": 5})  # unsettled


def test_compute_waiver_spend_by_week_aggregates_and_sorts():
    transactions = [
        {"type": "WAIVER", "status": "EXECUTED", "teamId": 1, "week": 1, "bid": 50},
        {"type": "WAIVER", "status": "EXECUTED", "teamId": 1, "week": 1, "bid": 10},  # same cell
        {"type": "WAIVER", "status": "EXECUTED", "teamId": 2, "week": 1, "bid": 30},
        {"type": "WAIVER", "status": "EXECUTED", "teamId": 1, "week": 2, "bid": 25},
        {"type": "FREEAGENT", "teamId": 1, "week": 1, "bid": 0},  # not a waiver spend
        {"type": "WAIVER", "status": "PENDING", "teamId": 3, "week": 1, "bid": 5},  # unsettled
    ]
    assert compute_waiver_spend_by_week(transactions) == [
        {"week": 1, "teamId": 1, "spend": 60.0},
        {"week": 1, "teamId": 2, "spend": 30.0},
        {"week": 2, "teamId": 1, "spend": 25.0},
    ]


# --------------------------------------------------------------------------- rivalries


def test_compute_rivalries_head_to_head_records_and_ranking():
    scores = [
        {"week": 1, "teamId": 1, "points": 120, "oppId": 2, "result": "W"},
        {"week": 1, "teamId": 2, "points": 100, "oppId": 1, "result": "L"},
        {"week": 1, "teamId": 4, "points": 110, "oppId": 3, "result": "W"},
        {"week": 1, "teamId": 3, "points": 90, "oppId": 4, "result": "L"},
        {"week": 2, "teamId": 1, "points": 110, "oppId": 2, "result": "W"},
        {"week": 2, "teamId": 2, "points": 90, "oppId": 1, "result": "L"},
        {"week": 2, "teamId": 4, "points": 100, "oppId": 3, "result": "W"},
        {"week": 2, "teamId": 3, "points": 95, "oppId": 4, "result": "L"},
    ]
    assert compute_rivalries(scores) == [
        {"teamA": 1, "teamB": 2, "aWins": 2, "bWins": 0, "aPoints": 230.0, "bPoints": 190.0},
        {"teamA": 3, "teamB": 4, "aWins": 0, "bWins": 2, "aPoints": 185.0, "bPoints": 210.0},
    ]


def test_compute_rivalries_ties_count_for_neither_and_skip_byes():
    scores = [
        {"week": 1, "teamId": 1, "points": 100, "oppId": 2, "result": "T"},
        {"week": 1, "teamId": 2, "points": 100, "oppId": 1, "result": "T"},
        {"week": 2, "teamId": 1, "points": 80, "oppId": None, "result": "W"},  # bye -> skipped
    ]
    rows = compute_rivalries(scores)
    assert rows == [
        {"teamA": 1, "teamB": 2, "aWins": 0, "bWins": 0, "aPoints": 100.0, "bPoints": 100.0}
    ]


def test_compute_rivalries_empty():
    assert compute_rivalries([]) == []


# ----------------------------------------------------------------------- season shape


def test_season_week_count_uses_max_week():
    assert season_week_count([{"week": 1}, {"week": 5}, {"week": 3}]) == 5
    assert season_week_count([]) == 0


# ------------------------------------------ idempotent weekly rerun (clear before write)


def test_waiver_spend_rerun_prunes_a_week_that_went_empty(tmp_path):
    # First run: two waiver weeks. Second run: a backfill removed week 2's only bid.
    root = str(tmp_path)
    first = [
        {"type": "WAIVER", "status": "EXECUTED", "teamId": 1, "week": 1, "bid": 20},
        {"type": "WAIVER", "status": "EXECUTED", "teamId": 1, "week": 2, "bid": 15},
    ]
    for week, rows in group_rows_by_week(compute_waiver_spend_by_week(first)).items():
        write_table(root, 2024, "waiver_spend", rows, as_of="t1", week=week)
    assert {r["week"] for r in read_all_weeks(root, 2024, "waiver_spend")} == {1, 2}

    second = first[:1]  # week 2's bid is gone
    clear_weekly_partitions(root, 2024, "waiver_spend")  # the DAG clears before re-writing
    for week, rows in group_rows_by_week(compute_waiver_spend_by_week(second)).items():
        write_table(root, 2024, "waiver_spend", rows, as_of="t2", week=week)
    # Week 2's stale partition is gone; only week 1 survives.
    assert read_all_weeks(root, 2024, "waiver_spend") == [{"week": 1, "teamId": 1, "spend": 20.0}]


# --------------------------------------------------------- end-to-end materialization


def test_storyline_tables_materialize_for_a_test_season(tmp_path):
    """The "Done when" of #16: write normalized partitions, run the transforms through the
    same read/write path the DAG uses, and read every storyline table back."""
    normalized = str(tmp_path / "normalized")
    storylines_root = str(tmp_path / "storylines")
    season = 2024

    # Lay down normalized inputs the way `normalize` would: scores per week, one waiver tx.
    for week, rows in group_rows_by_week(_four_team_two_week_scores()).items():
        write_table(normalized, season, "team_week_scores", rows, as_of="t", week=week)
    write_table(
        normalized,
        season,
        "transactions",
        [
            {
                "type": "WAIVER",
                "status": "EXECUTED",
                "teamId": 1,
                "week": 1,
                "bid": 40,
                "items": [{"toTeamId": 1}, {"fromTeamId": 1}],
            }
        ],
        as_of="t",
        week=1,
    )

    # Run the transforms exactly as the DAG tasks do.
    scores = read_all_weeks(normalized, season, "team_week_scores")
    transactions = read_all_weeks(normalized, season, "transactions")
    write_table(storylines_root, season, "luck", compute_luck(scores), as_of="t")
    write_table(
        storylines_root,
        season,
        "churn",
        compute_churn(transactions, weeks=season_week_count(scores)),
        as_of="t",
    )
    write_table(storylines_root, season, "rivalries", compute_rivalries(scores), as_of="t")
    for week, rows in group_rows_by_week(compute_waiver_spend_by_week(transactions)).items():
        write_table(storylines_root, season, "waiver_spend", rows, as_of="t", week=week)

    # Every storyline table materialized and reads back with the expected top-line values.
    luck = read_table(storylines_root, season, "luck")
    assert luck["row_count"] == 4 and luck["rows"][0]["teamId"] == 2  # luckiest first
    assert read_table(storylines_root, season, "churn")["rows"][0]["moves"] == 2  # 1 add + 1 drop
    # Four distinct pairings met: (1,4) & (2,3) in wk1, (1,2) & (3,4) in wk2.
    assert read_table(storylines_root, season, "rivalries")["row_count"] == 4
    assert read_table(storylines_root, season, "waiver_spend", week=1)["rows"] == [
        {"week": 1, "teamId": 1, "spend": 40.0}
    ]
