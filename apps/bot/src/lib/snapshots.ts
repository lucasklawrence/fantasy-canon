/**
 * Snapshot access with opportunistic team-name cache warming.
 *
 * `ensureSnapshot` returns a cached ESPN snapshot for a league/season/view, fetching and
 * saving it if absent. Whenever an `mTeam` snapshot passes through, it also refreshes the
 * autocomplete team-name cache — so the opponent autocomplete can answer keystrokes from
 * memory without an ESPN call. This is the central place commands should fetch through.
 */

import { BotContext } from '../config.js';
import { buildTeamNameMap } from './teamNames.js';
import { buildManagerNameMap } from './managerNames.js';
import { buildChoiceLabel, TeamChoice } from './teamNameCache.js';

/** Derive team-name choices from an `mTeam` payload and store them in the autocomplete cache. */
export function populateTeamNameCache(
  context: BotContext,
  leagueId: string,
  season: number,
  mTeamPayload: unknown,
): void {
  const nameMap = buildTeamNameMap(mTeamPayload);
  const managerMap = buildManagerNameMap(mTeamPayload);
  const choices: TeamChoice[] = [];
  for (const [teamId, teamName] of nameMap) {
    const managerName = managerMap.get(teamId);
    choices.push({ teamId, teamName, managerName, label: buildChoiceLabel(teamName, managerName) });
  }
  choices.sort((a, b) => a.label.localeCompare(b.label));
  context.teamNameCache.set(leagueId, season, choices);
}

export interface EnsureSnapshotOptions {
  /**
   * Skip the cache and go to ESPN, saving what comes back. Needed wherever the *point* of the call
   * is to observe a change made in ESPN since the last fetch — the in-Activity re-import (#219)
   * being the case in hand: every ESPN-backed `setup` has already cached this exact
   * league/season/view, so a cache-first read would hand back the roster the commissioner is
   * trying to replace and the re-import would silently do nothing.
   */
  refresh?: boolean;
}

/**
 * Return the snapshot payload for a league/season/view, fetching from ESPN and persisting it
 * on a cache miss. `mTeam` fetches additionally warm the team-name cache.
 */
export async function ensureSnapshot(
  context: BotContext,
  leagueId: string,
  season: number,
  view: string,
  options: EnsureSnapshotOptions = {},
): Promise<unknown> {
  const existing = options.refresh
    ? []
    : await context.snapshotsRepo.listBySeason(leagueId, season);
  const match = existing.find((s) => s.view === view);
  let payload: unknown;
  if (match) {
    payload = match.payload;
  } else {
    const res = await context.espnClient.fetchLeague({ leagueId, season, view });
    await context.snapshotsRepo.save({
      leagueId,
      season,
      view,
      fetchedAt: new Date(),
      payload: res.payload,
    });
    payload = res.payload;
  }
  if (view === 'mTeam') {
    populateTeamNameCache(context, leagueId, season, payload);
  }
  return payload;
}
