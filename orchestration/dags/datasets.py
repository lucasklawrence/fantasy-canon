"""Shared Airflow Datasets that chain the data pipeline into one flow (issue #12).

The pipeline is four DAGs -- ``espn_ingest`` -> ``normalize`` -> ``storylines`` ->
``weekly_throwback`` -- and used to need a manual trigger each. These datasets wire them together
with Airflow's data-aware scheduling: a producer DAG lists a dataset as a task ``outlets``, a
consumer DAG sets ``schedule=[dataset]``, so finishing one stage automatically triggers the next.
Trigger ``espn_ingest`` once and the whole thing cascades.

Each stage emits its dataset from its **terminal** task -- and for ``normalize`` / ``storylines``
that terminal task is the **data-quality gate**. So the dataset fires (and the next stage runs)
only when the stage passed its quality checks: a bad load halts the cascade instead of feeding
downstream. Each DAG also stays independently triggerable/backfillable on its own.

The URIs are opaque labels Airflow keys events on (not filesystem paths); they mirror the derived
data roots each stage writes.
"""

from __future__ import annotations

from airflow.datasets import Dataset

SNAPSHOTS_DATASET = Dataset("fantasy-canon://snapshots")  # produced by espn_ingest
NORMALIZED_DATASET = Dataset("fantasy-canon://normalized")  # produced by normalize (via DQ gate)
STORYLINES_DATASET = Dataset("fantasy-canon://storylines")  # produced by storylines (via DQ gate)
