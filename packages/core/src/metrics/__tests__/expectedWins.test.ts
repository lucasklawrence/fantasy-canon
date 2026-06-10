import { computeAllPlayRecord, computeExpectedWins, type WeeklyScore } from '../index.js';

// 4 teams, 2 weeks, distinct scores (no ties), every team plays every week.
// With an even team count the random pairing never byes, so each team's mean
// expected wins converges exactly to (all-play win rate × games):
//   team 1 outscores everyone both weeks      → 2.0
//   team 4 is outscored by everyone both weeks → 0.0
//   teams 2 and 3 each net 0.5 all-play       → 1.0  (genuine simulation variance)
const FIXTURE: WeeklyScore[] = [
  { week: 1, teamId: 1, score: 100 },
  { week: 1, teamId: 2, score: 90 },
  { week: 1, teamId: 3, score: 80 },
  { week: 1, teamId: 4, score: 70 },
  { week: 2, teamId: 1, score: 100 },
  { week: 2, teamId: 2, score: 85 },
  { week: 2, teamId: 3, score: 88 },
  { week: 2, teamId: 4, score: 60 },
];

const byTeam = (records: { teamId: number; expectedWins: number }[]) =>
  new Map(records.map((r) => [r.teamId, r.expectedWins]));

describe('computeExpectedWins', () => {
  it('is deterministic for a given seed', () => {
    const a = computeExpectedWins(FIXTURE, { seed: 7, iterations: 2000 });
    const b = computeExpectedWins(FIXTURE, { seed: 7, iterations: 2000 });
    expect(a).toEqual(b);
  });

  it('a different seed produces a (slightly) different sample', () => {
    const a = byTeam(computeExpectedWins(FIXTURE, { seed: 1, iterations: 500 }));
    const b = byTeam(computeExpectedWins(FIXTURE, { seed: 2, iterations: 500 }));
    // The dominant/bottom teams are deterministic (0 variance); the middle two
    // sample differently across seeds at low iteration counts.
    expect(a.get(2)).not.toBe(b.get(2));
  });

  it('converges to the analytical expectation (all-play win rate × games)', () => {
    const records = computeExpectedWins(FIXTURE, { seed: 7, iterations: 20000 });
    const exp = byTeam(records);

    // Schedule-proof extremes are exact (no pairing can change them).
    expect(exp.get(1)).toBe(2);
    expect(exp.get(4)).toBe(0);
    // Middle teams converge to 1.0 within Monte Carlo tolerance.
    expect(exp.get(2)).toBeCloseTo(1, 1);
    expect(exp.get(3)).toBeCloseTo(1, 1);

    // Cross-check against the analytical target derived from the all-play record:
    // expected wins == win% × games when every week is full (no byes).
    const allPlay = new Map(computeAllPlayRecord(FIXTURE).map((r) => [r.teamId, r.winPct]));
    for (const rec of records) {
      const analytical = (allPlay.get(rec.teamId) ?? 0) * rec.games;
      expect(rec.expectedWins).toBeCloseTo(analytical, 1);
    }
  });

  it('reports games as the number of weeks a team appears', () => {
    const records = computeExpectedWins(FIXTURE, { seed: 7, iterations: 100 });
    expect(records.every((r) => r.games === 2)).toBe(true);
  });

  it('handles an empty schedule', () => {
    expect(computeExpectedWins([], { iterations: 100 })).toEqual([]);
  });
});
