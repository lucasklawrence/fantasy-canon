import type { DraftPick, PlayerTier } from '@fantasy-canon/core';
import { describe, expect, it } from 'vitest';
import { createDraftHub, type HubSnapshot } from '../hub.js';

const POOL: PlayerTier[] = [
  { name: 'A', position: 'RB', adp: 1, source: 'test' },
  { name: 'B', position: 'WR', adp: 2, source: 'test' },
  { name: 'C', position: 'RB', adp: 3, source: 'test' },
  { name: 'D', position: 'QB', adp: 4, source: 'test' },
];

const pick = (overall: number, playerName: string): DraftPick => ({
  overall,
  teamId: 0,
  playerName,
});

function hub() {
  return createDraftHub({
    leagueSize: 4,
    mySlot: 2,
    rosterSlots: { RB: 1, WR: 1, QB: 1, TE: 1 },
    pool: POOL,
  });
}

describe('createDraftHub', () => {
  it('projects an empty board and advances as picks are ingested', () => {
    const h = hub();
    const first = h.snapshot();
    expect(first.status).toBe('waiting for the first pick');
    expect(first.view.poolSize).toBe(4);
    expect(first.view.currentOverall).toBe(1);
    expect(h.nextOverall()).toBe(1);

    const result = h.ingest([pick(1, 'A')]);
    expect(result.added.map((p) => p.playerName)).toEqual(['A']);
    expect(result.picks).toBe(1);
    expect(h.nextOverall()).toBe(2);

    const after = h.snapshot();
    expect(after.status).toBe('watching draft');
    expect(after.view.remaining).toBe(3); // A is off the board
    expect(after.view.recentPicks[0]?.name).toBe('A');
  });

  it('is idempotent — re-ingesting a known pick adds nothing', () => {
    const h = hub();
    h.ingest([pick(1, 'A'), pick(2, 'B')]);
    const again = h.ingest([pick(1, 'A'), pick(2, 'B'), pick(3, 'C')]);
    expect(again.added.map((p) => p.playerName)).toEqual(['C']); // only the new one
    expect(again.picks).toBe(3);
  });

  it('notifies subscribers only when the board actually changes', () => {
    const h = hub();
    const seen: HubSnapshot[] = [];
    const off = h.subscribe((s) => seen.push(s));

    h.ingest([pick(1, 'A')]);
    expect(seen).toHaveLength(1);

    h.ingest([pick(1, 'A')]); // duplicate → no change → no notify
    expect(seen).toHaveLength(1);

    off();
    h.ingest([pick(2, 'B')]);
    expect(seen).toHaveLength(1); // unsubscribed
  });

  it('reset clears the board and notifies', () => {
    const h = hub();
    h.ingest([pick(1, 'A')]);
    const seen: HubSnapshot[] = [];
    h.subscribe((s) => seen.push(s));

    h.reset();
    expect(seen).toHaveLength(1);
    expect(h.snapshot().view.currentOverall).toBe(1);
    expect(h.nextOverall()).toBe(1);
    expect(h.snapshot().view.remaining).toBe(4); // whole pool back on the board
  });
});
