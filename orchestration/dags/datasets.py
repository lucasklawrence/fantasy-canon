"""Shared Airflow Datasets that chain the **data** pipeline into one flow (issue #12).

The data stages -- ``espn_ingest`` -> ``normalize`` -> ``storylines`` -- used to need a manual
trigger each. These datasets wire them together with Airflow's data-aware scheduling: a producer
DAG lists a dataset as a task ``outlets``, the consumer DAG sets ``schedule=[dataset]``, so
finishing one stage automatically triggers the next. Trigger ``espn_ingest`` once and the data
pipeline cascades to fresh storyline tables.

``normalize`` emits its dataset from its **data-quality gate** task, so the next stage runs only
when the stage passed its checks: a bad load halts the cascade instead of feeding downstream. Each
DAG also stays independently triggerable/backfillable on its own.

The **posting** DAGs (``weekly_throwback``, ``weekly_broadcast``) are deliberately *not* chained on
these datasets -- they stay time-scheduled and read the latest tables. Data-triggering a poster
would break its once-a-week contract (a daily head refresh would re-post the same week repeatedly).

The URIs are opaque labels Airflow keys events on (not filesystem paths); they mirror the derived
data roots each stage writes.
"""

from __future__ import annotations

from airflow.datasets import Dataset

SNAPSHOTS_DATASET = Dataset("fantasy-canon://snapshots")  # produced by espn_ingest
NORMALIZED_DATASET = Dataset("fantasy-canon://normalized")  # produced by normalize (via DQ gate)
