/**
 * The manual {@link DraftSource}: picks you type in. Zero ToS risk, works with any draft (mock or
 * real, ESPN or elsewhere), and is the fallback whenever automated capture isn't wired up. Pure —
 * it just accumulates picks in memory and hands them back on {@link ManualDraftSource.poll}.
 */

import type { DraftPick } from '../rankings/bestAvailable.js';
import type { DraftSnapshot, DraftSource } from './source.js';

export class ManualDraftSource implements DraftSource {
  readonly kind = 'manual';
  private readonly picks: DraftPick[] = [];

  /** Record the next pick. `overall` defaults to the running count, so callers can just add names. */
  add(playerName: string, options: { teamId?: number; overall?: number } = {}): DraftPick {
    const name = playerName.trim();
    const pick: DraftPick = {
      overall: options.overall ?? this.picks.length + 1,
      teamId: options.teamId ?? 0,
      playerName: name,
    };
    this.picks.push(pick);
    return pick;
  }

  /** How many picks have been entered. */
  get size(): number {
    return this.picks.length;
  }

  poll(): DraftSnapshot {
    return { picks: this.picks.map((p) => ({ ...p })) };
  }
}
