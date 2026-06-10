import {
  computeLineupEfficiency,
  type LineupPlayer,
  type StarterSlot,
} from '../lineupEfficiency.js';

// Slot ids mirror ESPN's: 0 QB, 2 RB, 4 WR, 6 TE, 23 FLEX (RB/WR/TE eligible).
const QB = 0;
const RB = 2;
const WR = 4;
const TE = 6;
const FLEX = 23;

describe('computeLineupEfficiency', () => {
  it('is perfectly efficient when the actual lineup is already optimal', () => {
    const slots: StarterSlot[] = [{ slotId: RB, count: 2 }];
    const players: LineupPlayer[] = [
      { playerId: 1, points: 20, eligibleSlots: [RB, FLEX], started: true },
      { playerId: 2, points: 15, eligibleSlots: [RB, FLEX], started: true },
      { playerId: 3, points: 5, eligibleSlots: [RB, FLEX], started: false },
    ];

    const result = computeLineupEfficiency(players, slots);
    expect(result.actualPoints).toBe(35);
    expect(result.optimalPoints).toBe(35);
    expect(result.pointsLeftOnBench).toBe(0);
    expect(result.efficiency).toBe(1);
  });

  it('detects points left on the bench when a benched player outscores a starter', () => {
    const slots: StarterSlot[] = [{ slotId: RB, count: 1 }];
    const players: LineupPlayer[] = [
      { playerId: 1, points: 8, eligibleSlots: [RB], started: true }, // started the worse RB
      { playerId: 2, points: 22, eligibleSlots: [RB], started: false }, // left the better one on the bench
    ];

    const result = computeLineupEfficiency(players, slots);
    expect(result.actualPoints).toBe(8);
    expect(result.optimalPoints).toBe(22);
    expect(result.pointsLeftOnBench).toBe(14);
    expect(result.efficiency).toBeCloseTo(8 / 22);
  });

  it('optimally fills a FLEX without stranding a dedicated slot (matroid, not greedy)', () => {
    // The greedy trap: P1 is eligible for both QB and FLEX and is the highest scorer.
    // A naive "seat the best player in any eligible seat" could put P1 in FLEX, leaving
    // the QB seat empty (P2 is RB-only). The correct optimum seats P1 at QB and P2 at FLEX.
    const slots: StarterSlot[] = [
      { slotId: QB, count: 1 },
      { slotId: FLEX, count: 1 },
    ];
    const players: LineupPlayer[] = [
      { playerId: 1, points: 30, eligibleSlots: [QB, FLEX], started: true },
      { playerId: 2, points: 18, eligibleSlots: [RB, FLEX], started: true },
    ];

    const result = computeLineupEfficiency(players, slots);
    expect(result.optimalPoints).toBe(48);
  });

  it('handles a full standard lineup with FLEX competition across positions', () => {
    const slots: StarterSlot[] = [
      { slotId: QB, count: 1 },
      { slotId: RB, count: 2 },
      { slotId: WR, count: 2 },
      { slotId: TE, count: 1 },
      { slotId: FLEX, count: 1 },
    ];
    const players: LineupPlayer[] = [
      { playerId: 1, points: 25, eligibleSlots: [QB], started: true },
      { playerId: 2, points: 20, eligibleSlots: [RB, FLEX], started: true },
      { playerId: 3, points: 18, eligibleSlots: [RB, FLEX], started: true },
      { playerId: 4, points: 17, eligibleSlots: [WR, FLEX], started: true },
      { playerId: 5, points: 16, eligibleSlots: [WR, FLEX], started: true },
      { playerId: 6, points: 12, eligibleSlots: [TE, FLEX], started: true },
      // Bench: a strong RB who should claim FLEX over the started TE-as-flex options.
      { playerId: 7, points: 19, eligibleSlots: [RB, FLEX], started: false },
      { playerId: 8, points: 3, eligibleSlots: [WR, FLEX], started: false },
    ];

    // Actual started: 25+20+18+17+16+12 = 108.
    // Optimal: QB 25, RB 20+18, WR 17+16, TE 12, FLEX = best remaining eligible = bench RB 19 → 127.
    const result = computeLineupEfficiency(players, slots);
    expect(result.actualPoints).toBe(108);
    expect(result.optimalPoints).toBe(127);
    expect(result.pointsLeftOnBench).toBe(19);
  });

  it('ignores players eligible for no starting slot', () => {
    const slots: StarterSlot[] = [{ slotId: RB, count: 1 }];
    const players: LineupPlayer[] = [
      { playerId: 1, points: 10, eligibleSlots: [RB], started: true },
      { playerId: 2, points: 99, eligibleSlots: [], started: false }, // e.g. bench/IR-only
    ];

    const result = computeLineupEfficiency(players, slots);
    expect(result.optimalPoints).toBe(10);
    expect(result.pointsLeftOnBench).toBe(0);
  });

  it('reports zero points and full efficiency for an all-zero week', () => {
    const slots: StarterSlot[] = [{ slotId: RB, count: 1 }];
    const players: LineupPlayer[] = [
      { playerId: 1, points: 0, eligibleSlots: [RB], started: true },
      { playerId: 2, points: 0, eligibleSlots: [RB], started: false },
    ];

    const result = computeLineupEfficiency(players, slots);
    expect(result.optimalPoints).toBe(0);
    expect(result.efficiency).toBe(1);
  });

  it('returns zeros when there are no starting slots', () => {
    const players: LineupPlayer[] = [
      { playerId: 1, points: 10, eligibleSlots: [RB], started: false },
    ];
    expect(computeLineupEfficiency(players, [])).toEqual({
      actualPoints: 0,
      optimalPoints: 0,
      pointsLeftOnBench: 0,
      efficiency: 1,
    });
  });
});
