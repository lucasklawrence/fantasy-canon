import { describe, expect, it } from 'vitest';

import { ballRadius, drumGeometry } from '../client/ballAssignments.js';

/**
 * The drum became responsive in #256 (`--hopper-px`, 254 → 334 at ≥1500px) but its scene was still
 * derived once at construction, so #267 gave the sim an `ensureSize`.
 *
 * These assert the CONSEQUENCES of re-deriving at a new size, not the formula. An earlier version
 * of this file restated `cssSize / 2` and `cssSize / 2 - 4` back at themselves, which cannot fail
 * for any input and told a reader nothing — the same "green test over nothing real" trap that put
 * a dead branch under a passing suite in #258 and #265, reached from the opposite direction.
 */
describe('drumGeometry (#267)', () => {
  /** The two sizes the stylesheet actually produces. */
  const NARROW = 254;
  const WIDE = 334;

  it('scales every part of the scene together — a bigger drum, not a bigger canvas', () => {
    const small = drumGeometry(NARROW);
    const large = drumGeometry(WIDE);
    const ratio = WIDE / NARROW;
    // Centre and wall grow with the box; if one lagged, the pile would sit off-centre or spill.
    expect(large.center / small.center).toBeCloseTo(ratio, 6);
    // The wall is inset by a CONSTANT, so its ratio runs slightly ahead of the box's rather than
    // behind it — the inset is a smaller share of the bigger drum. It must still track closely:
    // a wall that grew much faster would push the pile through the cage.
    const wallRatio = large.wallRadius / small.wallRadius;
    expect(wallRatio).toBeGreaterThan(ratio);
    expect(wallRatio).toBeLessThan(ratio * 1.05);
  });

  it('keeps the chute mouth on the drum’s bottom edge at both sizes', () => {
    // The extraction steers the drawn ball here. If it drifted off the rim the ball would be
    // delivered into empty space, or back up through the pile.
    for (const size of [NARROW, WIDE]) {
      const { center, chuteMouth } = drumGeometry(size);
      expect(chuteMouth.x).toBe(center);
      expect(chuteMouth.y).toBeGreaterThan(center); // below the middle
      expect(size - chuteMouth.y).toBeLessThan(size * 0.06); // and hard against the bottom
    }
  });

  it('keeps the wall inside the canvas', () => {
    // Note the CAGE is not: segments sit at wallRadius + 5 and are 10 deep, so their outer edge
    // overhangs the canvas by 6px at every size. That is deliberate and invisible — only the
    // inner face ever touches a ball — but it is why this asserts the wall, not the segments.
    for (const size of [NARROW, WIDE, 260]) {
      const { center, wallRadius } = drumGeometry(size);
      expect(wallRadius).toBeLessThan(center);
    }
  });

  it('re-fits the pile: the wide drum gives a real 12-team bag bigger balls', () => {
    // This is the reason a resize must relay the pile at all — the packing-fit radius is a
    // function of the wall, so bodies sized for the old drum are wrong in the new one.
    const bag = 78;
    const small = ballRadius(bag, drumGeometry(NARROW).wallRadius);
    const large = ballRadius(bag, drumGeometry(WIDE).wallRadius);
    expect(large).toBeGreaterThan(small);
  });

  it('still fits an override-sized bag after growing', () => {
    // 480 balls was the #211 regression: the radius floor has to keep shrinking, not bottom out.
    const huge = ballRadius(480, drumGeometry(WIDE).wallRadius);
    expect(huge).toBeGreaterThan(0);
    expect(huge).toBeLessThan(ballRadius(78, drumGeometry(WIDE).wallRadius));
  });
});
