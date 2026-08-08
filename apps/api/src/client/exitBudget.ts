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

/*
 * The three durations below are the SOURCE for the phases they name, not copies of them. This
 * module is the pure end of the dependency, so everything that performs a phase reads its length
 * from here: `hopperSim` imports EXTRACT_MS for its extraction easing, and the page's two CSS
 * durations are `var(--tube-ms)` / `var(--flip-ms)`, written from these by `lottery.ts`. An earlier
 * revision hand-copied all three and TUBE_MIN_MS was already 20ms adrift from the stylesheet — a
 * planner that budgets numbers nobody actually animates is how the overrun comes back.
 */

/** How long the drawn ball takes to swim from the pile to the chute mouth (`hopperSim`). */
export const EXTRACT_MS = 620;
/** The drop ball's spring-in (`#drop .dropball.flip`, via `--flip-ms`). */
export const FLIP_MS = 620;
/** #215's original transit (`#tube-ball.transit`, via `--tube-ms`). The floor: this plan may add
 * time, never make the exit worse. */
export const TUBE_MIN_MS = 400;
/** Past this the descent stops reading as motion and starts reading as lag. */
const TUBE_MAX_MS = 700;
/** A hold longer than this is a stare, not a beat. */
const HOLD_MAX_MS = 600;
/** Below this a "hold" is a flicker; not worth the extra element on screen. */
const HOLD_MIN_MS = 200;
/** Slack kept clear of the gap so one slow frame cannot turn a fit into an overrun. */
const SAFETY_MS = 100;
/**
 * The sim's own failsafe: an extraction still running at this point snaps to done rather than
 * stall a reveal. So this — not {@link EXTRACT_CAP_MS} — is the most a *successful* extraction can
 * cost, and therefore the worst case the re-plan ever has to absorb.
 */
export const EXTRACT_SNAP_MS = 1500;
/**
 * How long the caller waits on the extraction before giving up on it entirely. Deliberately above
 * {@link EXTRACT_SNAP_MS} so the sim always gets to finish and snap first; the extra 300ms only
 * matters when the rAF loop is not running at all (hidden or throttled tab), and in that case the
 * race is lost, `flew` is false, and no descent is attempted.
 */
export const EXTRACT_CAP_MS = 1800;

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
   *
   * `skip` is only ever returned when planning AHEAD. Once the extraction has run there is no
   * such thing as skipping: the ball has already left the pile and been deleted from the canvas,
   * so it must be shown reaching the mouth or it simply vanishes there.
   */
  mode: 'full' | 'plain' | 'skip';
  /** Chute descent. 0 only in `skip`, which a re-plan never returns. */
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
 *
 * `spentExtractingMs` re-plans the REST of the chain once the extraction is done and its real cost
 * is known. The extraction is the one phase whose duration this module cannot dictate: it resolves
 * from the sim's rAF loop, which a throttled or occluded tab may not run at all, so the caller
 * races it against a cap several times EXTRACT_MS. Passing what it actually cost turns the
 * remaining phases into an honest plan instead of one built on an assumption that already failed —
 * without it a slow extraction spends the hold's budget and the next event wipes the card
 * mid-spring, which is the precise overrun this module exists to prevent.
 */
export function exitBudget(gapMs: number, spentExtractingMs?: number): ExitBudget {
  const gap = Number.isFinite(gapMs) && gapMs > 0 ? gapMs : FINISH_LEAD_MS;
  const sunk =
    Number.isFinite(spentExtractingMs) && (spentExtractingMs as number) > 0
      ? (spentExtractingMs as number)
      : null;
  const extractMs = sunk ?? EXTRACT_MS;
  const fixed = extractMs + FLIP_MS + SAFETY_MS;
  const room = gap - fixed;
  if (room < TUBE_MIN_MS) {
    // Planning ahead, nothing has moved yet, so the whole flourish goes: no extraction, no
    // descent, just the landing.
    if (sunk === null) return { mode: 'skip', transitMs: 0, holdMs: 0, totalMs: FLIP_MS };
    // Re-planning, the ball is already out of the pile — `settleExtraction` deleted it from the
    // canvas before resolving — so the descent is no longer discretionary: drop it and the ball
    // disappears at the mouth with nothing rendering the handoff. Only the hold can be given
    // back. Overrunning by the floor beats a ball that vanishes.
    return {
      mode: 'plain',
      transitMs: TUBE_MIN_MS,
      holdMs: 0,
      totalMs: sunk + TUBE_MIN_MS + FLIP_MS,
    };
  }

  const transitMs = Math.round(Math.min(TUBE_MAX_MS, Math.max(TUBE_MIN_MS, room * 0.4)));
  const spare = room - transitMs;
  const holdMs = spare >= HOLD_MIN_MS ? Math.round(Math.min(HOLD_MAX_MS, spare)) : 0;
  return {
    mode: holdMs > 0 ? 'full' : 'plain',
    transitMs,
    holdMs,
    totalMs: extractMs + transitMs + holdMs + FLIP_MS,
  };
}
