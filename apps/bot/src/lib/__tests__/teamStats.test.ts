import { describe, it, expect } from 'vitest';
import { extractTeams } from '../teamStats.js';

describe('extractTeams', () => {
  it('extracts record, points, streak and home/away splits', () => {
    const payload = {
      teams: [
        {
          id: 3,
          draftDayProjectedRank: 5,
          record: {
            overall: {
              wins: 8,
              losses: 5,
              ties: 0,
              pointsFor: 1450.5,
              pointsAgainst: 1300.2,
              streakType: 'WIN',
              streakLength: 3,
            },
            home: { wins: 5, losses: 1 },
            away: { wins: 3, losses: 4 },
          },
          transactionCounter: {
            acquisitions: 12,
            moveToActive: 4,
            moveToIR: 2,
            drops: 6,
            trades: 1,
          },
        },
      ],
    };
    const [team] = extractTeams(payload);
    expect(team.id).toBe(3);
    expect(team.wins).toBe(8);
    expect(team.pointsFor).toBeCloseTo(1450.5);
    expect(team.streakType).toBe('WIN');
    expect(team.homeWins).toBe(5);
    expect(team.awayLosses).toBe(4);
    expect(team.acquisitions).toBe(12);
    expect(team.totalMoves).toBe(25);
    expect(team.projectedRank).toBe(5);
  });

  it('leaves projectedRank undefined (not NaN) when draftDayProjectedRank is missing', () => {
    const [team] = extractTeams({ teams: [{ id: 1 }] });
    expect(team.projectedRank).toBeUndefined();
    expect(Number.isNaN(team.projectedRank as number)).toBe(false);
  });

  it('returns an empty array for malformed payloads', () => {
    expect(extractTeams(undefined)).toEqual([]);
    expect(extractTeams({ teams: 'nope' })).toEqual([]);
  });
});
