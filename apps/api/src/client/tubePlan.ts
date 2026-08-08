/**
 * Tube close-up timing (#258) — the pure, DOM-free half of the drawn ball's exit, split out the
 * same way `rollPlan` was split from `ceremonyAudio`: the repo's root typecheck is deliberately
 * DOM-less, so anything a test imports must not mention DOM types.
 *
 * The exit (#215) sends the drawn ball down the chute in 420ms at 14px — fine for a numbered
 * ball, illegible for a team logo (#252). This plan buys the ball a beat of screen time at the
 * tube mouth, sized to the ceremony's own pacing: a 5-second ceremony gets a glance, a 30-second
 * one gets a real look. Everything the whole choreography can spend is accounted for here so the
 * one hard constraint stays checkable — it must finish comfortably inside the *shortest* gap
 * between reveals, or back-to-back picks would overlap.
 */

/** Extraction race cap in {@link runExitChoreography} — the sim may never resolve in a hidden tab. */
export const EXTRACT_CAP_MS = 1800;

export interface TubePlan {
  /** Chute descent. Longer than #215's 420ms so the face is readable in transit. */
  transitMs: number;
  /** Grow-to-camera at the mouth. */
  presentMs: number;
  /** Motionless beat at full size — the actual "look at it" moment. */
  dwellMs: number;
  /** transit + present + dwell: what the choreography spends AFTER the extraction resolves. */
  totalMs: number;
}

/** Never exceed this share of the reveal gap, extraction included — the overlap guard. */
const BUDGET_SHARE = 0.62;

/**
 * Plan the close-up for a ceremony pacing reveals `delayMs` apart.
 *
 * Scaled rather than fixed because the delay spans 5s→30s (#233's closed vocabulary): one
 * duration either rushes the slow ceremonies or overruns the fast ones. The result is clamped
 * on both ends — a floor so there is always *some* beat, and a budget ceiling computed against
 * the worst-case extraction so even `delay=5` leaves the drop ball its own screen time.
 *
 * In practice that means `delay=5` is the only pinched case (≈1.3s of close-up, 1.9s of
 * headroom); every longer pacing saturates the per-phase caps at ≈2.0s, because past a point a
 * longer stare is tedious rather than dramatic.
 */
export function tubePlan(delayMs: number): TubePlan {
  // An unknown pacing is assumed to be the TIGHTEST supported one, not the loosest: a missing
  // `delayMs` (an older api, a compressed replay) must never buy the close-up more time than the
  // gap can afford. NaN/Infinity would otherwise poison every arithmetic step below.
  const gap = Number.isFinite(delayMs) && delayMs > 0 ? Math.max(1000, delayMs) : 5000;
  // What the post-extraction phases may spend in total. At delay=5s: 5000*0.62 - 1800 = 1300ms.
  const budget = Math.max(300, gap * BUDGET_SHARE - EXTRACT_CAP_MS);
  const transitMs = Math.round(Math.min(760, Math.max(420, budget * 0.45)));
  const presentMs = Math.round(Math.min(320, Math.max(180, budget * 0.2)));
  // The dwell absorbs whatever is left, so a long ceremony spends its extra time standing still
  // at full size rather than crawling through the tube.
  const dwellMs = Math.round(Math.min(900, Math.max(200, budget - transitMs - presentMs)));
  return { transitMs, presentMs, dwellMs, totalMs: transitMs + presentMs + dwellMs };
}
