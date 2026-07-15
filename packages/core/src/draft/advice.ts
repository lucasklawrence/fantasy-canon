/**
 * Pure projection from a live {@link DraftSession} to the `AdviceView` a draft dashboard renders.
 * Runs the same VBD engine (`bestAvailable`) the `/canon draft` commands use, then shapes the result
 * for a glanceable "you're on the clock — take this" screen: the top recommendation, a few
 * alternatives, the best available at each position you still need, your roster so far, and how many
 * picks until you're up.
 *
 * No I/O, no clock — it's a function of `(session, pool)`, so it unit-tests against a canned session
 * and every surface (the bot's localhost advisor, the `apps/api` Activity backend) re-invokes it
 * after each pick. Callers stamp their own `updatedAt` when they serve it; keeping time out of here
 * keeps the projection deterministic. Lives in `core` (not an app) precisely because it is pure and
 * shared by more than one surface.
 */

import { bestAvailable, type Candidate, type Recommendation } from '../rankings/bestAvailable.js';
import { normalizeName, type PlayerTier, type Position } from '../rankings/parse.js';
import {
  draftOrder,
  myUpcomingOveralls,
  slotOnClock,
  toDraftState,
  type DraftSession,
} from './session.js';

/**
 * Provenance for a live ADP overlay, surfaced to callers so stale market data is detectable. Lives
 * here (rather than in an app's loader) so both the projection and the loaders that produce it share
 * one definition.
 */
export interface AdpProvenance {
  asOf: string;
  sampleSize: number;
  /** How many ADP-only players deepened the research board. */
  added: number;
}

/** One player as shown on the dashboard — engine numbers plus a short human reason. */
export interface CandidateView {
  name: string;
  position: Position;
  tier?: number;
  adp?: number;
  recommend: Recommendation;
  /** One-line rationale, e.g. "Value — slipping past his ADP". */
  reason: string;
  vona: number;
}

export interface RosterSpot {
  position: Position | 'FLEX';
  name: string;
  overall: number;
}

export interface RecentPick {
  overall: number;
  slot: number;
  name: string;
  /** True when this pick was yours. */
  mine: boolean;
}

/** Everything the dashboard needs for one render. Plain JSON — serialized straight to the wire. */
export interface AdviceView {
  /** Overall pick on the clock right now (1-based). */
  currentOverall: number;
  round: number;
  pickInRound: number;
  /** 1-based draft slot on the clock. */
  onTheClockSlot: number;
  mySlot: number;
  isMyPick: boolean;
  /** Overall number of your next pick (the current one if it's yours), if any remain. */
  myNextOverall?: number;
  /** Picks between now and your next turn (0 when you're on the clock). */
  picksUntilMine?: number;
  recommended?: CandidateView;
  /** Next-best players overall (excludes the recommendation). */
  alternatives: CandidateView[];
  /** Best available at each position you still have a starting hole at. */
  byNeed: { position: Position; candidate: CandidateView }[];
  /** Positions with an unfilled starting slot. */
  needs: Position[];
  myRoster: RosterSpot[];
  /** Most recent picks league-wide, newest first. */
  recentPicks: RecentPick[];
  /** Players still on the board. */
  remaining: number;
  /** Total players in the loaded pool. */
  poolSize: number;
  complete: boolean;
  /** ADP feed provenance, when the pool was market-priced. */
  adp?: AdpProvenance;
}

export interface BuildAdviceOptions {
  complete?: boolean;
  adp?: AdpProvenance;
  /** How many alternatives to surface beyond the recommendation (default 5). */
  alternatives?: number;
  /** How many recent picks to show (default 8). */
  recent?: number;
}

/**
 * Positions the advisor tracks as needs. Deliberately the four skill positions the VBD engine
 * ranks — K and DST are out of scope (no ADP/pool for them, they're last-round throwaways), so
 * `needs`/`byNeed` never surface them and the "skill starters set" copy is scoped to match.
 */
const STARTER_POSITIONS: readonly Position[] = ['RB', 'WR', 'TE', 'QB'];

function reasonFor(c: Candidate, myNextOverall: number | undefined): string {
  switch (c.recommend) {
    case 'value':
      return 'Value — slipping past his ADP';
    case 'reach':
      return myNextOverall !== undefined
        ? `Reach now — ${c.position} thins out before pick ${myNextOverall}`
        : `Reach now — ${c.position} is thinning out`;
    default:
      return 'Can wait — comparable value should return';
  }
}

function toView(c: Candidate, myNextOverall: number | undefined): CandidateView {
  return {
    name: c.name,
    position: c.position,
    tier: c.tier,
    adp: c.adp,
    recommend: c.recommend,
    reason: reasonFor(c, myNextOverall),
    vona: c.vona,
  };
}

/** Project a live session + pool into the dashboard view. Pure and deterministic. */
export function buildAdviceView(
  session: DraftSession,
  pool: PlayerTier[],
  opts: BuildAdviceOptions = {},
): AdviceView {
  const { leagueSize, myTeamId, order, rounds, rosterSlots } = session.config;
  const state = toDraftState(session);
  const candidates = bestAvailable(pool, state);

  const totalPicks = leagueSize * rounds;
  const boardComplete = session.picks.length >= totalPicks;
  const complete = opts.complete ?? boardComplete;
  // Once every pick is in, picks.length+1 rolls past the board; clamp the clock fields so the
  // header shows the final pick instead of inventing a nonexistent extra round.
  const currentOverall = Math.min(session.picks.length + 1, totalPicks);
  const round = Math.ceil(currentOverall / leagueSize);
  const pickInRound = currentOverall - (round - 1) * leagueSize;
  const onTheClockSlot = slotOnClock(currentOverall, leagueSize, order);

  const upcoming = myUpcomingOveralls(session);
  const myNextOverall = upcoming[0];
  const picksUntilMine =
    myNextOverall !== undefined ? Math.max(0, myNextOverall - currentOverall) : undefined;

  // Position lookup for roster/recent display: match pick names against the pool.
  const positionByName = new Map<string, Position>();
  for (const p of pool) positionByName.set(normalizeName(p.name), p.position);

  // Your picks: the session doesn't carry reliable team ids (a DOM scrape leaves them 0), so
  // attribute by the overall numbers your snake slot owns.
  const myOveralls = new Set(draftOrder(myTeamId, leagueSize, rounds, order));
  const myRoster: RosterSpot[] = session.picks
    .filter((p) => myOveralls.has(p.overall))
    .sort((a, b) => a.overall - b.overall)
    .map((p) => ({
      position: positionByName.get(normalizeName(p.playerName)) ?? 'FLEX',
      name: p.playerName,
      overall: p.overall,
    }));

  const needs = computeNeeds(myRoster, rosterSlots);

  const alternativesCount = opts.alternatives ?? 5;
  const recommended = candidates[0] ? toView(candidates[0], myNextOverall) : undefined;
  const alternatives = candidates
    .slice(1, 1 + alternativesCount)
    .map((c) => toView(c, myNextOverall));

  const byNeed = needs
    .map((position) => {
      const best = candidates.find((c) => c.position === position);
      return best ? { position, candidate: toView(best, myNextOverall) } : undefined;
    })
    .filter((x): x is { position: Position; candidate: CandidateView } => x !== undefined);

  const recentCount = opts.recent ?? 8;
  const recentPicks: RecentPick[] = [...session.picks]
    .sort((a, b) => b.overall - a.overall)
    .slice(0, recentCount)
    .map((p) => ({
      overall: p.overall,
      slot: slotOnClock(p.overall, leagueSize, order),
      name: p.playerName,
      mine: myOveralls.has(p.overall),
    }));

  return {
    currentOverall,
    round,
    pickInRound,
    onTheClockSlot,
    mySlot: myTeamId,
    isMyPick: onTheClockSlot === myTeamId && !complete,
    myNextOverall,
    picksUntilMine,
    recommended,
    alternatives,
    byNeed,
    needs,
    myRoster,
    recentPicks,
    remaining: candidates.length,
    poolSize: pool.length,
    complete,
    adp: opts.adp,
  };
}

/** Positions where you haven't yet filled your dedicated starting slots. */
function computeNeeds(roster: RosterSpot[], rosterSlots: Record<string, number>): Position[] {
  const filled = new Map<Position, number>();
  for (const spot of roster) {
    if (spot.position === 'FLEX') continue;
    filled.set(spot.position, (filled.get(spot.position) ?? 0) + 1);
  }
  const needs: Position[] = [];
  for (const pos of STARTER_POSITIONS) {
    const required = rosterSlots[pos] ?? 0;
    if ((filled.get(pos) ?? 0) < required) needs.push(pos);
  }
  return needs;
}
