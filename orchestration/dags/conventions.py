"""Cross-cutting conventions shared by the Fantasy Canon pipeline DAGs (issue #18).

Three things every data-pipeline DAG should do the same way:

1. **Retries / backoff / timeouts** (`pipeline_default_args`). ESPN's endpoints are unofficial
   and flaky, so a transient blip should be *retried with exponential backoff* rather than
   failing the run; a bounded `max_retry_delay` and per-task `execution_timeout` keep a wedged
   task from hanging forever.

2. **Idempotent partition-overwrite** (documented here; enforced by `normalize.write_table` +
   `normalize.clear_weekly_partitions`). Derived data is *dynamic* — ESPN revises last week's
   numbers for a day or two — so every load overwrites its `(season[, week])` partition whole,
   last-write-wins. Weekly tables clear before writing so a week that goes empty on a rerun
   doesn't leave a stale partition. A re-run or backfill therefore always converges to the same
   state as a fresh run.

3. **Data-quality gate** (`run_data_quality` + the `check_*` validators). A task that runs after
   the loads and *fails the DAG* if the output looks wrong (no rows, null ids, gaps in the week
   sequence) — so a bad load is caught loudly instead of silently feeding downstream.

Stdlib only, so the validators unit-test without Airflow.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any, Iterable

# ------------------------------------------------------------ retries / backoff / timeouts


def pipeline_default_args(
    *,
    retries: int = 3,
    retry_delay_minutes: int = 2,
    max_retry_delay_minutes: int = 30,
    execution_timeout_minutes: int = 30,
) -> dict:
    """Shared Airflow ``default_args`` for the data-pipeline DAGs.

    Exponential backoff (2m, 4m, 8m, … capped at ``max_retry_delay``) so a transient ESPN error
    is retried rather than fatal, without hammering the unofficial endpoints; a per-task
    ``execution_timeout`` so a hung fetch fails loudly instead of pinning a worker.
    """
    return {
        "retries": retries,
        "retry_delay": timedelta(minutes=retry_delay_minutes),
        "retry_exponential_backoff": True,
        "max_retry_delay": timedelta(minutes=max_retry_delay_minutes),
        "execution_timeout": timedelta(minutes=execution_timeout_minutes),
    }


# ---------------------------------------------------------------------------- schedule passes

# Intended production cadence for the pipeline **head**, ``espn_ingest``. The downstream stages
# (normalize -> storylines -> throwback) are dataset-triggered and cascade off it (see
# dags/datasets.py), so scheduling only the head schedules the whole pipeline. The head stays
# ``schedule=None`` (manual/triggered) for local-first, $0 dev (epic #12, orchestration/README.md);
# these constants define the passes so enabling them is a one-line change on ``espn_ingest``.
#
#   finalize — Tuesday 16:00 UTC: recompute the just-finished week once ESPN's stat corrections
#              (which settle Mon/Tue) have landed. This is the authoritative pass for a week.
#   refresh  — daily 12:00 UTC: refresh the in-progress current week so mid-week views aren't
#              stale. Idempotent overwrite means the finalize pass simply supersedes it.
SCHEDULE_FINALIZE = "0 16 * * 2"
SCHEDULE_REFRESH = "0 12 * * *"


# -------------------------------------------------------------------------- data-quality gate


class DataQualityError(ValueError):
    """Raised by the data-quality gate to fail the DAG run when a load looks wrong."""


def check_min_rows(rows: list, *, table: str, minimum: int = 1) -> list[str]:
    """Violation if a table has fewer than ``minimum`` rows (an empty load is usually a bug)."""
    if len(rows) < minimum:
        return [f"{table}: expected >= {minimum} row(s), got {len(rows)}"]
    return []


def check_no_null_fields(rows: list[dict], *, table: str, fields: Iterable[str]) -> list[str]:
    """Violation for every row missing (or None in) a required field -- e.g. a null team id."""
    fields = list(fields)
    violations: list[str] = []
    for i, row in enumerate(rows):
        for field in fields:
            if not isinstance(row, dict) or row.get(field) is None:
                violations.append(f"{table}[row {i}]: null/missing {field}")
    return violations


def check_contiguous_weeks(weeks_present: Iterable[Any], *, table: str) -> list[str]:
    """Violation if the weeks present have a gap -- i.e. some week in ``1..max`` is missing.

    A self-referential "expected weeks present" check: with no external season length to compare
    against, a hole in the sequence (week 3 missing while 1,2,4 exist) is the detectable signal
    that a load dropped a partition.
    """
    weeks = sorted({w for w in weeks_present if isinstance(w, int) and w >= 1})
    if not weeks:
        return []
    missing = sorted(set(range(1, weeks[-1] + 1)) - set(weeks))
    if missing:
        return [f"{table}: missing week(s) {missing} (have 1..{weeks[-1]})"]
    return []


def run_data_quality(*check_results: list[str]) -> None:
    """Aggregate ``check_*`` results and raise ``DataQualityError`` if any violations were found.

    Each argument is the list a ``check_*`` helper returned; passing them together lets the gate
    report *every* problem at once rather than failing on the first. No violations -> no-op.
    """
    violations = [v for result in check_results for v in result]
    if violations:
        raise DataQualityError("data-quality gate failed:\n  - " + "\n  - ".join(violations))
