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

/** Track geometry as fractions of the drawable width, shared by the sim and its tests. */
export const FALL_ZONE_START = 0.03;
/** Left edge of the band the un-locked pack jockeys inside. */
export const PACK_MIN = 0.24;
/** Right edge of the jockeying band — nobody drifts across the line uninvited. */
export const PACK_MAX = 0.68;
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
 * Where a fallen racer parks, as a fraction of the drawable width. The worst pick sits furthest
 * back and each better pick a step ahead, so the dropped-off field reads as the order so far.
 * Clamped under {@link PACK_MIN} — the parked stragglers never mix back into the live pack.
 */
export function fallPosition(pick: number, teamCount: number): number {
  const stepsAhead = Math.max(0, teamCount - pick);
  return Math.min(PACK_MIN - 0.03, FALL_ZONE_START + stepsAhead * 0.018);
}
