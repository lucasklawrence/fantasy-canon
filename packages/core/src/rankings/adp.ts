/**
 * Join live market ADP onto a research-derived draft pool, returning a deeper, market-priced
 * board. Pure and deterministic — no I/O; the caller fetches ADP (side-effectful, so it lives
 * in `apps/*`, see `apps/bot/src/lib/ffcAdp.ts`) and passes the normalized rows in here.
 *
 * Our research pool is small and hand-curated (tiers, scouting notes) but sparse — it runs out
 * a few rounds deep. A market ADP feed covers ~200 players drawn from thousands of real mock
 * drafts. Merging the two gives the recommendation engine a full-depth board where:
 *   - players we have research on keep their tier/note and gain the *real* market ADP, and
 *   - players we have no research on are added, so the board reaches the late rounds.
 *
 * Matching is by normalized name + position, so generational suffixes ("Jr."/"III") and
 * punctuation don't block a join (see {@link normalizeName}). A player the two sources list at
 * different positions won't merge and will appear once per source-position — that's rare and
 * strictly preferable to a wrong cross-position merge.
 */

import type { PlayerTier, Position } from './parse.js';
import { normalizeName } from './parse.js';

/** A single player's market ADP, normalized from a feed (e.g. FantasyFootballCalculator). */
export interface AdpRow {
  name: string;
  position: Position;
  team?: string;
  /** Overall ADP (average pick number) for our league format; lower = drafted earlier. */
  adp: number;
  /** Standard deviation of draft slot — how contested/uncertain the pick is. */
  stdDev?: number;
  /** Earliest (lowest number) slot the player has been drafted. */
  high?: number;
  /** Latest (highest number) slot the player has been drafted. */
  low?: number;
}

/**
 * Merge market ADP into a research pool. Returns a new pool (the input is never mutated):
 * matched research players get the real `adp` (and a `team` if they lacked one); unmatched ADP
 * rows are appended as bare {@link PlayerTier}s so the board runs the full draft deep.
 */
export function mergeAdpIntoPool(pool: PlayerTier[], adp: AdpRow[]): PlayerTier[] {
  const keyOf = (name: string, position: Position): string => `${normalizeName(name)}|${position}`;

  const adpByKey = new Map<string, AdpRow>();
  for (const row of adp) {
    const key = keyOf(row.name, row.position);
    // First row wins on a duplicate key — feeds are already deduped, this is just defensive.
    if (!adpByKey.has(key)) adpByKey.set(key, row);
  }

  const seen = new Set<string>();
  const merged: PlayerTier[] = pool.map((player) => {
    const key = keyOf(player.name, player.position);
    seen.add(key);
    const row = adpByKey.get(key);
    if (!row) return player;
    // Real market ADP overrides the research board's approximate estimate; the research signal
    // (tier, tierLabel, note, source) is preserved.
    return { ...player, adp: row.adp, team: player.team ?? row.team };
  });

  for (const row of adp) {
    const key = keyOf(row.name, row.position);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({
      name: row.name,
      position: row.position,
      team: row.team,
      adp: row.adp,
      source: 'ffc-adp',
    });
  }

  return merged;
}
