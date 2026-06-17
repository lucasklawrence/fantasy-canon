import { computeSeasonAwards, type SeasonTeamSummary } from '../seasonAwards.js';

function awardWinner(
  awards: ReturnType<typeof computeSeasonAwards>,
  key: string,
): number | undefined {
  return awards.find((a) => a.key === key)?.teamId;
}

describe('computeSeasonAwards', () => {
  const base: SeasonTeamSummary[] = [
    {
      teamId: 1,
      wins: 11,
      losses: 3,
      ties: 0,
      pointsFor: 1700,
      weeklyScores: [120, 130, 110, 140],
      projectedRank: 3,
      finishRank: 1,
      expectedWins: 9,
      allPlayWinPct: 0.8,
      moves: 10,
    },
    {
      teamId: 2,
      wins: 7,
      losses: 7,
      ties: 0,
      pointsFor: 1800, // most points but mediocre record (unlucky)
      weeklyScores: [100, 180, 60, 200], // volatile + highest single week (200)
      projectedRank: 1,
      finishRank: 6, // big bust
      expectedWins: 9,
      allPlayWinPct: 0.7,
      moves: 50, // wire addict
    },
    {
      teamId: 3,
      wins: 3,
      losses: 11,
      ties: 0,
      pointsFor: 1200, // worst record + fewest points
      weeklyScores: [55, 58, 56, 57], // consistent + lowest single week (55)
      projectedRank: 8,
      finishRank: 9,
      expectedWins: 5,
      allPlayWinPct: 0.2,
      moves: 2,
    },
  ];

  it('awards MVP to the best record and Points Champion to the most points', () => {
    const awards = computeSeasonAwards(base);
    expect(awardWinner(awards, 'mvp')).toBe(1);
    expect(awardWinner(awards, 'points-champ')).toBe(2);
  });

  it('awards Toilet Bowl to the worst record', () => {
    expect(awardWinner(computeSeasonAwards(base), 'toilet-bowl')).toBe(3);
  });

  it('computes luck from wins vs expected wins', () => {
    const awards = computeSeasonAwards(base);
    // team 1: 11 vs 9 = +2 (luckiest). team 2: 7 vs 9 = -2 (unluckiest).
    expect(awardWinner(awards, 'luckiest')).toBe(1);
    expect(awardWinner(awards, 'unluckiest')).toBe(2);
  });

  it('awards true-skill to the best all-play %', () => {
    expect(awardWinner(computeSeasonAwards(base), 'true-skill')).toBe(1);
  });

  it('computes riser and bust from projected vs final rank', () => {
    const awards = computeSeasonAwards(base);
    expect(awardWinner(awards, 'riser')).toBe(1); // 3 → 1 (+2)
    expect(awardWinner(awards, 'bust')).toBe(2); // 1 → 6 (−5)
  });

  it('computes single-week extremes and consistency/volatility', () => {
    const awards = computeSeasonAwards(base);
    expect(awardWinner(awards, 'high-week')).toBe(2); // 200
    expect(awardWinner(awards, 'low-week')).toBe(3); // 85
    expect(awardWinner(awards, 'volatile')).toBe(2);
    expect(awardWinner(awards, 'consistent')).toBe(3);
  });

  it('awards Wire Addict to the most active manager', () => {
    expect(awardWinner(computeSeasonAwards(base), 'wire-addict')).toBe(2);
  });

  it('omits awards whose inputs are missing instead of inventing winners', () => {
    const minimal: SeasonTeamSummary[] = [
      { teamId: 1, wins: 5, losses: 5, ties: 0, pointsFor: 100 },
      { teamId: 2, wins: 6, losses: 4, ties: 0, pointsFor: 90 },
    ];
    const keys = computeSeasonAwards(minimal).map((a) => a.key);
    // Record/points awards present; everything needing optional data omitted.
    expect(keys).toEqual(expect.arrayContaining(['mvp', 'points-champ', 'toilet-bowl']));
    expect(keys).not.toContain('luckiest');
    expect(keys).not.toContain('true-skill');
    expect(keys).not.toContain('riser');
    expect(keys).not.toContain('high-week');
    expect(keys).not.toContain('wire-addict');
  });

  it('breaks ties by teamId and returns nothing for no teams', () => {
    const tied: SeasonTeamSummary[] = [
      { teamId: 5, wins: 5, losses: 5, ties: 0, pointsFor: 100 },
      { teamId: 2, wins: 5, losses: 5, ties: 0, pointsFor: 100 },
    ];
    expect(awardWinner(computeSeasonAwards(tied), 'mvp')).toBe(2);
    expect(computeSeasonAwards([])).toEqual([]);
  });
});
