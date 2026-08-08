/**
 * Tube close-up timing (#258) — the pure, DOM-free half of the drawn ball's exit, split out the
 * same way `rollPlan` was split from `ceremonyAudio`: the repo's root typecheck is deliberately
 * DOM-less, so anything a test imports must not mention DOM types.
 *
 * The exit (#215) sends the drawn ball down the chute in 420ms at 14px — fine for a numbered
 * ball, illegible for a team logo (#252). This plan buys the ball a beat of screen time at the
 * tube mouth.
 *
 * **The gap that matters is not the reveal delay.** A 30-second ceremony does not give the
 * choreography 30 seconds: the client compresses reveals to `replayStepMs` (≤2500ms) on the
 * replay/catch-up paths, and on EVERY path the `finish` lands only `REPLAY_DWELL_MS` (1800ms)
 * after the final reveal — which tears the stage down and supersedes anything still in flight.
 * So the caller passes the tightest gap actually in play, and this plan sizes itself to fit
 * inside it with the typical extraction and a safety margin already deducted.
 */

/** Extraction race cap in `runExitChoreography` — the sim may never resolve in a hidden tab. */
export const EXTRACT_CAP_MS = 1800;

/**
 * What the extraction usually costs (hopperSim's own `EXTRACT_MS`). Budgeting against the 1800ms
 * *cap* would starve the close-up on every normal reveal, and a hidden tab — the only case that
 * reaches the cap — has no animation to overrun anyway.
 */
export const EXTRACT_TYPICAL_MS = 620;

/** Slack kept clear of the gap so a slow frame cannot turn a fit into an overrun. */
const SAFETY_MS = 180;

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

/**
 * Plan the close-up for a reveal whose next event lands `gapMs` from now.
 *
 * Clamped on both ends: a floor so there is always *some* beat, and a ceiling that keeps
 * `EXTRACT_TYPICAL_MS + totalMs + SAFETY_MS` inside `gapMs`. An unknown or hostile gap is
 * treated as the tightest supported one — guessing generously would overrun a gap that turned
 * out to be short, which costs the viewer a drop card.
 */
export function tubePlan(gapMs: number): TubePlan {
  const gap = Number.isFinite(gapMs) && gapMs > 0 ? gapMs : MIN_GAP_MS;
  // Never below the #215 baseline (420ms transit) — this plan may shorten the close-up, but it
  // must not make the exit itself worse than it was before the feature existed.
  const budget = Math.max(420, gap - EXTRACT_TYPICAL_MS - SAFETY_MS);
  const transitMs = Math.round(Math.min(560, Math.max(420, budget * 0.45)));
  const presentMs = Math.round(Math.min(260, Math.max(140, budget * 0.2)));
  const dwellMs = Math.round(Math.min(520, Math.max(120, budget - transitMs - presentMs)));
  return { transitMs, presentMs, dwellMs, totalMs: transitMs + presentMs + dwellMs };
}

/** The tightest gap the ceremony ever presents: the finish's fixed lead after the last reveal. */
export const MIN_GAP_MS = 1800;
