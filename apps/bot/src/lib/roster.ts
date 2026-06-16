/**
 * Extract a team's current roster from an ESPN `mRoster` payload.
 *
 * Shape (defensively parsed): `payload.teams[].roster.entries[]`, where each entry carries a
 * `lineupSlotId` and a `playerPoolEntry.player` ({ fullName, defaultPositionId }). Bench (20)
 * and IR (21) lineup slots mark non-starters. ESPN's endpoints are unofficial, so every field
 * is treated as optional.
 */

export interface RosterPlayer {
  /** Player display name, e.g. "Josh Allen". */
  name: string;
  /** Position abbreviation derived from `defaultPositionId`, e.g. "QB" (or "?" if unknown). */
  position: string;
  /** False for players on the bench or IR lineup slots. */
  starting: boolean;
}

const BENCH_SLOT = 20;
const IR_SLOT = 21;

const POSITION_BY_ID: Record<number, string> = {
  1: 'QB',
  2: 'RB',
  3: 'WR',
  4: 'TE',
  5: 'K',
  16: 'D/ST',
};

/** Map an ESPN `defaultPositionId` to a short position label. */
export function positionLabel(positionId: unknown): string {
  const id = Number(positionId);
  return Number.isFinite(id) && POSITION_BY_ID[id] ? POSITION_BY_ID[id] : '?';
}

function extractEntries(team: unknown): unknown[] {
  if (!team || typeof team !== 'object') return [];
  const roster = (team as { roster?: unknown }).roster;
  if (!roster || typeof roster !== 'object') return [];
  const entries = (roster as { entries?: unknown }).entries;
  return Array.isArray(entries) ? entries : [];
}

function parseEntry(entry: unknown): RosterPlayer | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const e = entry as { lineupSlotId?: unknown; playerPoolEntry?: unknown };
  const poolEntry =
    e.playerPoolEntry && typeof e.playerPoolEntry === 'object'
      ? (e.playerPoolEntry as { player?: unknown })
      : undefined;
  const player =
    poolEntry?.player && typeof poolEntry.player === 'object'
      ? (poolEntry.player as { fullName?: unknown; defaultPositionId?: unknown })
      : undefined;
  const name = typeof player?.fullName === 'string' ? player.fullName.trim() : '';
  if (!name) return undefined;
  const slotId = Number(e.lineupSlotId);
  const starting = !(slotId === BENCH_SLOT || slotId === IR_SLOT);
  return { name, position: positionLabel(player?.defaultPositionId), starting };
}

/**
 * Roster for a single team. Starters are listed before bench; within each group the original
 * ESPN ordering is preserved. Returns an empty array when the team or its roster is absent.
 */
export function extractRoster(payload: unknown, teamId: number): RosterPlayer[] {
  if (!payload || typeof payload !== 'object') return [];
  const maybeTeams = (payload as { teams?: unknown }).teams;
  if (!Array.isArray(maybeTeams)) return [];
  const teams = maybeTeams as unknown[];
  const team = teams.find(
    (t) => t && typeof t === 'object' && Number((t as { id?: unknown }).id) === teamId,
  );
  if (!team) return [];
  const players = extractEntries(team)
    .map(parseEntry)
    .filter((p): p is RosterPlayer => p !== undefined);
  const starters = players.filter((p) => p.starting);
  const bench = players.filter((p) => !p.starting);
  return [...starters, ...bench];
}
