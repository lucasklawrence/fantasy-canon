import { describe, expect, it } from 'vitest';
import { RICH_TEAMS } from './handlerFixtures.js';
import { deriveStandingsBaseBalls, extractFinalRanks } from '../finalStandings.js';

describe('extractFinalRanks', () => {
  it('maps stringified team ids to final ranks from an mTeam payload', () => {
    expect(extractFinalRanks(RICH_TEAMS)).toEqual(
      new Map([
        ['1', 1],
        ['2', 2],
        ['3', 3],
        ['4', 4],
      ]),
    );
  });

  it('falls back through rankCalculatedFinal and playoffSeed, skipping unranked teams', () => {
    const payload = {
      teams: [{ id: 1, rankCalculatedFinal: 2 }, { id: 2, playoffSeed: 5 }, { id: 3 }],
    };
    expect(extractFinalRanks(payload)).toEqual(
      new Map([
        ['1', 2],
        ['2', 5],
      ]),
    );
  });

  it('returns an empty map for junk payloads', () => {
    expect(extractFinalRanks(undefined).size).toBe(0);
    expect(extractFinalRanks({ teams: 'nope' }).size).toBe(0);
  });
});

describe('deriveStandingsBaseBalls', () => {
  it('gives each team balls equal to its finish (worst finish → most balls)', () => {
    const { baseBallsByTeam, missingRank } = deriveStandingsBaseBalls(
      ['1', '2', '3', '4'],
      new Map([
        ['1', 1],
        ['2', 2],
        ['3', 3],
        ['4', 4],
      ]),
    );
    expect([...baseBallsByTeam.values()]).toEqual([1, 2, 3, 4]);
    expect(missingRank).toEqual([]);
  });

  it('defaults unranked roster teams to mid-pack and reports them', () => {
    const { baseBallsByTeam, missingRank } = deriveStandingsBaseBalls(
      ['1', '2', '3', '4'],
      new Map([
        ['1', 1],
        ['2', 2],
        ['3', 3],
      ]),
    );
    expect(baseBallsByTeam.get('4')).toBe(2);
    expect(missingRank).toEqual(['4']);
  });

  it('clamps out-of-range ranks into [1, roster size]', () => {
    const { baseBallsByTeam } = deriveStandingsBaseBalls(
      ['1', '2'],
      new Map([
        ['1', 9],
        ['2', 1],
      ]),
    );
    expect(baseBallsByTeam.get('1')).toBe(2);
    expect(baseBallsByTeam.get('2')).toBe(1);
  });
});
