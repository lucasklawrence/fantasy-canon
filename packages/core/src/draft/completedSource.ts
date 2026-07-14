/**
 * A {@link DraftSource} over a **finished** draft: the whole board is known up front, so `poll()`
 * hands back every pick with `complete: true`. Feeding it through {@link applyPicks} replays a real
 * completed draft into a session, which is how we validate the recommendation engine against reality —
 * "would best-available have made these picks?" — and how an import command reconstructs a draft.
 *
 * Pure and I/O-free: it just holds the picks it was constructed with (the ESPN fetch + parse that
 * produces them lives in the app layer). Picks are copied and sorted by overall so the source is a
 * stable, idempotent snapshot regardless of input order.
 */

import type { DraftPick } from '../rankings/bestAvailable.js';
import type { DraftSnapshot, DraftSource } from './source.js';

export class CompletedDraftSource implements DraftSource {
  readonly kind = 'completed';
  private readonly picks: DraftPick[];

  constructor(picks: readonly DraftPick[]) {
    this.picks = [...picks].map((p) => ({ ...p })).sort((a, b) => a.overall - b.overall);
  }

  /** How many picks the completed draft holds. */
  get size(): number {
    return this.picks.length;
  }

  /** The finished board: every pick, ascending by overall, flagged complete. */
  poll(): DraftSnapshot {
    return { picks: this.picks.map((p) => ({ ...p })), complete: true };
  }
}
