/**
 * Pure parsing for the ESPN draft room DOM — the "brain" of the ESPN capture {@link DraftSource}.
 * The side-effectful half (reading `document`, polling, transporting picks to the bot) lives in the
 * app/browser layer; everything here is a pure function over strings the reader scrapes, so it's
 * unit-tested against the exact shapes seen in a live mock draft.
 *
 * The pick log is an ESPN `.pick-history` table. Each pick's player cell (`.player-column`)
 * concatenates name + optional injury badge + NFL team + position with no separators, e.g.
 * `"Kyren WilliamsLARRB"` or, for an injured player, `"Cam SkatteboQNYGRB"` (the trailing `Q` is a
 * status badge, not part of the name). {@link parsePlayerColumn} unpicks that from the end using the
 * fixed position tokens and an NFL team dictionary, so an injury badge can't get glued to the name.
 *
 * When the reader can grab the name from the cell's player-link element directly (cleaner), it can
 * skip parsing and pass a ready {@link EspnRawPick} straight to {@link espnRowsToPicks}.
 */

import type { DraftPick } from '../rankings/bestAvailable.js';
import type { Position } from '../rankings/parse.js';
import type { DraftSnapshot } from './source.js';

/** One completed pick as scraped from the ESPN pick-history table. */
export interface EspnRawPick {
  /** 1-based overall pick number (from the row's pick cell). */
  overall: number;
  /** Player name — badge-free if read from the player-link element. */
  playerName: string;
  nflTeam?: string;
  position?: string;
  /** Fantasy team that made the pick (not used by the engine, handy for display). */
  fantasyTeam?: string;
}

const POSITION_TOKENS: readonly Position[] = ['QB', 'RB', 'WR', 'TE'];

/** ESPN NFL team abbreviations (upper-cased), with a few alternates ESPN has used over the years. */
const NFL_TEAMS = new Set([
  'ARI',
  'ATL',
  'BAL',
  'BUF',
  'CAR',
  'CHI',
  'CIN',
  'CLE',
  'DAL',
  'DEN',
  'DET',
  'GB',
  'HOU',
  'IND',
  'JAX',
  'JAC',
  'KC',
  'LV',
  'LAC',
  'LAR',
  'MIA',
  'MIN',
  'NE',
  'NO',
  'NYG',
  'NYJ',
  'PHI',
  'PIT',
  'SF',
  'SEA',
  'TB',
  'TEN',
  'WSH',
  'WAS',
  'OAK',
  'SD',
  'STL',
]);

/**
 * Split a concatenated `.player-column` string into name / NFL team / position, working from the
 * end (where the fixed tokens live) so a leading injury badge never contaminates the name. Best
 * effort: unknown trailing tokens are left on the name rather than guessed at.
 */
export function parsePlayerColumn(text: string): {
  name: string;
  nflTeam?: string;
  position?: Position;
} {
  let rest = (text ?? '').replace(/\s+/g, ' ').trim();

  // Position: a trailing QB/RB/WR/TE. Defenses/kickers won't match → position stays undefined.
  let position: Position | undefined;
  for (const pos of POSITION_TOKENS) {
    if (rest.endsWith(pos)) {
      position = pos;
      rest = rest.slice(0, -pos.length).trim();
      break;
    }
  }

  // NFL team: the longest valid team code that is a suffix of the trailing all-caps run. Anything
  // before it inside that run (e.g. a "Q"/"SUS" injury badge) is dropped along with the team.
  let nflTeam: string | undefined;
  const run = rest.match(/[A-Z]+$/)?.[0];
  if (run) {
    for (const len of [3, 2] as const) {
      const candidate = run.slice(-len);
      if (candidate.length === len && NFL_TEAMS.has(candidate)) {
        nflTeam = candidate;
        rest = rest.slice(0, rest.length - run.length).trim();
        break;
      }
    }
  }

  return { name: rest, nflTeam, position };
}

/**
 * Turn scraped rows into engine-ready {@link DraftPick}s: drop anything without a name or a finite
 * overall, de-dupe by overall (first wins), and sort ascending. The engine ignores `teamId`, so we
 * leave it 0 — pick identity is the player name.
 */
export function espnRowsToPicks(rows: readonly EspnRawPick[]): DraftPick[] {
  const byOverall = new Map<number, DraftPick>();
  for (const row of rows) {
    if (!row || !Number.isFinite(row.overall)) continue;
    const playerName = (row.playerName ?? '').trim();
    if (!playerName) continue;
    if (byOverall.has(row.overall)) continue;
    byOverall.set(row.overall, { overall: row.overall, teamId: 0, playerName });
  }
  return [...byOverall.values()].sort((a, b) => a.overall - b.overall);
}

/** Build a {@link DraftSnapshot} from scraped rows plus the pick currently on the clock. */
export function espnSnapshot(rows: readonly EspnRawPick[], onTheClock?: number): DraftSnapshot {
  return { picks: espnRowsToPicks(rows), onTheClock };
}
