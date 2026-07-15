import { describe, expect, it } from 'vitest';
import { type DraftPick } from '../../rankings/bestAvailable.js';
import { type PlayerTier } from '../../rankings/parse.js';
import { applyPicks, createDraftSession, type DraftSession } from '../session.js';
import { buildAdviceView } from '../advice.js';

function tier(name: string, position: PlayerTier['position'], adp: number): PlayerTier {
  return { name, position, adp, source: 'test' };
}

// A tiny 4-team league with one starter per position, so the snake math is easy to hand-check.
const POOL: PlayerTier[] = [
  tier('A', 'RB', 1),
  tier('B', 'WR', 2),
  tier('C', 'RB', 3),
  tier('D', 'QB', 4),
  tier('E', 'WR', 5),
  tier('F', 'TE', 6),
  tier('G', 'RB', 7),
  tier('H', 'WR', 8),
];

function session(): DraftSession {
  return createDraftSession({
    leagueSize: 4,
    myTeamId: 2,
    rosterSlots: { RB: 1, WR: 1, QB: 1, TE: 1 },
  });
}

const pick = (overall: number, playerName: string): DraftPick => ({
  overall,
  teamId: 0,
  playerName,
});

describe('buildAdviceView', () => {
  it('recommends best-available, attributes your roster by slot, and computes needs', () => {
    // Slot 2's overalls in a 4-team snake are [2, 7, 10, 15]. Pick 2 (WR "B") is ours.
    const s = applyPicks(session(), [pick(1, 'A'), pick(2, 'B'), pick(3, 'C')]);
    const view = buildAdviceView(s, POOL, { alternatives: 5 });

    expect(view.currentOverall).toBe(4);
    expect(view.isMyPick).toBe(false); // slot 4 is on the clock
    expect(view.onTheClockSlot).toBe(4);
    expect(view.myNextOverall).toBe(7);
    expect(view.picksUntilMine).toBe(3);

    // Board is ADP-sorted best-first; A/B/C are gone, so D (adp 4) leads.
    expect(view.recommended?.name).toBe('D');
    expect(view.recommended?.position).toBe('QB');
    expect(view.alternatives.map((c) => c.name)).toEqual(['E', 'F', 'G', 'H']);
    expect(view.remaining).toBe(5);
    expect(view.poolSize).toBe(8);

    // WR is filled (we took B); RB/TE/QB starters are still open.
    expect(view.needs).toEqual(['RB', 'TE', 'QB']);
    expect(view.byNeed.map((n) => [n.position, n.candidate.name])).toEqual([
      ['RB', 'G'],
      ['TE', 'F'],
      ['QB', 'D'],
    ]);

    // Only overall 2 is ours; it lands on the roster tagged with its pool position.
    expect(view.myRoster).toEqual([{ position: 'WR', name: 'B', overall: 2 }]);

    // Newest-first, with our own pick flagged.
    expect(view.recentPicks.map((p) => [p.overall, p.mine])).toEqual([
      [3, false],
      [2, true],
      [1, false],
    ]);
  });

  it('flags your turn when your slot is on the clock', () => {
    const s = applyPicks(session(), [pick(1, 'A')]); // overall 2 is up → slot 2 → us
    const view = buildAdviceView(s, POOL);

    expect(view.isMyPick).toBe(true);
    expect(view.myNextOverall).toBe(2);
    expect(view.picksUntilMine).toBe(0);
    expect(view.recommended?.name).toBe('B'); // A gone, B (adp 2) is best available
  });

  it('handles an empty pool without throwing', () => {
    const view = buildAdviceView(session(), []);
    expect(view.recommended).toBeUndefined();
    expect(view.alternatives).toEqual([]);
    expect(view.remaining).toBe(0);
  });

  it('clamps the clock and flags complete when the board is full', () => {
    // 2-team, 1 RB + 1 WR → 2 rounds, 4 total picks. Fill every one.
    const s = createDraftSession({ leagueSize: 2, myTeamId: 1, rosterSlots: { RB: 1, WR: 1 } });
    const pool = [tier('A', 'RB', 1), tier('B', 'WR', 2), tier('C', 'RB', 3), tier('D', 'WR', 4)];
    const full = applyPicks(s, [pick(1, 'A'), pick(2, 'B'), pick(3, 'C'), pick(4, 'D')]);
    const view = buildAdviceView(full, pool);

    expect(view.complete).toBe(true);
    expect(view.currentOverall).toBe(4); // clamped to the last pick, not a phantom 5
    expect(view.round).toBe(2); // not 3
    expect(view.pickInRound).toBe(2);
    expect(view.isMyPick).toBe(false); // draft's over, never "your pick"
    expect(view.recommended).toBeUndefined();
  });
});
