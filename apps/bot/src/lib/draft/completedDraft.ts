/**
 * Fetch + parse a **completed** ESPN draft into a replayable {@link CompletedDraftSource}. This is the
 * side-effectful glue that #125's pure pieces plug into: {@link parseDraftDetail} (espn-client) turns
 * the raw `mDraftDetail` payload into typed picks, {@link buildPlayerNameMap} resolves `playerId`s to
 * names, and the result is bridged to core's engine-ready `DraftPick` shape so a finished draft can be
 * replayed through a `DraftSession` to validate best-available end-to-end.
 *
 * Two fetches at most: `mDraftDetail` for the picks, and — only if the detail payload doesn't already
 * carry player names — `mRoster` to resolve ids. Post-draft only: before a draft runs ESPN reports
 * `drafted: false` and we return an empty result rather than guessing.
 *
 * Private leagues need `ESPN_S2` + `SWID` cookies on the client; public leagues (2020+) need none.
 */

import type { EspnClient, DraftDetailPick } from '@fantasy-canon/espn-client';
import { buildPlayerNameMap, parseDraftDetail } from '@fantasy-canon/espn-client';
import type { DraftPick } from '@fantasy-canon/core';
import { CompletedDraftSource } from '@fantasy-canon/core';
import type { SeasonYear } from '@fantasy-canon/shared';

export interface FetchCompletedDraftParams {
  leagueId: string;
  season: SeasonYear;
}

export interface CompletedDraftResult {
  /** ESPN's `draftDetail.drafted` — `false` (and everything empty) until the draft has run. */
  drafted: boolean;
  /** Engine-ready picks (name-resolved), ascending by overall — feed these to the session/engine. */
  picks: DraftPick[];
  /** ESPN-native detail (round, pickInRound, bid, keeper, ids) for display or analysis. */
  detailPicks: DraftDetailPick[];
  /** A {@link CompletedDraftSource} that replays the finished draft through the engine. */
  source: CompletedDraftSource;
}

const EMPTY = (): CompletedDraftResult => ({
  drafted: false,
  picks: [],
  detailPicks: [],
  source: new CompletedDraftSource([]),
});

/**
 * Fetch a league's completed draft and return replayable picks. Resolves player names from the draft
 * payload when it carries them, otherwise falls back to a single `mRoster` fetch; ids that still can't
 * be resolved (e.g. a player dropped since draft day) become a `Player <id>` placeholder rather than
 * failing the import.
 */
export async function fetchCompletedDraft(
  client: EspnClient,
  params: FetchCompletedDraftParams,
): Promise<CompletedDraftResult> {
  const { leagueId, season } = params;

  const detail = await client.fetchLeague({ leagueId, season, view: 'mDraftDetail' });
  const parsed = parseDraftDetail(detail.payload);
  // Only short-circuit the "not drafted yet" case; a drafted-but-empty board flows through and is
  // reported faithfully as `drafted: true` with no picks (rather than masquerading as not-drafted).
  if (!parsed.drafted) return EMPTY();

  // Prefer names already in the draft payload; only pay for an mRoster fetch if some id is unresolved.
  let names = buildPlayerNameMap(detail.payload);
  if (parsed.picks.some((p) => !names.has(p.playerId))) {
    const roster = await client.fetchLeague({ leagueId, season, view: 'mRoster' });
    names = new Map([...names, ...buildPlayerNameMap(roster.payload)]);
  }

  const picks: DraftPick[] = parsed.picks.map((p) => ({
    overall: p.overall,
    teamId: p.teamId,
    playerName: names.get(p.playerId) ?? `Player ${p.playerId}`,
  }));

  return {
    drafted: true,
    picks,
    detailPicks: parsed.picks,
    source: new CompletedDraftSource(picks),
  };
}
