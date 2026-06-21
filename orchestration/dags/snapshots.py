"""Idempotent, partitioned snapshot storage for raw ESPN payloads.

Layout — partitioned so a re-run/backfill overwrites the same file in place (the
idempotency contract the rest of the pipeline relies on):

    {root}/season={season}/{view}.json                      # season-level views
    {root}/season={season}/sp={scoring_period}/{view}.json  # per-week views

Writes are atomic (temp file + ``os.replace``) so a crashed task never leaves a
half-written snapshot for the normalize step to choke on. Stdlib only.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional


def snapshot_path(
    root: str,
    season: int,
    view: str,
    scoring_period: Optional[int] = None,
) -> Path:
    """Deterministic path for a (season, view[, scoring_period]) partition."""
    base = Path(root) / f"season={season}"
    if scoring_period is not None:
        base = base / f"sp={scoring_period}"
    return base / f"{view}.json"


def write_snapshot(
    root: str,
    season: int,
    view: str,
    payload: Any,
    scoring_period: Optional[int] = None,
) -> Path:
    """Atomically write a snapshot, overwriting any prior one for the partition."""
    path = snapshot_path(root, season, view, scoring_period)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, path)  # atomic on POSIX and Windows for same-filesystem renames
    return path


def read_snapshot(
    root: str,
    season: int,
    view: str,
    scoring_period: Optional[int] = None,
) -> Any:
    """Read a snapshot back as parsed JSON."""
    return json.loads(snapshot_path(root, season, view, scoring_period).read_text(encoding="utf-8"))
