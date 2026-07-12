"""Unit tests for the throwback selection + bot-command helpers (issue #17)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dags"))

from throwback import (  # noqa: E402
    DEFAULT_THROWBACK_CMD,
    THROWBACK_POST_TYPES,
    build_throwback_command,
    select_post_type,
    select_throwback,
)

# ------------------------------------------------------------------------------- fixtures


def _rivalries() -> list[dict]:
    return [
        {"teamA": 1, "teamB": 2, "aWins": 1, "bWins": 1, "aPoints": 200.0, "bPoints": 190.0},
        # Most lopsided (differential 2) -- should win regardless of list order.
        {"teamA": 3, "teamB": 4, "aWins": 2, "bWins": 0, "aPoints": 150.0, "bPoints": 120.0},
    ]


def _waiver_spend() -> list[dict]:
    return [
        {"week": 1, "teamId": 1, "spend": 30.0},
        {"week": 2, "teamId": 2, "spend": 55.0},  # biggest splash
    ]


def _luck() -> list[dict]:
    return [
        {"teamId": 1, "luck": 0.5},
        {"teamId": 2, "luck": -1.25},  # most extreme (unlucky)
    ]


def _churn() -> list[dict]:
    return [
        {"teamId": 1, "moves": 4},
        {"teamId": 2, "moves": 9},  # most active
    ]


def _all_tables(**overrides) -> dict:
    tables = {
        "luck": _luck(),
        "churn": _churn(),
        "rivalries": _rivalries(),
        "waiver_spend": _waiver_spend(),
    }
    tables.update(overrides)
    return tables


# -------------------------------------------------------------------------------- rotation


def test_select_post_type_rotates_and_wraps():
    got = [select_post_type(i) for i in range(len(THROWBACK_POST_TYPES) + 1)]
    assert got[: len(THROWBACK_POST_TYPES)] == list(THROWBACK_POST_TYPES)
    assert got[-1] == THROWBACK_POST_TYPES[0]  # wraps around


# ---------------------------------------------------------------------- per-type selection


def test_selects_most_lopsided_rivalry():
    got = select_throwback("rivalry", **_all_tables())
    assert got["post_type"] == "rivalry"
    assert got["ref"] == "3:4"
    assert "Team 3 vs Team 4" in got["title"] and "(2-0)" in got["title"]


def test_selects_biggest_waiver_splash():
    got = select_throwback("waiver_legend", **_all_tables())
    assert got["post_type"] == "waiver_legend"
    assert got["ref"] == "2:2"  # week 2, team 2
    assert "$55" in got["title"] and "week 2" in got["title"]


def test_selects_most_extreme_luck_and_labels_unlucky():
    got = select_throwback("luck", **_all_tables())
    assert got["post_type"] == "luck"
    assert got["ref"] == "2"
    assert got["title"].startswith("Unluckiest")
    assert "-1.25" in got["title"]


def test_selects_most_active_roster_for_churn():
    got = select_throwback("churn", **_all_tables())
    assert got["post_type"] == "churn"
    assert got["ref"] == "2"
    assert "9 roster moves" in got["title"]


# ---------------------------------------------------------------------- fall-through & empty


def test_falls_through_to_next_type_with_data():
    # Rotation lands on waiver_legend, but that table is empty -> fall through to luck.
    got = select_throwback("waiver_legend", **_all_tables(waiver_spend=[], rivalries=[]))
    assert got is not None
    assert got["post_type"] == "luck"  # next non-empty after waiver_legend in the rotation


def test_returns_none_when_every_table_is_empty():
    assert select_throwback("rivalry", luck=[], churn=[], rivalries=[], waiver_spend=[]) is None


def test_rejects_an_unknown_post_type():
    with pytest.raises(ValueError, match="post_type must be one of"):
        select_throwback("nope", **_all_tables())


# ------------------------------------------------------------------------ command builder


def test_build_throwback_command_shape_and_quoting():
    cmd = build_throwback_command(
        base_cmd=DEFAULT_THROWBACK_CMD,
        channel_id="123",
        post_type="rivalry",
        ref="3:4",
        season="2024",
        league_id="99",
    )
    assert cmd == (
        "pnpm --dir /opt/fantasy-canon/apps/bot run throwback -- "
        "--channel 123 --post-type rivalry --ref 3:4 --season 2024 --league 99"
    )


def test_build_throwback_command_omits_league_when_blank():
    cmd = build_throwback_command(
        base_cmd=DEFAULT_THROWBACK_CMD, channel_id="1", post_type="luck", ref="7", season="2024"
    )
    assert "--league" not in cmd


def test_build_throwback_command_validates_required_inputs():
    kwargs = dict(
        base_cmd=DEFAULT_THROWBACK_CMD, channel_id="1", post_type="luck", ref="7", season="2024"
    )
    with pytest.raises(ValueError, match="channel_id is required"):
        build_throwback_command(**{**kwargs, "channel_id": ""})
    with pytest.raises(ValueError, match="post_type must be one of"):
        build_throwback_command(**{**kwargs, "post_type": "bogus"})
    with pytest.raises(ValueError, match="ref is required"):
        build_throwback_command(**{**kwargs, "ref": "  "})
    with pytest.raises(ValueError, match="season is required"):
        build_throwback_command(**{**kwargs, "season": ""})
