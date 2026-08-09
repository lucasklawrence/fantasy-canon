import { describe, expect, it } from 'vitest';

import { ballRadius, drumGeometry } from '../client/ballAssignments.js';

/**
 * The drum became responsive in #256 (`--hopper-px`, 254 → 334 at ≥1500px) but its scene was still
 * derived once at construction, so #267 gave the sim an `ensureSize`. These pin the relationships
 * that re-derivation has to preserve — the sim itself cannot notice getting them wrong: a
 * mis-placed chute mouth just steers the drawn ball somewhere odd, and a wall that no longer
 * matches the canvas just lets the pile drift out of frame.
 */
describe('drumGeometry (#267)', () => {
  // The two sizes the stylesheet actually produces, plus the pre-#256 fixed drum.
  const SIZES = [254, 334, 260];

  it('centres the drum in its canvas at every size', () => {
    for (const size of SIZES) {
      expect(drumGeometry(size).center).toBe(size / 2);
    }
  });

  it('keeps the wall inside the canvas, with room for the cage segments', () => {
    for (const size of SIZES) {
      const { center, wallRadius } = drumGeometry(size);
      expect(wallRadius).toBeLessThan(center); // inset, not flush
      // The segments sit at wallRadius + 5 and are 10 deep, so the wall cannot hug the edge.
      expect(center - wallRadius).toBeGreaterThanOrEqual(4);
    }
  });

  it('puts the chute mouth at the bottom centre — where the tube actually is', () => {
    for (const size of SIZES) {
      const { center, chuteMouth } = drumGeometry(size);
      expect(chuteMouth.x).toBe(center);
      expect(chuteMouth.y).toBe(size - 10);
      // Below the middle: an extraction steers downward, and a mouth above centre would send the
      // ball back up through the pile.
      expect(chuteMouth.y).toBeGreaterThan(center);
    }
  });

  it('scales monotonically, so the wide breakpoint is a bigger drum and not just a bigger canvas', () => {
    const small = drumGeometry(254);
    const large = drumGeometry(334);
    expect(large.wallRadius).toBeGreaterThan(small.wallRadius);
    expect(large.chuteMouth.y).toBeGreaterThan(small.chuteMouth.y);
  });

  it('gives a bigger wall more room per ball, so a resize really re-fits the pile', () => {
    // The packing-fit radius is a function of the wall (#211), which is why a resize has to
    // rebuild the pile rather than reuse bodies sized for the old drum.
    const bag = 78; // a real 12-team bag
    const small = ballRadius(bag, drumGeometry(254).wallRadius);
    const large = ballRadius(bag, drumGeometry(334).wallRadius);
    expect(large).toBeGreaterThan(small);
  });
});
