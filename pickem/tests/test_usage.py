import pytest

from pickem import usage


def row(name, team, week, pos="WR", tg=0, rec=0, ryd=0, rtd=0, ca=0, rush=0, ppr=0.0, tshare=0.0):
    return {
        "player_display_name": name, "team": team, "week": str(week), "position": pos, "season_type": "REG",
        "targets": str(tg), "receptions": str(rec), "receiving_yards": str(ryd), "receiving_tds": str(rtd),
        "carries": str(ca), "rushing_yards": str(rush), "rushing_tds": "0", "attempts": "0",
        "passing_yards": "0", "passing_tds": "0", "passing_interceptions": "0",
        "target_share": str(tshare), "fantasy_points_ppr": str(ppr),
    }  # fmt: skip


def test_implied_totals_split_total_by_spread():
    b = {
        "games": [
            {
                "total": 54.5,
                "spread_line": {"close": "-4.5"},
                "home": {"abbr": "ARI"},
                "away": {"abbr": "DET"},
            }
        ]
    }
    assert usage.implied_totals(b) == {"ARI": 29.5, "DET": 25.0}


def test_rising_target_share_and_regressed_efficiency():
    # nflverse "LA" is ESPN "LAR"; four games of steady volume, target share climbing late
    rows = [
        row("Puka Test", "LA", w, tg=10, rec=7, ryd=90, ppr=16.0, tshare=s)
        for w, s in ((1, 0.2), (2, 0.2), (3, 0.3), (4, 0.3))
    ]
    rows += [
        row("Filler", "LA", w, tg=10, rec=5, ryd=50) for w in (1, 2, 3, 4)
    ]  # league-average WR efficiency
    stats = usage.index_stats(rows)
    p = usage.profile("Puka Test", "LAR", "WR", stats, {"LAR": 22.0, "SF": 22.0})
    assert p["targets"] == 10 and p["env"] == 1.0
    assert "up" in p["trend"]
    # 1.6 points per target from his games, pulled toward the 1.33 average of all WRs here
    assert 13.3 < p["proj"] < 16.0


def test_better_scoring_environment_raises_projection():
    rows = [row("A", "KC", w, tg=8, rec=6, ryd=70, ppr=13.0) for w in (1, 2, 3)]
    stats = usage.index_stats(rows)
    low = usage.profile("A", "KC", "WR", stats, {"KC": 18.0, "X": 24.0})
    high = usage.profile("A", "KC", "WR", stats, {"KC": 30.0, "X": 24.0})
    assert high["proj"] > low["proj"]


def test_attach_flags_gaps_and_zeroes_out_players():
    rows = [row("Volume Guy", "DET", w, tg=10, rec=8, ryd=100, ppr=18.0) for w in (1, 2, 3)]
    rows += [row("Hurt Guy", "DET", w, tg=6, rec=4, ryd=50, ppr=9.0) for w in (1, 2, 3)]
    stats = usage.index_stats(rows)
    team = {
        "roster": [
            {"name": "Volume Guy", "team": "DET", "pos": "WR", "proj": 8.0, "bye": False, "status": "ACTIVE"},
            {"name": "Hurt Guy", "team": "DET", "pos": "WR", "proj": 0.0, "bye": False, "status": "OUT"},
            {
                "name": "Steelers D/ST",
                "team": "PIT",
                "pos": "D/ST",
                "proj": 7.0,
                "bye": False,
                "status": "ACTIVE",
            },
        ]
    }
    usage.attach(team, stats, {"DET": 24.0})
    vol, hurt, dst = team["roster"]
    assert hurt["usage"]["proj"] == 0.0 and "usage" not in dst
    assert team["gaps"][0]["player"] == "Volume Guy" and "usage higher" in team["gaps"][0]["text"]
    assert vol["rank"] == {"espn": 1, "usage": 1}


def test_accuracy_compares_both_projections_to_actual_points():
    stats = usage.index_stats([row("A", "KC", 5, ppr=20.0), row("B", "KC", 5, ppr=5.0)])
    acc = usage.accuracy(
        [
            {"name": "A", "team": "KC", "espn": 12.0, "usage": 18.0},
            {"name": "B", "team": "KC", "espn": 9.0, "usage": 6.0},
        ],
        stats,
        5,
    )
    assert acc == {"n": 2, "espn": pytest.approx(6.0), "usage": pytest.approx(1.5)}
