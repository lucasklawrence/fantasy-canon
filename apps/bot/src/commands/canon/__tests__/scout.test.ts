import { describe, expect, it } from 'vitest';
import { extractTeamProfile } from '../scout.js';

const payload = {
  teams: [
    {
      id: 7,
      location: 'Team',
      nickname: 'Rocket',
      record: { overall: { wins: 9, losses: 4, ties: 1, pointsFor: 1623.4 } },
      draftDayProjectedRank: 5,
      rankFinal: 2,
      playoffSeed: 2,
      transactionCounter: { acquisitionBudgetSpent: 84 },
    },
    { id: 8, name: 'Other' },
  ],
};

describe('extractTeamProfile', () => {
  it('pulls record, ranks, and FAAB for a team', () => {
    expect(extractTeamProfile(payload, 7)).toEqual({
      id: 7,
      name: 'Team Rocket',
      wins: 9,
      losses: 4,
      ties: 1,
      pointsFor: 1623.4,
      projectedRank: 5,
      finishRank: 2,
      playoffSeed: 2,
      faabSpent: 84,
    });
  });

  it('falls back to rankCalculatedFinal when rankFinal is absent', () => {
    const p = { teams: [{ id: 1, rankCalculatedFinal: 6, record: { overall: { wins: 1 } } }] };
    expect(extractTeamProfile(p, 1)?.finishRank).toBe(6);
  });

  it('defaults missing record fields to zero and leaves optional ranks undefined', () => {
    const p = { teams: [{ id: 3, name: 'Sparse' }] };
    expect(extractTeamProfile(p, 3)).toEqual({
      id: 3,
      name: 'Sparse',
      wins: 0,
      losses: 0,
      ties: 0,
      pointsFor: 0,
      projectedRank: undefined,
      finishRank: undefined,
      playoffSeed: undefined,
      faabSpent: undefined,
    });
  });

  it('returns undefined when the team id is not present', () => {
    expect(extractTeamProfile(payload, 999)).toBeUndefined();
  });

  it('returns undefined for a malformed payload', () => {
    expect(extractTeamProfile(null, 1)).toBeUndefined();
    expect(extractTeamProfile({}, 1)).toBeUndefined();
  });
});
