import { extractWeeklyScores, extractWeeklyMatchups } from '../weeklyScores.js';

describe('extractWeeklyScores', () => {
  it('flattens the home/away matchup shape into per-team scores', () => {
    const payload = {
      schedule: [
        {
          matchupPeriodId: 1,
          home: { teamId: 1, totalPoints: 120.5 },
          away: { teamId: 2, totalPoints: 98.2 },
        },
      ],
    };
    expect(extractWeeklyScores(payload)).toEqual([
      { week: 1, teamId: 1, score: 120.5 },
      { week: 1, teamId: 2, score: 98.2 },
    ]);
  });

  it('handles the teams[] shape and falls back to scoringPeriodId for the week', () => {
    const payload = {
      schedule: [{ scoringPeriodId: 3, teams: [{ teamId: 5, totalPoints: 88 }, { teamId: 6 }] }],
    };
    // Missing totalPoints counts as 0 so the team still appears.
    expect(extractWeeklyScores(payload)).toEqual([
      { week: 3, teamId: 5, score: 88 },
      { week: 3, teamId: 6, score: 0 },
    ]);
  });

  it('reads from `matchups` when `schedule` is absent, and skips weekless entries', () => {
    const payload = {
      matchups: [
        { home: { teamId: 1, totalPoints: 10 }, away: { teamId: 2, totalPoints: 20 } }, // no week → skip
        {
          matchupPeriodId: 2,
          home: { teamId: 1, totalPoints: 30 },
          away: { teamId: 2, totalPoints: 40 },
        },
      ],
    };
    expect(extractWeeklyScores(payload)).toEqual([
      { week: 2, teamId: 1, score: 30 },
      { week: 2, teamId: 2, score: 40 },
    ]);
  });

  it('returns [] for non-object or scheduleless payloads', () => {
    expect(extractWeeklyScores(null)).toEqual([]);
    expect(extractWeeklyScores({})).toEqual([]);
    expect(extractWeeklyScores({ schedule: 'x' })).toEqual([]);
  });
});

describe('extractWeeklyMatchups', () => {
  it('preserves the home/away pairing with the week', () => {
    const payload = {
      schedule: [
        {
          matchupPeriodId: 4,
          home: { teamId: 1, totalPoints: 100 },
          away: { teamId: 2, totalPoints: 90 },
        },
      ],
    };
    expect(extractWeeklyMatchups(payload)).toEqual([
      { week: 4, home: { teamId: 1, score: 100 }, away: { teamId: 2, score: 90 } },
    ]);
  });

  it('pairs a two-entry teams[] matchup', () => {
    const payload = {
      schedule: [
        {
          matchupPeriodId: 1,
          teams: [
            { teamId: 3, totalPoints: 70 },
            { teamId: 4, totalPoints: 75 },
          ],
        },
      ],
    };
    expect(extractWeeklyMatchups(payload)).toEqual([
      { week: 1, home: { teamId: 3, score: 70 }, away: { teamId: 4, score: 75 } },
    ]);
  });

  it('skips matchups that do not resolve to exactly two valid sides', () => {
    const payload = {
      schedule: [
        { matchupPeriodId: 1, home: { teamId: 1, totalPoints: 10 } }, // no away
        { matchupPeriodId: 1, teams: [{ teamId: 2, totalPoints: 5 }] }, // only one team
        { matchupPeriodId: 1, home: { totalPoints: 10 }, away: { teamId: 2, totalPoints: 5 } }, // home has no teamId
      ],
    };
    expect(extractWeeklyMatchups(payload)).toEqual([]);
  });
});
