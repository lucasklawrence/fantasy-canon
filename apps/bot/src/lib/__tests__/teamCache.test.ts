import { beforeEach, describe, expect, it } from 'vitest';
import {
  cacheTeamsFromPayload,
  clearTeamCache,
  getCachedTeams,
  searchCachedTeams,
  setCachedTeams,
} from '../teamCache.js';

const mTeam = {
  teams: [
    { id: 1, location: 'Team', nickname: 'Rocket' },
    { id: 2, location: 'Gridiron', nickname: 'Gang' },
    { id: 3, name: 'Lone Wolves' },
  ],
};

describe('teamCache', () => {
  beforeEach(() => clearTeamCache());

  it('caches teams parsed from an mTeam payload', () => {
    cacheTeamsFromPayload('123', 2025, mTeam);
    const cached = getCachedTeams('123', 2025);
    expect(cached).toEqual([
      { id: 1, name: 'Team Rocket' },
      { id: 2, name: 'Gridiron Gang' },
      { id: 3, name: 'Lone Wolves' },
    ]);
  });

  it('keys the cache by league and season independently', () => {
    cacheTeamsFromPayload('123', 2025, mTeam);
    expect(getCachedTeams('123', 2024)).toBeUndefined();
    expect(getCachedTeams('999', 2025)).toBeUndefined();
  });

  it('searches case-insensitively by name substring', () => {
    cacheTeamsFromPayload('123', 2025, mTeam);
    const result = searchCachedTeams('123', 2025, 'gang');
    expect(result).toEqual([{ id: 2, name: 'Gridiron Gang' }]);
  });

  it('matches a numeric query against the team id', () => {
    cacheTeamsFromPayload('123', 2025, mTeam);
    expect(searchCachedTeams('123', 2025, '3')).toEqual([{ id: 3, name: 'Lone Wolves' }]);
  });

  it('returns all teams (up to the limit) for an empty query', () => {
    cacheTeamsFromPayload('123', 2025, mTeam);
    expect(searchCachedTeams('123', 2025, '')).toHaveLength(3);
    expect(searchCachedTeams('123', 2025, '', 2)).toHaveLength(2);
  });

  it('returns an empty array on a cache miss (never throws)', () => {
    expect(searchCachedTeams('nope', 1999, 'anything')).toEqual([]);
  });

  it('overwrites a prior entry on refresh', () => {
    setCachedTeams('123', 2025, [{ id: 1, name: 'Old Name' }]);
    cacheTeamsFromPayload('123', 2025, mTeam);
    expect(getCachedTeams('123', 2025)).toHaveLength(3);
  });
});
