import { computeAllPlayRecord, type WeeklyScore } from '../allPlay.js';

describe('computeAllPlayRecord', () => {
  it('compares each team against every other team within a week', () => {
    // One week, 4 teams, strictly ordered scores: 100 > 90 > 80 > 70.
    const scores: WeeklyScore[] = [
      { week: 1, teamId: 1, score: 100 },
      { week: 1, teamId: 2, score: 90 },
      { week: 1, teamId: 3, score: 80 },
      { week: 1, teamId: 4, score: 70 },
    ];

    const result = computeAllPlayRecord(scores);
    const byId = new Map(result.map((r) => [r.teamId, r]));

    // Top team beats all 3 others; bottom team loses to all 3.
    expect(byId.get(1)).toMatchObject({ wins: 3, losses: 0, ties: 0 });
    expect(byId.get(2)).toMatchObject({ wins: 2, losses: 1, ties: 0 });
    expect(byId.get(3)).toMatchObject({ wins: 1, losses: 2, ties: 0 });
    expect(byId.get(4)).toMatchObject({ wins: 0, losses: 3, ties: 0 });
    expect(byId.get(1)?.winPct).toBe(1);
    expect(byId.get(4)?.winPct).toBe(0);
  });

  it('aggregates across weeks', () => {
    const scores: WeeklyScore[] = [
      // Week 1: team 1 highest
      { week: 1, teamId: 1, score: 100 },
      { week: 1, teamId: 2, score: 50 },
      // Week 2: team 2 highest (schedule luck reversed)
      { week: 2, teamId: 1, score: 40 },
      { week: 2, teamId: 2, score: 90 },
    ];

    const result = computeAllPlayRecord(scores);
    const byId = new Map(result.map((r) => [r.teamId, r]));

    // Each team wins once and loses once across the two weeks → 50%.
    expect(byId.get(1)).toMatchObject({ wins: 1, losses: 1, ties: 0 });
    expect(byId.get(2)).toMatchObject({ wins: 1, losses: 1, ties: 0 });
    expect(byId.get(1)?.winPct).toBeCloseTo(0.5);
  });

  it('counts ties in the denominator but not as wins or losses', () => {
    const scores: WeeklyScore[] = [
      { week: 1, teamId: 1, score: 80 },
      { week: 1, teamId: 2, score: 80 },
      { week: 1, teamId: 3, score: 80 },
    ];

    const result = computeAllPlayRecord(scores);
    for (const rec of result) {
      expect(rec).toMatchObject({ wins: 0, losses: 0, ties: 2 });
      expect(rec.winPct).toBe(0);
    }
  });

  it('gives a team with no opponents a record but no comparisons', () => {
    const scores: WeeklyScore[] = [{ week: 1, teamId: 7, score: 123 }];
    const result = computeAllPlayRecord(scores);
    expect(result).toEqual([{ teamId: 7, wins: 0, losses: 0, ties: 0, winPct: 0 }]);
  });

  it('sorts by winPct desc, then wins desc, then teamId asc', () => {
    const scores: WeeklyScore[] = [
      { week: 1, teamId: 3, score: 100 },
      { week: 1, teamId: 1, score: 90 },
      { week: 1, teamId: 2, score: 90 },
    ];

    const result = computeAllPlayRecord(scores);
    // team 3 wins both (winPct 1). teams 1 and 2 each beat nobody, tie each other,
    // lose to 3 → identical records, so teamId ascending breaks the tie (1 before 2).
    expect(result.map((r) => r.teamId)).toEqual([3, 1, 2]);
  });

  it('returns an empty array for no scores', () => {
    expect(computeAllPlayRecord([])).toEqual([]);
  });
});
