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
 * Rear of the track while the standings are still empty.
 *
 * The first cut reserved the whole standings zone from the opening frame, which left the field
 * penned into the front third of a track that was mostly empty — the commissioner's "they barely
 * oscillate… there is much more room to move". Nothing is parked at the start, so nothing needs
 * that space yet: the field gets all of it and gives it back as teams fill the zone.
 */
export const RACE_FLOOR = 0.08;
/** Clearance kept between the frontmost parked racer and anything still running. */
export const PARK_GAP = 0.03;
/** Right edge of the pace band — nobody drifts across the line uninvited. */
export const PACK_MAX = 0.79;
/**
 * Share of the available track each racer may wander, either side of its pace.
 *
 * A FRACTION rather than a fixed distance, because the space the field has shrinks as the standings
 * fill: the same 0.18 is a wide, loose swing over an empty track and a tight one late on, which is
 * the shape asked for — big movement early, and progressively less as teams drop off.
 *
 * Under 0.5 by definition, so the two extremes of the field can never cross: close stacks trade
 * places, a leader never drifts behind a longshot.
 */
export const WANDER_FRAC = 0.18;
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

/** The pace band, and how far either side of it a racer may wander. */
export interface PaceBand {
  /** Where a ball-less team sits. */
  min: number;
  /** Where the biggest stack left in the bag sits. */
  max: number;
  /** Wander allowance either side, already inset from the floor and the line. */
  wander: number;
}

/**
 * The rear limit for anything still racing: clear of however much of the standings zone is filled.
 *
 * Starts at {@link RACE_FLOOR} and walks forward as teams park, so the field keeps exactly the room
 * it still has a use for. Takes the frontmost PARKED position rather than a count, because picks
 * are placed by slot, not by the order they were drawn.
 */
export function packFloor(parkedPicks: readonly number[], teamCount: number): number {
  let front = -Infinity;
  for (const pick of parkedPicks) front = Math.max(front, fallPosition(pick, teamCount));
  return front > -Infinity ? Math.max(RACE_FLOOR, front + PARK_GAP) : RACE_FLOOR;
}

/**
 * The band available above a given floor, inset at both ends by the wander it allows.
 *
 * Inset by construction so the jockeying can never reach the parked field or the finish line. The
 * frame loop still clamps as a backstop, but leaning on that clamp would pin every trailing racer
 * flat against the floor and quietly delete their wobble — which is how the first version of this
 * ended up with a field that barely moved.
 */
export function paceBand(floor: number): PaceBand {
  const span = Math.max(0, PACK_MAX - floor);
  const wander = span * WANDER_FRAC;
  return { min: floor + wander, max: PACK_MAX - wander, wander };
}

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
export function paceFor(balls: number, leaderBalls: number, band: PaceBand): number {
  if (!(leaderBalls > 0)) return band.min;
  const ratio = Math.min(1, Math.max(0, balls / leaderBalls));
  return band.min + ratio * (band.max - band.min);
}

/**
 * Where a fallen racer parks, as a fraction of the drawable width. The worst pick sits furthest
 * back and each better pick a step ahead, so the dropped-off field reads as the order so far.
 *
 * Spread across the whole standings zone rather than stepped by a fixed amount, so the gap between
 * neighbours is as large as the league size allows and a 4-team draw is as legible as a 12-team
 * one. The last pick to fall is #2 — pick #1 always crosses the line — so the front of the zone is
 * left for it and the arithmetic runs over `teamCount - 1` places.
 *
 * {@link packFloor} reads this: how much room the field has left is a function of how far forward
 * the standings have filled.
 */
export function fallPosition(pick: number, teamCount: number): number {
  const places = Math.max(1, teamCount - 1);
  const stepsAhead = Math.min(places, Math.max(0, teamCount - pick));
  return FALL_ZONE_START + (stepsAhead / places) * (FALL_ZONE_END - FALL_ZONE_START);
}
