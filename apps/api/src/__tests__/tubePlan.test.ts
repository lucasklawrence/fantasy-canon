import { describe, expect, it } from 'vitest';

import { EXTRACT_CAP_MS, tubePlan } from '../client/tubePlan.js';

/** The reveal delays the begin request accepts (#233's closed vocabulary), in ms. */
const DELAYS = [5000, 10000, 20000, 30000];

describe('tubePlan (#258)', () => {
  it('always leaves the drop ball room inside the reveal gap', () => {
    // The hard constraint: extraction (worst case) plus the whole close-up must finish well
    // before the next beat, or back-to-back picks overlap and the drop ball is never seen.
    for (const delayMs of DELAYS) {
      const plan = tubePlan(delayMs);
      expect(plan.totalMs + EXTRACT_CAP_MS).toBeLessThan(delayMs * 0.7);
    }
  });

  it('gives the fastest pacing a real beat and slower pacings a longer one', () => {
    const fast = tubePlan(5000);
    const slow = tubePlan(30000);
    // Even the pinched case is long enough to register as a hold, not a flicker.
    expect(fast.dwellMs).toBeGreaterThanOrEqual(200);
    expect(slow.dwellMs).toBeGreaterThan(fast.dwellMs);
    // …and the transit is slower than #215's fixed 420ms in every case, since that is the
    // window the face is first legible in.
    expect(fast.transitMs).toBeGreaterThanOrEqual(420);
  });

  it('saturates rather than growing without bound — a long stare is tedious, not dramatic', () => {
    expect(tubePlan(30000)).toEqual(tubePlan(10000));
    const capped = tubePlan(30000);
    expect(capped.transitMs).toBeLessThanOrEqual(760);
    expect(capped.presentMs).toBeLessThanOrEqual(320);
    expect(capped.dwellMs).toBeLessThanOrEqual(900);
  });

  it('survives degenerate and hostile delays without inverting', () => {
    // A replay/catch-up compresses pacing hard, and an older api could omit delayMs entirely.
    for (const delayMs of [0, -1, 1, 250, Number.NaN]) {
      const plan = tubePlan(Number.isNaN(delayMs) ? 0 : delayMs);
      expect(plan.transitMs).toBeGreaterThan(0);
      expect(plan.presentMs).toBeGreaterThan(0);
      expect(plan.dwellMs).toBeGreaterThan(0);
      expect(plan.totalMs).toBe(plan.transitMs + plan.presentMs + plan.dwellMs);
    }
  });

  it('adds up — totalMs is what the caller actually spends', () => {
    for (const delayMs of DELAYS) {
      const plan = tubePlan(delayMs);
      expect(plan.totalMs).toBe(plan.transitMs + plan.presentMs + plan.dwellMs);
    }
  });
});
