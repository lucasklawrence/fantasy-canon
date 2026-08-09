/**
 * Lane choreography for the draft-order race (#235) — the pure, DOM-free half of the race
 * renderer, mirroring the `ballAssignments.ts` / `hopperSim.ts` split.
 *
 * The race is a continuous rendering of the same beat→reveal event stream the ball machine
 * consumes (ADR 0006: the client never receives the final order early). Racers jockey with
 * purely cosmetic motion; every consequential position comes from a published reveal. The one
 * rule that matters lives here: a reveal for the **lowest still-open pick** is a winner crossing
 * the line, anything else is a racer falling off the pace — which reproduces both #200 reveal
 * orders (worst-to-first: eleven falls then one triumphant cross; first-to-last: winners cross in
 * order) without the direction ever riding the wire.
 */

import { assignBallRanges } from './ballAssignments.js';

/** One racer's lane: row order = lane order, hue identical to the team's balls and swatch. */
export interface RaceLane {
  team: string;
  hue: number;
  /** 0-based lane index, top to bottom — the odds-table row order every surface shares. */
  lane: number;
}

/**
 * Track geometry as fractions of the drawable width, shared by the sim and its tests.
 *
 * The back of the track is the standings board: every team that has been drawn parks there in pick
 * order, so by the finish the field reads bottom-to-top as the draft order itself. That zone needs
 * real estate — the first cut gave it the leftmost 18% with a fixed 1.8%-per-place step, about 21px
 * between neighbours against a 28px ball, so the parked field read as a clump and the ordering was
 * invisible. It now owns everything behind the pack.
 */
export const FALL_ZONE_START = 0.03;
/** Front of the standings zone. The pack never comes back past this, so the order stays readable. */
export const FALL_ZONE_END = 0.42;
/**
 * How far back a still-racing team may drift. Strictly ahead of {@link FALL_ZONE_END}: the old
 * wander floor (`PACK_MIN - 0.1` = 0.14) reached deep INTO the parked field, so a team still in
 * contention could sit behind one already eliminated — which is precisely the reading the parked
 * order is supposed to give.
 */
export const PACK_FLOOR = 0.45;
/**
 * The band a still-racing team's pace maps into: no balls at {@link PACK_MIN}, the biggest stack
 * left at {@link PACK_MAX}.
 *
 * Both ends leave {@link WANDER_MAX} of clearance — PACK_MIN above PACK_FLOOR, PACK_MAX below the
 * line — so the jockeying is bounded by construction rather than by the frame loop's clamp. That
 * clamp still exists as a backstop, but relying on it would flat-top every trailing racer against
 * the floor and quietly delete their wobble.
 */
export const PACK_MIN = 0.5;
/** Right edge of the pace band — nobody drifts across the line uninvited. */
export const PACK_MAX = 0.79;
/** The finish line. */
export const FINISH_X = 0.86;
/** Where a winner parks, just past the line. */
export const CROSS_PARK_X = 0.95;

/**
 * Lanes in odds-table row order, hues from {@link assignBallRanges} — so a racer, its balls in
 * the machine, and its swatch in the odds table are always the same color.
 */
export function assignLanes(rows: { team: string; balls: number }[]): RaceLane[] {
  return assignBallRanges(rows).map((range, i) => ({ team: range.team, hue: range.hue, lane: i }));
}

/** Everything about a lane's rendering that scales with the track's width (#239). */
export interface LaneMetrics {
  /** Lane height in CSS pixels. */
  laneH: number;
  /** Racer radius — grows with the lane so pick numbers stay readable on a big track. */
  ballR: number;
  /** Label font size in CSS pixels. */
  labelFont: number;
  /** Widest the label gutter may grow, in CSS pixels — the track always keeps the lion's share. */
  gutterCap: number;
}

/**
 * Scale the lanes to the width the layout actually gives us (#239): the desktop page used to cap
 * the track at a 300px column with a fixed 64px label gutter, ellipsizing every real team name
 * while the monitor sat empty. Wider track ⇒ taller lanes, bigger balls, a touch more font, and
 * room for the gutter to fit whole names — all clamped so a phone keeps the compact look.
 */
export function laneMetrics(trackWidth: number): LaneMetrics {
  const laneH = Math.round(Math.min(40, Math.max(26, trackWidth / 28)));
  return {
    laneH,
    ballR: Math.max(9, Math.round(laneH * 0.36)),
    labelFont: Math.round(Math.min(13, Math.max(10, laneH * 0.42))),
    gutterCap: Math.round(trackWidth * 0.32),
  };
}

/**
 * What a reveal does to its racer. `'cross'` when `pick` is the lowest pick not already locked —
 * the best slot still open, so this racer beat everyone left. `'fall'` otherwise — a better slot
 * remains contested, so this racer visibly drops off the pace and fixes there.
 */
export function lockKind(pick: number, lockedPicks: number[], teamCount: number): 'cross' | 'fall' {
  const locked = new Set(lockedPicks);
  for (let p = 1; p <= teamCount; p += 1) {
    if (p === pick) return 'cross';
    if (!locked.has(p)) return 'fall';
  }
  // `pick` outside 1..teamCount, or already locked — malformed input; a fall is the quiet answer.
  return 'fall';
}

/**
 * How far a racer may drift from its pace. Bounded so the track keeps meaning what it says: the
 * jockeying is life, not noise, and two racers can only trade places when their stacks are close
 * enough that the outcome really is close. A leader cannot wander behind a longshot.
 */
export const WANDER_MAX = 0.035;

/**
 * A still-racing team's place on the track: distance is its stack measured against the biggest one
 * still in the bag (live feedback — "total distance per ball").
 *
 * Before this the pack jockeyed around random midpoints, so a racer's position said nothing at all
 * — which is why a front-runner being drawn read as arbitrary rather than as an upset. Now the
 * leader is the favourite, and the field is a live picture of the odds.
 *
 * Measured against the REMAINING leader, so eliminating the front-runner promotes everyone behind
 * it: your stack is worth more once a bigger one leaves the bag, and the field surges to show it.
 */
export function paceFor(balls: number, leaderBalls: number): number {
  if (!(leaderBalls > 0)) return PACK_MIN;
  const ratio = Math.min(1, Math.max(0, balls / leaderBalls));
  return PACK_MIN + ratio * (PACK_MAX - PACK_MIN);
}

/**
 * Where a fallen racer parks, as a fraction of the drawable width. The worst pick sits furthest
 * back and each better pick a step ahead, so the dropped-off field reads as the order so far.
 *
 * Spread across the whole standings zone rather than stepped by a fixed amount, so the gap between
 * neighbours is as large as the league size allows and a 4-team draw is as legible as a 12-team
 * one. The last pick to fall is #2 — pick #1 always crosses the line — so the front of the zone is
 * left for it and the arithmetic runs over `teamCount - 1` places.
 */
export function fallPosition(pick: number, teamCount: number): number {
  const places = Math.max(1, teamCount - 1);
  const stepsAhead = Math.min(places, Math.max(0, teamCount - pick));
  return FALL_ZONE_START + (stepsAhead / places) * (FALL_ZONE_END - FALL_ZONE_START);
}
