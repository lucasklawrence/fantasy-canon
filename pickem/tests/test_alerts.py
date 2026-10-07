import copy
from datetime import UTC, datetime

from pickem import alerts, fantasy

NOW = datetime(2026, 10, 11, 12, tzinfo=UTC)


def entry(pid, name, slot, proj, status="ACTIVE", team=1, eligible=(2, 23)):
    return {
        "lineupSlotId": slot,
        "playerPoolEntry": {
            "player": {
                "id": pid, "fullName": name, "injuryStatus": status, "proTeamId": team,
                "eligibleSlots": list(eligible) + [20, 21],
                "stats": [{"scoringPeriodId": 5, "statSourceId": 1, "appliedTotal": proj}],
            }
        },
    }  # fmt: skip


def league(entries):
    def team(tid, name, w, l, pf, seed, roster=()):
        return {
            "id": tid, "name": name, "playoffSeed": seed, "roster": {"entries": list(roster)},
            "record": {"overall": {"wins": w, "losses": l, "ties": 0, "pointsFor": pf, "pointsAgainst": 300.0}},
        }  # fmt: skip

    return {
        "id": 99,
        "settings": {"name": " Test League", "scheduleSettings": {"playoffTeamCount": 4}},
        "status": {"currentMatchupPeriod": 5},
        "teams": [team(4, "Mine", 1, 3, 379.0, 9, entries), team(1, "Rival", 3, 1, 400.0, 1)],
        "schedule": [
            {"matchupPeriodId": 4, "winner": "HOME", "home": {"teamId": 4, "totalPoints": 128.1},
             "away": {"teamId": 1, "totalPoints": 118.0}},
            {"matchupPeriodId": 5, "home": {"teamId": 1, "totalPoints": 0}, "away": {"teamId": 4, "totalPoints": 0, "totalProjectedPoints": 111.04, "winProbability": 0.42}},
        ],
    }  # fmt: skip


KICKOFFS = {"1": "2026-10-11T17:00Z", "2": "2026-10-11T17:00Z", "3": "2026-10-09T00:15Z"}  # team 3 played Thu


def test_lineup_flags_bye_out_and_better_bench_but_skips_locked_players():
    roster = [
        entry(1, "Bye Guy", 2, 12.0, team=9),  # no game this week
        entry(2, "Hurt Guy", 23, 14.0, status="OUT"),
        entry(3, "Maybe Guy", 2, 15.0, status="QUESTIONABLE"),
        entry(4, "Thursday Guy", 4, 0.0, status="OUT", team=3, eligible=(4, 23)),  # already locked
        entry(5, "Bench Star", 20, 13.0),
    ]
    t = fantasy.summarize(league(roster), 4, 5, KICKOFFS, NOW)
    texts = [i["text"] for i in t["issues"]]
    assert any("Bye Guy (RB) is on bye" in x for x in texts)
    assert any("Hurt Guy (FLEX) is out" in x for x in texts)
    assert any("Maybe Guy (RB) is questionable" in x for x in texts)
    assert not any("Thursday Guy" in x for x in texts)
    assert any("Bench Star (13.0) projects above Bye Guy (0)" in x for x in texts)


def test_summary_record_matchup_and_last_result():
    t = fantasy.summarize(league([entry(1, "A", 2, 10.0)]), 4, 5, KICKOFFS, NOW)
    assert t["league"] == "Test League" and t["record"] == "1-3" and t["pf_rank"] == 2
    assert t["last"] == {"opp": "Rival", "score": 128.1, "opp_score": 118.0, "won": True}
    assert t["matchup"]["opp"] == "Rival" and t["matchup"]["proj"] == 111.0  # ESPN's projection wins
    assert t["matchup"]["win_prob"] == 42  # ESPN reports a fraction


def test_leagues_and_credentials_come_from_env():
    env = {"PICKEM_LEAGUES": "11111111:4, 2222222222:1", "ESPN_S2": "x", "ESPN_SWID": "{y}"}
    assert fantasy.leagues_from_env(env) == [("11111111", 4), ("2222222222", 1)]
    assert fantasy.credentials(env) == ("x", "{y}")
    assert fantasy.my_teams(2026, 5, {"events": []}, NOW, env={}) == []


def briefing(market=0.6, status="Questionable"):
    inj = {"name": "Big Tackle", "pos": "OT", "unit": "OL", "status": status, "starter": True}
    return {
        "week": 5,
        "games": [{
            "id": "1", "status": "pre", "market": market,
            "away": {"abbr": "AWY", "injuries": []},
            "home": {"abbr": "HOM", "injuries": [inj]},
        }],
    }  # fmt: skip


def test_news_changes_catch_worse_status_and_line_moves_only():
    prev = briefing()
    cur = briefing(market=0.45, status="Out")
    found = alerts.news_changes(prev, cur)
    texts = " ".join(a["text"] for a in found)
    assert "Questionable → **Out**" in texts and "hurts the favorite" not in texts  # away now favored
    assert "Favorite flipped" in texts
    assert alerts.news_changes(cur, copy.deepcopy(cur)) == []  # no change, no alert
    assert alerts.news_changes(briefing(status="Out"), briefing(status="Questionable")) == []  # improvement


def test_unsent_dedupes_by_key_and_chunks_respect_discord_limit():
    a = [{"key": "k1"}, {"key": "k1"}, {"key": "k2"}]
    assert alerts.unsent(a, {"sent": ["k2"]}) == [{"key": "k1"}]
    parts = alerts.chunks("\n".join(["x" * 100] * 50))
    assert len(parts) > 1 and all(len(p) <= 1900 for p in parts)
