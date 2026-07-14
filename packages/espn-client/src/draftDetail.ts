/**
 * Pure parsing for a **completed draft** (`view=mDraftDetail`). ESPN returns the finished board under
 * `draftDetail.picks[]` with raw, ESPN-internal field names and a `playerId` instead of a name; this
 * module maps that to our types and resolves ids → names from roster/player data in the same fetch.
 *
 * Fetching (cookies, the v3 vs. `leagueHistory` host, multiple views) is the side-effectful half and
 * lives in the app layer — everything here is a pure function over an already-fetched payload, so it's
 * unit-tested against the exact shapes ESPN emits. This is post-draft only: before a draft runs,
 * `draftDetail.drafted` is `false` and {@link parseDraftDetail} returns no picks.
 *
 * Name resolution is best-effort: every drafted player lands on a roster, so a payload fetched with
 * `mRoster` right after the draft resolves every id. Import a draft weeks later and players since
 * dropped won't be on a current roster — {@link buildPlayerNameMap} simply omits those ids, leaving
 * the caller to decide what to do with an unresolved pick (the bot glue reports it rather than fakes it).
 */

/** One completed pick, ESPN's raw fields mapped to our names. `overall` is 1-based across the draft. */
export interface DraftDetailPick {
  /** ESPN's internal fantasy team id that made the pick (not the 1-based draft slot). */
  teamId: number;
  /** ESPN player id — resolve to a name via {@link buildPlayerNameMap}. */
  playerId: number;
  /** 1-based round (ESPN `roundId`). */
  round: number;
  /** 1-based pick within the round (ESPN `roundPickNumber`). */
  pickInRound: number;
  /** 1-based overall pick number across the whole draft. */
  overall: number;
  /** Auction bid, if this was an auction draft (omitted for snake). */
  bidAmount?: number;
  /** True for a keeper pick. */
  keeper: boolean;
  /** Auction nominating team id, if present. */
  nominatingTeamId?: number;
}

export interface ParsedDraftDetail {
  /** ESPN's `draftDetail.drafted` — `false` until the draft has run. */
  drafted: boolean;
  /** Completed picks, ascending by overall. Empty when `drafted` is `false`. */
  picks: DraftDetailPick[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse `draftDetail.picks[]` into typed picks. Returns `{ drafted: false, picks: [] }` when the draft
 * hasn't run yet. `overall` prefers ESPN's `overallPickNumber` when present; otherwise it's derived by
 * sorting on `(round, pickInRound)` and numbering from 1 — robust even if the array arrives unordered.
 */
export function parseDraftDetail(payload: unknown): ParsedDraftDetail {
  const detail = asRecord(asRecord(payload)?.draftDetail);
  const drafted = detail?.drafted === true;
  if (!drafted) return { drafted: false, picks: [] };

  const raw = asArray(detail?.picks)
    .map(asRecord)
    .filter((r): r is Record<string, unknown> => r !== undefined);

  // Sort by (round, pickInRound) so a derived overall is stable regardless of array order.
  const sorted = [...raw].sort((a, b) => {
    const ra = num(a.roundId) ?? 0;
    const rb = num(b.roundId) ?? 0;
    if (ra !== rb) return ra - rb;
    return (num(a.roundPickNumber) ?? 0) - (num(b.roundPickNumber) ?? 0);
  });

  const picks = sorted.map((r, index): DraftDetailPick => {
    const pick: DraftDetailPick = {
      teamId: num(r.teamId) ?? 0,
      playerId: num(r.playerId) ?? 0,
      round: num(r.roundId) ?? 0,
      pickInRound: num(r.roundPickNumber) ?? 0,
      overall: num(r.overallPickNumber) ?? index + 1,
      keeper: r.keeper === true,
    };
    const bid = num(r.bidAmount);
    if (bid !== undefined && bid > 0) pick.bidAmount = bid;
    const nominating = num(r.nominatingTeamId);
    if (nominating !== undefined && nominating > 0) pick.nominatingTeamId = nominating;
    return pick;
  });

  return { drafted: true, picks };
}

/** Add `{id, fullName}` from a `player`-shaped record to the map, if both fields are present. */
function collectPlayer(map: Map<number, string>, playerLike: unknown): void {
  const player = asRecord(playerLike);
  const id = num(player?.id);
  const fullName = str(player?.fullName);
  if (id !== undefined && fullName !== undefined) map.set(id, fullName);
}

/**
 * Build a `playerId → fullName` map from whatever roster/player data a league payload carries: team
 * rosters (`teams[].roster.entries[].playerPoolEntry.player`) and, if present, a top-level `players[]`
 * list (each item either a bare player or `{ player }`). Fetch with `mRoster` alongside `mDraftDetail`
 * so drafted ids resolve. Ids with no name available are simply absent — callers supply a fallback.
 */
export function buildPlayerNameMap(payload: unknown): Map<number, string> {
  const map = new Map<number, string>();
  const root = asRecord(payload);

  for (const teamLike of asArray(root?.teams)) {
    const roster = asRecord(asRecord(teamLike)?.roster);
    for (const entryLike of asArray(roster?.entries)) {
      collectPlayer(map, asRecord(asRecord(entryLike)?.playerPoolEntry)?.player);
    }
  }

  for (const item of asArray(root?.players)) {
    const record = asRecord(item);
    // `players[]` items are sometimes `{ player: {...} }` and sometimes the bare player.
    collectPlayer(map, record?.player ?? record);
  }

  return map;
}
