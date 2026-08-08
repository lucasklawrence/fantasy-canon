import { describe, expect, it } from 'vitest';

import { catchUpPace, REPLAY_DWELL_MS, REPLAY_MAX_STEP_MS } from '../client/replayTimeline.js';
import {
  exitBudget,
  EXTRACT_MS,
  EXTRACT_SNAP_MS,
  FINISH_LEAD_MS,
  FLIP_MS,
  TUBE_MIN_MS,
} from '../client/exitBudget.js';

/**
 * The gaps the client can ACTUALLY hand the planner, derived from the code that produces them
 * rather than hand-written — #258's budget tests passed against a table of states the client
 * could never reach, which is how a dead branch shipped green.
 */
const LIVE_DELAYS = [5000, 10000, 20000, 30000]; // #233's closed vocabulary
/** Replay compresses to `replayStepMs`; a catch-up sprint compresses that again. */
const REPLAY_STEP = Math.min(5000, REPLAY_MAX_STEP_MS);
const SPRINT = catchUpPace(REPLAY_STEP, 12); // deep queue → the 0.35 factor
const HURRY = catchUpPace(REPLAY_STEP, 4); // shallower → 0.6
const REACHABLE = [SPRINT, HURRY, REPLAY_DWELL_MS, REPLAY_STEP, ...LIVE_DELAYS];

describe('exitBudget (#265)', () => {
  it('never plans past the gap it was given', () => {
    // The invariant the whole module exists for. #258 budgeted only as far as the FLIP's START,
    // so the drop card was wiped mid-spring; totalMs here includes the landing.
    for (const gap of REACHABLE) {
      expect(exitBudget(gap).totalMs).toBeLessThanOrEqual(gap);
    }
  });

  it('skips the choreography when the gap cannot fit even the baseline exit', () => {
    // A catch-up sprint is tighter than the fixed cost alone. Today's chain overruns it and the
    // drop card never renders at all; skipping the flourish is what makes the result visible.
    const sprint = exitBudget(SPRINT);
    expect(SPRINT).toBeLessThan(1660); // the pre-#265 chain
    expect(sprint.mode).toBe('skip');
    expect(sprint.transitMs).toBe(0);
    expect(sprint.holdMs).toBe(0);
    expect(sprint.totalMs).toBe(FLIP_MS);
  });

  it('leaves the tightest real gap exactly as #215 had it — no hold, no regression', () => {
    // The finish trails the final reveal by this much, and it is the tightest gap that still
    // fits the baseline. The exit must be unchanged there, not squeezed.
    const finish = exitBudget(FINISH_LEAD_MS);
    expect(finish.mode).toBe('plain');
    expect(finish.transitMs).toBe(TUBE_MIN_MS);
    expect(finish.holdMs).toBe(0);
  });

  it('only buys a hold where there is real room, and the hold is worth having', () => {
    for (const gap of LIVE_DELAYS) {
      const plan = exitBudget(gap);
      expect(plan.mode).toBe('full');
      expect(plan.holdMs).toBeGreaterThanOrEqual(200); // never a flicker
    }
    // …and it saturates rather than growing with the delay: a 30s pacing does not mean a 20s stare.
    expect(exitBudget(30000)).toEqual(exitBudget(10000));
  });

  it('never shortens the descent below the exit it replaces', () => {
    for (const gap of REACHABLE) {
      const plan = exitBudget(gap);
      if (plan.mode !== 'skip') expect(plan.transitMs).toBeGreaterThanOrEqual(TUBE_MIN_MS);
    }
  });

  it('treats an unknown gap as the tightest one that still animates', () => {
    // An older api with no delayMs, or a cursor that has drained: guessing generously would
    // overrun a gap that turned out to be short.
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      expect(exitBudget(bad)).toEqual(exitBudget(FINISH_LEAD_MS));
    }
  });

  it('adds up — totalMs is what the caller actually spends', () => {
    for (const gap of REACHABLE) {
      const plan = exitBudget(gap);
      const moving = plan.mode === 'skip' ? 0 : EXTRACT_MS + plan.transitMs + plan.holdMs;
      expect(plan.totalMs).toBe(moving + FLIP_MS);
    }
  });
});

/**
 * The extraction is the one phase the planner cannot dictate: it resolves from the sim's rAF loop,
 * which a hidden, throttled or occluded tab may not run, so the caller races it against a cap
 * three times its nominal length. Planning the hold on the assumption it took 620ms and then
 * discovering it took 1800 is how the drop card gets wiped mid-spring anyway.
 */
describe('exitBudget re-planned after the extraction (#265)', () => {
  /**
   * EXTRACT_MS is the happy path; the rest are a tab that was barely being painted. The ceiling is
   * the sim's own snap, NOT the caller's give-up cap: past the snap the extraction resolves itself,
   * and if even that never happens the race is lost, `flew` is false, and the caller never
   * re-plans at all. Testing 1800 here would be asserting over a spend the client cannot hand us.
   */
  const SPENDS = [EXTRACT_MS, 900, 1400, EXTRACT_SNAP_MS];
  /**
   * Only gaps whose up-front plan actually runs an extraction ever reach the re-plan — the caller
   * re-plans on `flew`, and it does not extract at all in `skip`. Asserting over the others would
   * be inventing states again.
   */
  const REPLANNED = REACHABLE.filter((gap) => exitBudget(gap).mode !== 'skip');

  it('an on-time extraction re-plans to exactly what was planned up front', () => {
    expect(REPLANNED.length).toBeGreaterThan(0);
    for (const gap of REPLANNED) {
      expect(exitBudget(gap, EXTRACT_MS)).toEqual(exitBudget(gap));
    }
  });

  it('never adds anything that pushes the chain past the gap', () => {
    // Sunk by now: what the extraction cost, the floor descent the ball must be shown making, and
    // the landing. Everything above that floor has to fit inside the gap or be given back.
    for (const gap of REACHABLE) {
      for (const spent of SPENDS) {
        const plan = exitBudget(gap, spent);
        const floor = spent + TUBE_MIN_MS + FLIP_MS;
        expect(plan.totalMs).toBeLessThanOrEqual(Math.max(gap, floor));
      }
    }
  });

  // The state that made the first attempt at this re-plan wrong: `skip` after a successful
  // extraction. `settleExtraction` has already deleted the ball from the pile canvas by then, so
  // skipping the descent does not save the flourish — it makes the ball vanish at the mouth and
  // leaves the FLIP anchored to a `#tube-ball` that never moved.
  it('never returns skip once the ball has left the pile', () => {
    for (const gap of REACHABLE) {
      for (const spent of SPENDS) {
        const plan = exitBudget(gap, spent);
        expect(plan.mode).not.toBe('skip');
        expect(plan.transitMs).toBeGreaterThanOrEqual(TUBE_MIN_MS);
      }
    }
  });

  it('gives back the hold, but not the descent, once the extraction has eaten the gap', () => {
    // A replay dwell is 1800ms and the extraction snapped at 1500: there is nothing left to spend,
    // so the hold goes and the descent drops to its floor. Overrunning by the floor is the correct
    // trade — the alternative is a ball that disappears.
    const blown = exitBudget(REPLAY_DWELL_MS, EXTRACT_SNAP_MS);
    expect(blown.mode).toBe('plain');
    expect(blown.transitMs).toBe(TUBE_MIN_MS);
    expect(blown.holdMs).toBe(0);
    expect(blown.totalMs).toBe(EXTRACT_SNAP_MS + TUBE_MIN_MS + FLIP_MS);
  });

  it('still affords the hold at live pacing even on the slowest extraction', () => {
    // Live has room to spare; a slow extraction must not cost the viewer the beat the gap can pay
    // for. This is the case that would regress if the re-plan were a blanket downgrade.
    for (const gap of LIVE_DELAYS) {
      const plan = exitBudget(gap, EXTRACT_SNAP_MS);
      expect(plan.mode).toBe('full');
      expect(plan.totalMs).toBeLessThanOrEqual(gap);
    }
  });
});
