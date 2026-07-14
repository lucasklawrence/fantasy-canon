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
 * **Name resolution never silently corrupts the replay.** Names come from current rosters, so importing
 * right after the draft resolves every id. Import a stale draft (players dropped since draft day) and a
 * few ids won't be on any current roster — those picks are reported in {@link CompletedDraftResult.unresolved}
 * and left OUT of the replayable `picks`/`source`, rather than injected as a phantom name that would
 * occupy a pick slot while removing no real player from the board (silently corrupting validation).
 * `unresolved.length === 0` means full fidelity; a stale import with gaps should be treated as partial
 * (or backed by a season-wide player lookup — a future robustness path).
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
  /**
   * Engine-ready, name-resolved picks, ascending by overall — feed these to the session/engine. Only
   * picks whose `playerId` resolved to a name; any that didn't are in {@link unresolved}, never here.
   */
  picks: DraftPick[];
  /** ESPN-native detail for every pick (round, pickInRound, bid, keeper, ids) — the complete record. */
  detailPicks: DraftDetailPick[];
  /**
   * Picks whose `playerId` couldn't be resolved to a name (e.g. dropped since draft day). Excluded from
   * `picks`/`source` so they can't corrupt a replay; non-empty means the replay is partial.
   */
  unresolved: DraftDetailPick[];
  /** A {@link CompletedDraftSource} that replays the finished draft (resolved picks only). */
  source: CompletedDraftSource;
}

const EMPTY = (): CompletedDraftResult => ({
  drafted: false,
  picks: [],
  detailPicks: [],
  unresolved: [],
  source: new CompletedDraftSource([]),
});

/**
 * Fetch a league's completed draft and return replayable picks. Resolves player names from the draft
 * payload when it carries them, otherwise falls back to a single `mRoster` fetch. Picks whose id can't
 * be resolved are surfaced in {@link CompletedDraftResult.unresolved} and kept out of the replay rather
 * than faked, so best-available validation is never silently corrupted by a phantom pick.
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

  const picks: DraftPick[] = [];
  const unresolved: DraftDetailPick[] = [];
  for (const p of parsed.picks) {
    const playerName = names.get(p.playerId);
    // A pick with no name can't be matched in the rankings pool, so keeping it would leave the real
    // player on the board while a phantom occupies the slot — exclude it and report it instead.
    if (playerName === undefined) unresolved.push(p);
    else picks.push({ overall: p.overall, teamId: p.teamId, playerName });
  }

  return {
    drafted: true,
    picks,
    detailPicks: parsed.picks,
    unresolved,
    source: new CompletedDraftSource(picks),
  };
}
