import { describe, expect, it } from 'vitest';
import { buildAllRivalries, buildRivalry, extractMatchups } from '../rivalry.js';

describe('extractMatchups', () => {
  it('parses the home/away shape', () => {
    const payload = {
      schedule: [
        { home: { teamId: 1, totalPoints: 120 }, away: { teamId: 2, totalPoints: 90 } },
        { home: { teamId: 2, totalPoints: 100 }, away: { teamId: 1, totalPoints: 110 } },
      ],
    };
    expect(extractMatchups(payload)).toEqual([
      { homeId: 1, awayId: 2, homeScore: 120, awayScore: 90 },
      { homeId: 2, awayId: 1, homeScore: 100, awayScore: 110 },
    ]);
  });

  it('parses the teams[] fallback shape', () => {
    const payload = {
      schedule: [
        {
          teams: [
            { teamId: 3, totalPoints: 88 },
            { teamId: 4, totalPoints: 77 },
          ],
        },
      ],
    };
    expect(extractMatchups(payload)).toEqual([
      { homeId: 3, awayId: 4, homeScore: 88, awayScore: 77 },
    ]);
  });

  it('skips matchups with a missing team id and tolerates malformed payloads', () => {
    // teamId null must not slip through as Team 0.
    const withNullTeam = {
      schedule: [
        { home: { teamId: null, totalPoints: 120 }, away: { teamId: 2, totalPoints: 90 } },
      ],
    };
    expect(extractMatchups(withNullTeam)).toEqual([]);
    expect(extractMatchups(undefined)).toEqual([]);
    expect(extractMatchups({})).toEqual([]);
    expect(extractMatchups({ schedule: 'nope' })).toEqual([]);
  });

  it('defaults a missing score to 0', () => {
    const payload = {
      matchups: [{ home: { teamId: 1 }, away: { teamId: 2, totalPoints: 90 } }],
    };
    expect(extractMatchups(payload)).toEqual([
      { homeId: 1, awayId: 2, homeScore: 0, awayScore: 90 },
    ]);
  });
});

describe('buildRivalry', () => {
  const matchups = [
    { homeId: 1, awayId: 2, homeScore: 120, awayScore: 90 },
    { homeId: 2, awayId: 1, homeScore: 100, awayScore: 110 },
    { homeId: 1, awayId: 3, homeScore: 80, awayScore: 95 }, // unrelated pairing
  ];

  it('accumulates head-to-head wins and points for one pairing', () => {
    expect(buildRivalry(matchups, 1, 2)).toEqual({
      teamA: 1,
      teamB: 2,
      aWins: 2,
      bWins: 0,
      aPoints: 230,
      bPoints: 190,
    });
  });

  it('returns undefined when the two teams never met', () => {
    expect(buildRivalry(matchups, 2, 3)).toBeUndefined();
  });
});

describe('buildAllRivalries', () => {
  it('keys every pairing by unordered pair with teamA = lower id', () => {
    const rivalries = buildAllRivalries([
      { homeId: 2, awayId: 1, homeScore: 100, awayScore: 110 },
      { homeId: 1, awayId: 2, homeScore: 120, awayScore: 90 },
    ]);
    expect(rivalries).toEqual([
      { teamA: 1, teamB: 2, aWins: 2, bWins: 0, aPoints: 230, bPoints: 190 },
    ]);
  });
});
