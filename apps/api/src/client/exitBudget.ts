/**
 * The drawn ball's exit, planned as ONE budget (#265) — pure and DOM-free, like `rollPlan` and
 * `replayTimeline`, so it can be reasoned about and tested without a browser.
 *
 * #258 tried three times to slot a "hold the ball up to the camera" beat into this chain and
 * failed each time, because the chain was never modelled end to end. It is four phases, not two:
 *
 * ```
 *   extraction (620)  →  tube transit  →  [hold]  →  the drop ball's own FLIP (620)
 * ```
 *
 * Two of those are fixed costs totalling 1240ms, and the FLIP is the one everybody forgot: the
 * reveal is not "done" when the drop ball is *inserted*, it is done when the ball has finished
 * springing into place. Budget to the insert and the card gets wiped mid-spring.
 *
 * And the gap it has to fit inside is rarely the ceremony's reveal delay:
 * - live, the next beat lands `delayMs` later;
 * - on replay the cadence is compressed to `replayStepMs` (≤2500ms);
 * - during a catch-up **sprint** `catchUpPace` compresses it again by 0.35, to as little as
 *   ~875ms — less than the fixed cost alone;
 * - after the **last** reveal there is no next pick at all, only the finish.
 *
 * So the caller passes the real gap and this returns what fits, including the honest answer that
 * sometimes nothing does.
 */

/** `hopperSim`'s extraction animation — mirrored here because the sim keeps it private. */
export const EXTRACT_MS = 620;
/** The drop ball's spring-in (`#drop .dropball.flip` transition). */
export const FLIP_MS = 620;
/** #215's original transit. The floor: this plan may add time, never make the exit worse. */
export const TUBE_MIN_MS = 420;
/** Past this the descent stops reading as motion and starts reading as lag. */
const TUBE_MAX_MS = 700;
/** A hold longer than this is a stare, not a beat. */
const HOLD_MAX_MS = 600;
/** Below this a "hold" is a flicker; not worth the extra element on screen. */
const HOLD_MIN_MS = 200;
/** Slack kept clear of the gap so one slow frame cannot turn a fit into an overrun. */
const SAFETY_MS = 100;

/**
 * How long the finish trails the final reveal. Fixed at `REPLAY_DWELL_MS` on the replay and
 * catch-up paths; live it is however long the bot takes to render the board PNG and post it,
 * which is longer — so this is the conservative figure for both.
 */
export const FINISH_LEAD_MS = 1800;

export interface ExitBudget {
  /**
   * `full` — transit and a hold. `plain` — transit only, exactly #215's exit. `skip` — the gap
   * cannot fit even that, so the pile keeps its ball and the drop card lands straight away.
   */
  mode: 'full' | 'plain' | 'skip';
  /** Chute descent. 0 in `skip`. */
  transitMs: number;
  /** Motionless beat at the tube mouth. 0 unless `mode` is `full`. */
  holdMs: number;
  /** Everything spent from the reveal until the drop ball has LANDED, FLIP included. */
  totalMs: number;
}

/**
 * Plan the exit for a reveal whose next event lands `gapMs` from now.
 *
 * An unusable gap yields `skip` rather than a squeezed animation: dropping the choreography and
 * showing the result is strictly better than playing a flourish the next event will wipe. That
 * also repairs the catch-up sprint, where the *existing* 1660ms chain already overruns a ~1505ms
 * gap and the drop card never appears at all.
 */
export function exitBudget(gapMs: number): ExitBudget {
  const gap = Number.isFinite(gapMs) && gapMs > 0 ? gapMs : FINISH_LEAD_MS;
  const fixed = EXTRACT_MS + FLIP_MS + SAFETY_MS;
  const room = gap - fixed;
  // Not even the baseline descent fits: skip straight to the landing, which still costs the FLIP.
  if (room < TUBE_MIN_MS) return { mode: 'skip', transitMs: 0, holdMs: 0, totalMs: FLIP_MS };

  const transitMs = Math.round(Math.min(TUBE_MAX_MS, Math.max(TUBE_MIN_MS, room * 0.4)));
  const spare = room - transitMs;
  const holdMs = spare >= HOLD_MIN_MS ? Math.round(Math.min(HOLD_MAX_MS, spare)) : 0;
  return {
    mode: holdMs > 0 ? 'full' : 'plain',
    transitMs,
    holdMs,
    totalMs: EXTRACT_MS + transitMs + holdMs + FLIP_MS,
  };
}
