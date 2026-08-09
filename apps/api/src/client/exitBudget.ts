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
 * How long the caller waits on the extraction before giving up on it.
 *
 * This is the only real bound on it, and therefore the worst case the re-plan has to absorb. The
 * sim settles the extraction on the first animation frame at or after {@link EXTRACT_MS}, so under
 * a starved rAF loop — GC pause, compositor contention, a throttled phone — a *successful*
 * extraction can cost anything up to this. (The sim also carries a nominal failsafe of its own,
 * but it is unreachable: its `t` saturates at 1 well before the failsafe's deadline, so the frame
 * check always decides first. Do not budget against it.)
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
   * cannot fit even that, so the drop card lands straight away.
   *
   * `skip` means two slightly different things depending on when it is asked for. Planning ahead,
   * the pile keeps its ball because the caller never starts an extraction at all. Re-planning, the
   * extraction has already run and taken the ball with it, so the caller must anchor the FLIP at
   * the chute mouth — see the note on {@link exitBudget}.
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
  // Not even the baseline descent fits: straight to the landing, which still costs the FLIP.
  //
  // Padding the descent out to its floor here instead was tried and is worse. On the finale — the
  // last reveal, whose gap is the 1800ms finish lead — a slow extraction plus a mandatory 400ms
  // slide finishes AFTER `renderFinish` has bumped `choreoToken`, so the run aborts at its next
  // token check and pick #1's card never renders at all. Landing early is a smaller loss than
  // landing after the ceremony has moved on. What makes this safe is on the caller's side: the
  // FLIP anchors at the chute mouth whenever the descent did not actually run, so the card still
  // springs from where the ball was last seen rather than from an un-transited tube ball.
  if (room < TUBE_MIN_MS) {
    // Planning ahead the extraction is skipped too, so it costs nothing; re-planning it is
    // already spent and has to be billed whether it earned anything or not.
    return { mode: 'skip', transitMs: 0, holdMs: 0, totalMs: (sunk ?? 0) + FLIP_MS };
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
