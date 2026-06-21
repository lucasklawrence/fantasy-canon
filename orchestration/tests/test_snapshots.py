"""Unit tests for partitioned, idempotent snapshot storage."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dags"))

from snapshots import read_snapshot, snapshot_path, write_snapshot  # noqa: E402


def test_season_level_partition_path():
    p = snapshot_path("/root", 2024, "mTeam")
    assert p == Path("/root") / "season=2024" / "mTeam.json"


def test_week_level_partition_path():
    p = snapshot_path("/root", 2024, "mScoreboard", scoring_period=7)
    assert p == Path("/root") / "season=2024" / "sp=7" / "mScoreboard.json"


def test_write_then_read_roundtrips(tmp_path):
    payload = {"teams": [{"id": 1}], "season": 2024}
    path = write_snapshot(str(tmp_path), 2024, "mTeam", payload)
    assert path.exists()
    assert read_snapshot(str(tmp_path), 2024, "mTeam") == payload


def test_rewrite_is_idempotent_overwrite(tmp_path):
    write_snapshot(str(tmp_path), 2024, "mTeam", {"v": 1})
    write_snapshot(str(tmp_path), 2024, "mTeam", {"v": 2})
    # Second write wins; no leftover temp file in the partition dir.
    assert read_snapshot(str(tmp_path), 2024, "mTeam") == {"v": 2}
    files = sorted(p.name for p in (tmp_path / "season=2024").iterdir())
    assert files == ["mTeam.json"]


def test_week_snapshot_is_isolated_from_season_snapshot(tmp_path):
    write_snapshot(str(tmp_path), 2024, "mScoreboard", {"scope": "season"})
    write_snapshot(str(tmp_path), 2024, "mScoreboard", {"scope": "week7"}, scoring_period=7)
    assert read_snapshot(str(tmp_path), 2024, "mScoreboard") == {"scope": "season"}
    assert read_snapshot(str(tmp_path), 2024, "mScoreboard", scoring_period=7) == {"scope": "week7"}
