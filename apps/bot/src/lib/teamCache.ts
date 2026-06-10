import { buildTeamNameMap } from './teamNames.js';

/**
 * In-memory cache of league team names keyed by leagueId+season, used to power
 * slash-command autocomplete. Discord autocomplete must respond within 3s and
 * cannot be deferred, so suggestions must come from this cache — never a live
 * ESPN fetch on each keystroke (see docs/14-data-surfacing-research.md §1.4).
 *
 * The cache is process-local (the db layer is an in-memory Noop today) and is
 * refreshed whenever a command parses an mTeam payload. Team names are stable
 * within a season, so no TTL is needed; later writes simply overwrite.
 */

export interface CachedTeam {
  id: number;
  name: string;
}

const cache = new Map<string, CachedTeam[]>();

function cacheKey(leagueId: string, season: number): string {
  return `${leagueId}:${season}`;
}

export function setCachedTeams(leagueId: string, season: number, teams: CachedTeam[]): void {
  cache.set(cacheKey(leagueId, season), teams);
}

export function getCachedTeams(leagueId: string, season: number): CachedTeam[] | undefined {
  return cache.get(cacheKey(leagueId, season));
}

/** Parse an mTeam payload into cached teams and store them. Returns what was cached. */
export function cacheTeamsFromPayload(
  leagueId: string,
  season: number,
  mTeamPayload: unknown,
): CachedTeam[] {
  const teams = Array.from(buildTeamNameMap(mTeamPayload), ([id, name]) => ({ id, name }));
  setCachedTeams(leagueId, season, teams);
  return teams;
}

/**
 * Case-insensitive substring search over cached team names, for autocomplete.
 * A numeric query also matches a team id. An empty query returns the first
 * `limit` teams. Results are capped at `limit` (Discord allows ≤25 choices).
 */
export function searchCachedTeams(
  leagueId: string,
  season: number,
  query: string,
  limit = 25,
): CachedTeam[] {
  const teams = getCachedTeams(leagueId, season);
  if (!teams || teams.length === 0) return [];

  const q = query.trim().toLowerCase();
  const matches = q
    ? teams.filter((t) => t.name.toLowerCase().includes(q) || String(t.id) === q)
    : teams;

  return matches.slice(0, Math.max(0, limit));
}

/** Test-only: clear all cached entries. */
export function clearTeamCache(): void {
  cache.clear();
}
