import { computePowerRanking, type PowerRankingInput } from '../powerRanking.js';

describe('computePowerRanking', () => {
  it('computes the published composite score and ranks descending', () => {
    // One team, simple numbers to pin the formula:
    // avg=100, high=120, low=80, winPct=0.5
    // score = (100*6 + (120+80)*2 + 0.5*400) / 10 = (600 + 400 + 200) / 10 = 120
    const teams: PowerRankingInput[] = [
      { teamId: 1, weeklyScores: [80, 100, 120], wins: 1, losses: 1 },
    ];
    const [entry] = computePowerRanking(teams);
    expect(entry).toMatchObject({ teamId: 1, rank: 1, gap: 0 });
    expect(entry.avgScore).toBeCloseTo(100);
    expect(entry.highScore).toBe(120);
    expect(entry.lowScore).toBe(80);
    expect(entry.winPct).toBeCloseTo(0.5);
    expect(entry.score).toBeCloseTo(120);
  });

  it('orders teams by score and reports the gap to the team above', () => {
    const teams: PowerRankingInput[] = [
      { teamId: 1, weeklyScores: [150, 150], wins: 2, losses: 0 }, // strong
      { teamId: 2, weeklyScores: [90, 90], wins: 1, losses: 1 }, // middle
      { teamId: 3, weeklyScores: [50, 50], wins: 0, losses: 2 }, // weak
    ];
    const result = computePowerRanking(teams);
    expect(result.map((r) => r.teamId)).toEqual([1, 2, 3]);
    expect(result.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(result[0].gap).toBe(0);
    // Gaps are positive and equal the difference from the line above.
    expect(result[1].gap).toBeCloseTo(result[0].score - result[1].score);
    expect(result[2].gap).toBeCloseTo(result[1].score - result[2].score);
  });

  it('counts ties as half a win in win%', () => {
    const [entry] = computePowerRanking([
      { teamId: 1, weeklyScores: [100], wins: 1, losses: 1, ties: 2 },
    ]);
    // winPct = (1 + 2*0.5) / 4 = 0.5
    expect(entry.winPct).toBeCloseTo(0.5);
  });

  it('breaks score ties by teamId ascending with distinct sequential ranks', () => {
    const teams: PowerRankingInput[] = [
      { teamId: 5, weeklyScores: [100], wins: 1, losses: 1 },
      { teamId: 2, weeklyScores: [100], wins: 1, losses: 1 },
    ];
    const result = computePowerRanking(teams);
    expect(result.map((r) => r.teamId)).toEqual([2, 5]);
    expect(result.map((r) => r.rank)).toEqual([1, 2]);
    expect(result[0].score).toBeCloseTo(result[1].score);
  });

  it('handles a team with no games or scores without dividing by zero', () => {
    const [entry] = computePowerRanking([{ teamId: 1, weeklyScores: [], wins: 0, losses: 0 }]);
    expect(entry).toMatchObject({ score: 0, avgScore: 0, highScore: 0, lowScore: 0, winPct: 0 });
  });

  it('returns an empty array for no teams', () => {
    expect(computePowerRanking([])).toEqual([]);
  });
});
