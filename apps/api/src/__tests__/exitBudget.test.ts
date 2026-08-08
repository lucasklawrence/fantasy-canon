import { describe, expect, it } from 'vitest';

import { catchUpPace, REPLAY_DWELL_MS, REPLAY_MAX_STEP_MS } from '../client/replayTimeline.js';
import { exitBudget, FINISH_LEAD_MS, FLIP_MS, TUBE_MIN_MS } from '../client/exitBudget.js';

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
      const moving = plan.mode === 'skip' ? 0 : 620 + plan.transitMs + plan.holdMs;
      expect(plan.totalMs).toBe(moving + FLIP_MS);
    }
  });
});
