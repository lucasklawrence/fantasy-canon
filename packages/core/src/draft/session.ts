/**
 * A live draft session: the pure reducer behind `/canon draft start|pick|best`. It folds an
 * ordered stream of picks into the {@link DraftState} the recommendation engine already consumes,
 * so "best available, live" is just `bestAvailable(pool, toDraftState(session))` re-run after each
 * pick. No I/O, no clock — picks come from a {@link DraftSource} (manual entry or an ESPN capture),
 * and the two are interchangeable behind that seam.
 *
 * The session is immutable: {@link applyPick} returns a new session, never mutates the old one, so
 * callers can keep history or diff snapshots freely.
 */

import type { DraftPick, DraftState } from '../rankings/bestAvailable.js';
import { normalizeName } from '../rankings/parse.js';

export type DraftOrder = 'snake' | 'linear';

/** What the caller knows about the draft up front (before any picks). */
export interface DraftConfig {
  /** Number of teams. */
  leagueSize: number;
  /** Your 1-based draft slot (1..leagueSize). */
  myTeamId: number;
  /** Starting-lineup + bench slots, e.g. `{ QB:1, RB:2, WR:2, TE:1, FLEX:1, BENCH:6 }`. */
  rosterSlots: Record<string, number>;
  /** Total rounds; defaults to the sum of `rosterSlots` (one pick per roster spot). */
  rounds?: number;
  /** Draft order; ESPN redraft is `snake`. */
  order?: DraftOrder;
  scoring?: 'ppr';
}

/** {@link DraftConfig} with every optional field resolved. */
export interface ResolvedDraftConfig {
  leagueSize: number;
  myTeamId: number;
  rosterSlots: Record<string, number>;
  rounds: number;
  order: DraftOrder;
  scoring: 'ppr';
}

export interface DraftSession {
  readonly config: ResolvedDraftConfig;
  /** Picks applied so far, ascending by overall. */
  readonly picks: readonly DraftPick[];
  /** Normalized names of everyone drafted — the de-dupe key for idempotent replays. */
  readonly draftedKeys: ReadonlySet<string>;
}

/** Overall pick numbers (1-based) for a manager at `slot` across a whole `snake`/`linear` draft. */
export function draftOrder(
  slot: number,
  leagueSize: number,
  rounds: number,
  order: DraftOrder = 'snake',
): number[] {
  const overalls: number[] = [];
  for (let round = 1; round <= rounds; round += 1) {
    const inRound = order === 'snake' && round % 2 === 0 ? leagueSize - slot + 1 : slot;
    overalls.push((round - 1) * leagueSize + inRound);
  }
  return overalls;
}

/** Which 1-based slot is on the clock at a given overall pick. */
export function slotOnClock(
  overall: number,
  leagueSize: number,
  order: DraftOrder = 'snake',
): number {
  const round = Math.ceil(overall / leagueSize);
  const inRound = overall - (round - 1) * leagueSize;
  return order === 'snake' && round % 2 === 0 ? leagueSize - inRound + 1 : inRound;
}

function resolveConfig(config: DraftConfig): ResolvedDraftConfig {
  const { leagueSize, myTeamId, rosterSlots } = config;
  if (!Number.isInteger(leagueSize) || leagueSize < 2) {
    throw new Error(`Invalid leagueSize: ${leagueSize}`);
  }
  if (!Number.isInteger(myTeamId) || myTeamId < 1 || myTeamId > leagueSize) {
    throw new Error(`Invalid draft slot ${myTeamId} for a ${leagueSize}-team league`);
  }
  const rounds =
    config.rounds ??
    Math.max(
      1,
      Object.values(rosterSlots).reduce((a, b) => a + b, 0),
    );
  return {
    leagueSize,
    myTeamId,
    rosterSlots,
    rounds,
    order: config.order ?? 'snake',
    scoring: config.scoring ?? 'ppr',
  };
}

/** Start an empty session from a config. Throws on an out-of-range slot or league size. */
export function createDraftSession(config: DraftConfig): DraftSession {
  return { config: resolveConfig(config), picks: [], draftedKeys: new Set() };
}

/**
 * Apply one pick, returning a new session. Idempotent: a player already drafted is ignored (a
 * polling source that re-reports the whole board every tick therefore converges instead of
 * double-counting). Picks are kept sorted by overall.
 */
export function applyPick(session: DraftSession, pick: DraftPick): DraftSession {
  const key = normalizeName(pick.playerName);
  if (!key || session.draftedKeys.has(key)) return session;

  const picks = [...session.picks, pick].sort((a, b) => a.overall - b.overall);
  const draftedKeys = new Set(session.draftedKeys);
  draftedKeys.add(key);
  return { config: session.config, picks, draftedKeys };
}

/** Fold a batch of picks in overall order. */
export function applyPicks(session: DraftSession, picks: Iterable<DraftPick>): DraftSession {
  let next = session;
  for (const pick of picks) next = applyPick(next, pick);
  return next;
}

/** The overall pick number currently up (1 + picks made). */
export function currentOverall(session: DraftSession): number {
  return session.picks.length + 1;
}

/** Your remaining pick overalls, ascending — the current one included if it's yours. */
export function myUpcomingOveralls(session: DraftSession): number[] {
  const { myTeamId, leagueSize, rounds, order } = session.config;
  const now = currentOverall(session);
  return draftOrder(myTeamId, leagueSize, rounds, order).filter((o) => o >= now);
}

/** Project the session into the {@link DraftState} the recommendation engine consumes. */
export function toDraftState(session: DraftSession): DraftState {
  const { leagueSize, rosterSlots, myTeamId, order } = session.config;
  return {
    leagueSize,
    rosterSlots,
    scoring: 'ppr',
    myTeamId,
    picks: session.picks.map((p) => ({ ...p })),
    onTheClock: slotOnClock(currentOverall(session), leagueSize, order),
    myUpcomingOveralls: myUpcomingOveralls(session),
  };
}
