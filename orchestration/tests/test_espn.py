"""Unit tests for the ESPN URL builder (no network)."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dags"))

from espn import BASE_URL, build_view_url  # noqa: E402


def test_builds_season_level_url():
    assert build_view_url("12345", 2024, "mTeam") == (
        f"{BASE_URL}/apis/v3/games/ffl/seasons/2024/segments/0/leagues/12345?view=mTeam"
    )


def test_appends_scoring_period_when_given():
    url = build_view_url("12345", 2024, "mScoreboard", scoring_period=7)
    assert url.endswith("?view=mScoreboard&scoringPeriodId=7")


def test_honors_a_custom_base_url():
    url = build_view_url("1", 2024, "mTeam", base_url="https://example.test")
    assert url.startswith("https://example.test/apis/v3/games/ffl/seasons/2024/")
