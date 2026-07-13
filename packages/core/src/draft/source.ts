/**
 * The seam between "where picks come from" and the pure session reducer. A {@link DraftSource}
 * exposes the picks it currently knows about; a driver polls it, {@link diffNewPicks | diffs} the
 * snapshot against what the session has already seen, and applies only the fresh ones. Manual entry
 * and an ESPN DOM capture are both just `DraftSource`s — the engine can't tell them apart.
 *
 * Pull, not push: `poll()` returns the full ordered board known so far and must be idempotent, so a
 * source that re-reports everything each tick (a DOM scraper, a sink buffer) is safe to call in a
 * loop.
 */

import type { DraftPick } from '../rankings/bestAvailable.js';
import { normalizeName } from '../rankings/parse.js';

export interface DraftSnapshot {
  /** Every pick the source currently knows, in any order (diffed by name, sorted by overall). */
  picks: DraftPick[];
  /** Overall pick on the clock, if the source can tell. */
  onTheClock?: number;
  /** The source believes the draft is finished. */
  complete?: boolean;
}

export interface DraftSource {
  /** Stable label for logs/UX, e.g. `'manual'` or `'espn-dom'`. */
  readonly kind: string;
  /** Current known board. Called repeatedly; must be cheap and idempotent. */
  poll(): DraftSnapshot | Promise<DraftSnapshot>;
}

/**
 * Picks in `snapshot` that aren't already known, ascending by overall. `knownKeys` are normalized
 * names (e.g. `session.draftedKeys`); duplicates within the snapshot are also collapsed.
 */
export function diffNewPicks(
  knownKeys: ReadonlySet<string>,
  snapshot: readonly DraftPick[],
): DraftPick[] {
  const seen = new Set(knownKeys);
  const fresh: DraftPick[] = [];
  for (const pick of [...snapshot].sort((a, b) => a.overall - b.overall)) {
    const key = normalizeName(pick.playerName);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    fresh.push(pick);
  }
  return fresh;
}
