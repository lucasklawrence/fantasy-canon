from datetime import UTC, datetime

import pytest

from pickem import briefing, history
from pickem.briefing import flags_for, index_snaps, no_vig, snap_profile


def snap_row(team, week, player, off, pos="T", dfn=0):
    return {
        "game_type": "REG", "team": team, "week": str(week), "player": player, "position": pos,
        "offense_pct": str(off), "defense_pct": str(dfn),
    }  # fmt: skip


def injury(name, pos, status, played_last=True, starter=True, unit=None):
    return {
        "name": name, "pos": pos, "unit": unit or briefing.UNITS[pos], "status": status,
        "out": status in briefing.OUT_STATUSES, "q": status == "Questionable",
        "starter": starter, "played_last": played_last, "missed": 0 if played_last else 2,
    }  # fmt: skip


def game(market=0.7, market_open=0.7, fpi=0.7, away_inj=(), home_inj=(), rest=(7, 7)):
    return {
        "market": market, "market_open": market_open, "fpi": fpi,
        "away": {"abbr": "AWY", "injuries": list(away_inj), "rest": rest[0]},
        "home": {"abbr": "HOM", "injuries": list(home_inj), "rest": rest[1]},
        "weather": None, "indoor": True, "neutral": False,
    }  # fmt: skip


def test_no_vig_removes_margin_and_sums_to_one():
    home = no_vig("+360", "-470")
    assert home == pytest.approx(0.7917, abs=1e-3)
    assert no_vig("-110", "-110") == pytest.approx(0.5)
    assert no_vig(None, "-110") is None


def test_snap_profile_keeps_injured_starter_and_counts_missed_games():
    rows = [snap_row("LA", w, "Rob Havenstein", 1.0) for w in (1, 2)]
    rows += [snap_row("LA", w, "Backup Guy", 0.1) for w in (1, 2, 3, 4)]
    snaps = index_snaps(rows)
    # nflverse "LA" maps to ESPN "LAR"; suffixes and punctuation are ignored in names
    prof = snap_profile("LAR", "Rob Havenstein Jr.", snaps)
    assert prof["peak"] == 1.0 and prof["missed"] == 2 and prof["last"] == 0
    assert snap_profile("LAR", "Backup Guy", snaps)["peak"] == pytest.approx(0.1)
    assert snap_profile("LAR", "Nobody", snaps)["peak"] == 0.0


def test_favorite_qb_out_argues_for_underdog():
    flags = flags_for(game(home_inj=[injury("Star QB", "QB", "Out")]))
    qb = next(f for f in flags if f["kind"] == "qb")
    assert qb["side"] == "home" and qb["vs_fav"] and qb["sev"] == "high"


def test_underdog_injuries_do_not_count_against_favorite():
    flags = flags_for(game(away_inj=[injury("LT", "OT", "Out"), injury("RG", "G", "Out")]))
    ol = next(f for f in flags if f["kind"] == "ol")
    assert ol["side"] == "away" and not ol["vs_fav"]


def test_multi_week_ol_absences_are_marked_priced_in():
    inj = [
        injury("LT", "OT", "Injured Reserve", played_last=False),
        injury("RG", "G", "Out", played_last=False),
    ]
    ol = next(f for f in flags_for(game(home_inj=inj)) if f["kind"] == "ol")
    assert "priced in" in ol["text"] and ol["sev"] == "med"


def test_line_move_and_fpi_toward_underdog_and_flip():
    flags = {f["kind"]: f for f in flags_for(game(market=0.45, market_open=0.6, fpi=0.6))}
    # away is now the favorite; the line moved toward away (no longer an upset signal)...
    assert flags["move"]["side"] == "away" and not flags["move"]["vs_fav"]
    # ...but FPI still likes home, the new underdog
    assert flags["fpi"]["side"] == "home" and flags["fpi"]["vs_fav"]
    assert "flip" in flags


def test_quiet_game_has_no_flags():
    assert flags_for(game()) == []


class StubSources:
    def __init__(self, state="pre"):
        self.state = state

    def scoreboard(self, season, week=None):
        return {
            "week": {"number": 5},
            "events": [
                {
                    "id": "1",
                    "date": "2026-10-11T17:00Z",
                    "status": {"type": {"state": self.state}},
                    "competitions": [
                        {
                            "neutralSite": False,
                            "competitors": [
                                {
                                    "homeAway": "home",
                                    "winner": self.state == "post",
                                    "score": "24",
                                    "team": {"id": "10", "abbreviation": "HOM", "displayName": "Home Team"},
                                },
                                {
                                    "homeAway": "away",
                                    "winner": False,
                                    "score": "17",
                                    "team": {"id": "20", "abbreviation": "AWY", "displayName": "Away Team"},
                                },
                            ],
                        }
                    ],
                }
            ],
        }

    def summary(self, event_id):
        return {
            "pickcenter": [{"details": "HOM -3", "overUnder": 44.5, "moneyline": {
                "home": {"open": {"odds": "-150"}, "close": {"odds": "-200"}},
                "away": {"open": {"odds": "+130"}, "close": {"odds": "+170"}}}}],
            "predictor": {"homeTeam": {"gameProjection": "61.0"}},
            "gameInfo": {"venue": {"fullName": "Ford Field"}},
            "injuries": [{"team": {"id": "10"}, "injuries": [
                {"status": "Out", "athlete": {"displayName": "Big Tackle", "position": {"abbreviation": "OT"}},
                 "details": {"type": "Knee"}}]}],
            "lastFiveGames": [{"team": {"id": "10"}, "events": [
                {"gameDate": "2026-10-04T17:00Z", "week": 4, "gameResult": "W", "score": "20-10",
                 "opponent": {"abbreviation": "XYZ"}, "atVs": "vs"}]}],
        }  # fmt: skip

    def nflverse_csv(self, name, season):
        if name == "snap_counts":
            return [snap_row("HOM", 4, "Big Tackle", 1.0)]
        return []


def test_build_assembles_a_game_from_stub_sources():
    data = briefing.build(StubSources(), 2026, 5, now=datetime(2026, 10, 8, tzinfo=UTC))
    g = data["games"][0]
    assert g["market"] > g["market_open"] > 0.5
    assert g["fpi"] == pytest.approx(0.61) and g["indoor"]
    tackle = g["home"]["injuries"][0]
    assert tackle["starter"] and tackle["played_last"] and tackle["unit"] == "OL"
    assert g["home"]["rest"] == 7 and g["home"]["results"][0]["res"] == "W"


def test_grade_uses_last_snapshot_before_kickoff(tmp_path):
    early = briefing.build(StubSources(), 2026, 5, now=datetime(2026, 10, 8, tzinfo=UTC))
    late = briefing.build(StubSources(), 2026, 5, now=datetime(2026, 10, 12, tzinfo=UTC))
    late["games"][0]["market"] = 0.2  # after kickoff: must be ignored
    for d in (early, late):
        history.save_snapshot(d, tmp_path)
    final = briefing.finals(StubSources("post").scoreboard(2026, 5), 2026, 5)
    res = history.grade_week(final, history.snapshots(2026, 5, tmp_path))
    g = res["games"][0]
    assert res["complete"] and g["fav"] == "home" and g["winner"] == "home"
    assert g["snapshot"] == early["generated"]
    history.save_results(res, tmp_path)
    assert history.ungraded_weeks(2026, tmp_path) == []


def test_render_embeds_data_safely(monkeypatch, tmp_path):
    from pickem import __main__ as cli

    monkeypatch.setattr(history, "HISTORY", tmp_path)
    data = {"season": 2026, "week": 5, "games": [{"note": "</script><b>"}]}
    html = cli.render(data)
    assert "</script><b>" not in html and "<\\/script><b>" in html
    assert "/*__DATA__*/null" not in html and "/*__SEASON__*/null" not in html
