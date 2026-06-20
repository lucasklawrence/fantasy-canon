"""Unit tests for the airflow-free broadcast command builder."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make the DAGs importable without an Airflow scheduler on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dags"))

from canon_broadcast import build_broadcast_command  # noqa: E402


def test_builds_command_with_all_args():
    cmd = build_broadcast_command(
        base_cmd="pnpm --dir /opt/canon/apps/bot run broadcast --",
        channel_id="12345",
        metric="power-ranking",
        season="2024",
        league_id="58246399",
    )
    assert cmd == (
        "pnpm --dir /opt/canon/apps/bot run broadcast -- "
        "--channel 12345 --metric power-ranking --season 2024 --league 58246399"
    )


def test_league_is_optional():
    cmd = build_broadcast_command(
        base_cmd="run broadcast --",
        channel_id="1",
        metric="standings",
        season="2024",
    )
    assert "--league" not in cmd
    assert cmd.endswith("--channel 1 --metric standings --season 2024")


def test_shell_quotes_injected_values():
    cmd = build_broadcast_command(
        base_cmd="run --",
        channel_id="1; rm -rf /",
        metric="standings",
        season="2024",
    )
    # The malicious channel id is quoted into a single safe argument.
    assert "'1; rm -rf /'" in cmd


@pytest.mark.parametrize(
    "kwargs",
    [
        {"base_cmd": "", "channel_id": "1", "metric": "standings", "season": "2024"},
        {"base_cmd": "x", "channel_id": "", "metric": "standings", "season": "2024"},
        {"base_cmd": "x", "channel_id": "1", "metric": "bogus", "season": "2024"},
        {"base_cmd": "x", "channel_id": "1", "metric": "standings", "season": ""},
    ],
)
def test_rejects_bad_input(kwargs):
    with pytest.raises(ValueError):
        build_broadcast_command(**kwargs)
