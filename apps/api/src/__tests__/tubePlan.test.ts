import { describe, expect, it } from 'vitest';

import { EXTRACT_TYPICAL_MS, MIN_GAP_MS, tubePlan, type TubePlan } from '../client/tubePlan.js';

/**
 * Every gap the client can actually hand the planner: the fixed finish lead (the tightest, and
 * the one that used to eat the final pick's drop card), the compressed replay cadence, and the
 * live reveal delays from #233's closed vocabulary.
 */
const GAPS = [MIN_GAP_MS, 2500, 5000, 10000, 20000, 30000];

/** What the whole choreography costs on a normal (non-hidden) reveal. */
const spend = (plan: TubePlan): number => plan.totalMs + EXTRACT_TYPICAL_MS;

describe('tubePlan (#258)', () => {
  it('always finishes before the next event supersedes the reveal', () => {
    // The regression this guards: the close-up grew the post-extraction tail past the fixed
    // 1800ms finish lead, so the last pick's drop card was torn down mid-grow.
    for (const gapMs of GAPS) {
      expect(spend(tubePlan(gapMs))).toBeLessThan(gapMs);
    }
  });

  it('leaves slack even at the tightest gap, so a slow frame cannot turn a fit into an overrun', () => {
    expect(spend(tubePlan(MIN_GAP_MS))).toBeLessThanOrEqual(MIN_GAP_MS - 150);
  });

  it('never makes the exit worse than the #215 baseline it replaces', () => {
    // 420ms was the old fixed transit; the close-up may be brief, but the descent must not be
    // shorter than it was before the feature existed.
    for (const gapMs of GAPS) {
      expect(tubePlan(gapMs).transitMs).toBeGreaterThanOrEqual(420);
      expect(tubePlan(gapMs).dwellMs).toBeGreaterThan(0);
    }
  });

  it('gives a roomier gap a longer hold, then saturates', () => {
    const tight = tubePlan(MIN_GAP_MS);
    const roomy = tubePlan(5000);
    expect(roomy.dwellMs).toBeGreaterThan(tight.dwellMs);
    // Past a point a longer stare is tedious, not dramatic — and the gap stops being the binding
    // constraint anyway, because the finish lead caps it.
    expect(tubePlan(30000)).toEqual(tubePlan(5000));
  });

  it('treats an unknown or hostile gap as the tightest one, never the loosest', () => {
    // Guessing generously would overrun a gap that turned out to be short.
    for (const gapMs of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const plan = tubePlan(gapMs);
      expect(Number.isFinite(plan.totalMs)).toBe(true);
      expect(spend(plan)).toBeLessThan(MIN_GAP_MS);
    }
    expect(tubePlan(Number.NaN)).toEqual(tubePlan(MIN_GAP_MS));
  });

  it('adds up — totalMs is what the caller actually spends', () => {
    for (const gapMs of GAPS) {
      const plan = tubePlan(gapMs);
      expect(plan.totalMs).toBe(plan.transitMs + plan.presentMs + plan.dwellMs);
    }
  });
});
