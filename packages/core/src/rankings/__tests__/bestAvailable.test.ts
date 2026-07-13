import { bestAvailable, type DraftState } from '../bestAvailable.js';
import type { PlayerTier } from '../parse.js';

function rb(name: string, adp: number, tier?: number): PlayerTier {
  return { name, position: 'RB', adp, tier, source: 'test' };
}
function wr(name: string, adp: number): PlayerTier {
  return { name, position: 'WR', adp, source: 'test' };
}

/** 2-team league, one RB + one WR starter, no flex — keeps replacement math hand-checkable. */
function state(overrides: Partial<DraftState> = {}): DraftState {
  return {
    leagueSize: 2,
    rosterSlots: { RB: 1, WR: 1 },
    scoring: 'ppr',
    myTeamId: 1,
    picks: [],
    myUpcomingOveralls: [1, 4],
    ...overrides,
  };
}

describe('bestAvailable', () => {
  it('computes VOR against the replacement-level player at the position', () => {
    // RBs sorted by ADP: A(1) B(2) C(3) D(4). startRank = leagueSize*1 = 2 → baseline = ADP of #2 = 2.
    // VORP baseline = rank 2+2 = 4 → ADP of #4 = 4.
    const pool = [rb('A', 1), rb('B', 2), rb('C', 3), rb('D', 4)];
    const result = bestAvailable(pool, state());
    const a = result.find((c) => c.name === 'A');
    expect(a).toMatchObject({ vor: 1, vorp: 3 });
    expect(result.find((c) => c.name === 'B')?.vor).toBe(0);
    expect(result.find((c) => c.name === 'C')?.vor).toBe(-1);
  });

  it('ranks best-first by draft value (effective ADP) across positions', () => {
    const pool = [rb('A', 1), rb('B', 2), wr('P', 1.5), wr('Q', 2.5)];
    const names = bestAvailable(pool, state()).map((c) => c.name);
    // Interleaved by ADP across positions, not clustered by position.
    expect(names).toEqual(['A', 'P', 'B', 'Q']);
  });

  it('excludes players already drafted (matched by normalized name)', () => {
    const pool = [rb('James Cook III', 1), rb('Other Back', 2)];
    const result = bestAvailable(
      pool,
      state({ picks: [{ overall: 1, teamId: 2, playerName: 'james cook' }] }),
    );
    expect(result.some((c) => c.name === 'James Cook III')).toBe(false);
    expect(result.some((c) => c.name === 'Other Back')).toBe(true);
  });

  it('tags a steep positional drop before your next pick as a reach', () => {
    // Only one good RB; the next RB who survives to pick 4 is way down at ADP 40 → big VONA.
    const pool = [rb('Scarce', 2), rb('FarOff', 40), wr('Filler', 3)];
    const result = bestAvailable(pool, state({ myUpcomingOveralls: [1, 4] }));
    const scarce = result.find((c) => c.name === 'Scarce');
    expect(scarce?.vona).toBeGreaterThanOrEqual(18);
    expect(scarce?.recommend).toBe('reach');
  });

  it('tags a player sliding well past the current pick as a value', () => {
    const pool = [rb('Anchor', 1), rb('Slider', 12)];
    const result = bestAvailable(pool, state({ picks: [], myUpcomingOveralls: [1, 2] }));
    // current overall = 1; Slider's ADP 12 is >= 1 + 6 → value.
    expect(result.find((c) => c.name === 'Slider')?.recommend).toBe('value');
  });

  it('tags a deep position with a comparable body next round as wait', () => {
    const pool = [wr('W1', 1.5), wr('W2', 2.5), wr('W3', 3.5), wr('W4', 4.5)];
    const result = bestAvailable(pool, state({ myUpcomingOveralls: [1, 4] }));
    // A comparable WR survives to pick 4, VONA stays small, and W1 isn't slipping → wait.
    expect(result.find((c) => c.name === 'W1')?.recommend).toBe('wait');
  });

  it('falls back to tier when ADP is missing', () => {
    const pool: PlayerTier[] = [
      { name: 'TierOnly', position: 'RB', tier: 1, source: 'test' },
      { name: 'Late', position: 'RB', tier: 5, source: 'test' },
    ];
    const result = bestAvailable(pool, state());
    // tier 1 ≈ pick 6 beats tier 5 ≈ pick 54 → ranked first.
    expect(result[0].name).toBe('TierOnly');
  });

  it('returns an empty array for an empty pool', () => {
    expect(bestAvailable([], state())).toEqual([]);
  });
});
