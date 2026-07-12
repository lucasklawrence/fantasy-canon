"""Unit tests for the shared pipeline conventions (default_args + data-quality gate)."""

from __future__ import annotations

import sys
from datetime import timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dags"))

from conventions import (  # noqa: E402
    SCHEDULE_FINALIZE,
    SCHEDULE_REFRESH,
    DataQualityError,
    check_contiguous_weeks,
    check_min_rows,
    check_no_null_fields,
    pipeline_default_args,
    run_data_quality,
)

# ------------------------------------------------------------------------- default_args


def test_pipeline_default_args_has_bounded_exponential_backoff_and_timeout():
    args = pipeline_default_args()
    assert args["retries"] == 3
    assert args["retry_exponential_backoff"] is True
    assert args["retry_delay"] == timedelta(minutes=2)
    assert args["max_retry_delay"] == timedelta(minutes=30)
    assert args["execution_timeout"] == timedelta(minutes=30)


def test_pipeline_default_args_overrides():
    args = pipeline_default_args(retries=5, retry_delay_minutes=1, execution_timeout_minutes=10)
    assert args["retries"] == 5
    assert args["retry_delay"] == timedelta(minutes=1)
    assert args["execution_timeout"] == timedelta(minutes=10)


def test_schedule_passes_are_defined():
    assert SCHEDULE_FINALIZE == "0 16 * * 2"  # Tuesday 16:00 UTC
    assert SCHEDULE_REFRESH == "0 12 * * *"  # daily 12:00 UTC


# ---------------------------------------------------------------------------- validators


def test_check_min_rows():
    assert check_min_rows([{"a": 1}], table="teams") == []
    assert check_min_rows([], table="teams") == ["teams: expected >= 1 row(s), got 0"]
    assert check_min_rows([{"a": 1}], table="teams", minimum=2) == [
        "teams: expected >= 2 row(s), got 1"
    ]


def test_check_no_null_fields_flags_missing_and_none():
    rows = [{"teamId": 1, "week": 1}, {"teamId": None, "week": 2}, {"week": 3}]
    violations = check_no_null_fields(rows, table="scores", fields=["teamId"])
    assert violations == [
        "scores[row 1]: null/missing teamId",
        "scores[row 2]: null/missing teamId",
    ]


def test_check_no_null_fields_clean():
    rows = [{"teamId": 1}, {"teamId": 2}]
    assert check_no_null_fields(rows, table="teams", fields=["teamId"]) == []


def test_check_contiguous_weeks_detects_a_gap():
    assert check_contiguous_weeks([1, 2, 3], table="scores") == []
    assert check_contiguous_weeks([1, 2, 4], table="scores") == [
        "scores: missing week(s) [3] (have 1..4)"
    ]
    assert check_contiguous_weeks([], table="scores") == []  # nothing loaded yet -> not a gap


# ------------------------------------------------------------------------------ the gate


def test_run_data_quality_passes_when_all_clean():
    # Should not raise.
    run_data_quality(
        check_min_rows([{"teamId": 1}], table="teams"),
        check_no_null_fields([{"teamId": 1}], table="teams", fields=["teamId"]),
    )


def test_run_data_quality_raises_on_a_broken_load_and_aggregates_all_violations():
    with pytest.raises(DataQualityError) as excinfo:
        run_data_quality(
            check_min_rows([], table="teams"),
            check_no_null_fields([{"teamId": None}], table="teams", fields=["teamId"]),
            check_contiguous_weeks([1, 3], table="scores"),
        )
    message = str(excinfo.value)
    # Every problem is reported, not just the first.
    assert "teams: expected >= 1 row(s), got 0" in message
    assert "null/missing teamId" in message
    assert "missing week(s) [2]" in message
