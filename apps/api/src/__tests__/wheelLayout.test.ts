import { describe, expect, it } from 'vitest';

import {
  buildWedges,
  landingRotation,
  POINTER_RAD,
  wedgeAtPointer,
} from '../client/wheelLayout.js';

const TAU = Math.PI * 2;
/** A lopsided bag, so "arc is proportional to balls" is actually visible in the numbers. */
const BAG = [
  { team: 'Alpha', balls: 6 },
  { team: 'Bravo', balls: 3 },
  { team: 'Charlie', balls: 2 },
  { team: 'Delta', balls: 1 },
];

describe('buildWedges (#244)', () => {
  it('gives each team arc in proportion to its balls — the wheel IS the odds table', () => {
    const wedges = buildWedges(BAG);
    const total = BAG.reduce((sum, row) => sum + row.balls, 0);
    for (const wedge of wedges) {
      const span = wedge.endRad - wedge.startRad;
      expect(span).toBeCloseTo((wedge.balls / total) * TAU, 6);
    }
  });

  it('closes the ring exactly, with no seam and no overlap', () => {
    const wedges = buildWedges(BAG);
    expect(wedges[0].startRad).toBe(0);
    expect(wedges[wedges.length - 1].endRad).toBe(TAU);
    for (let i = 1; i < wedges.length; i += 1) {
      expect(wedges[i].startRad).toBeCloseTo(wedges[i - 1].endRad, 12);
    }
  });

  it('drops drawn teams and re-spreads the rest over the whole wheel', () => {
    const wedges = buildWedges(BAG, ['Alpha']);
    expect(wedges.map((w) => w.team)).toEqual(['Bravo', 'Charlie', 'Delta']);
    expect(wedges[wedges.length - 1].endRad).toBe(TAU);
    // Bravo had 3 of 12; with Alpha gone it has 3 of 6, so its arc doubles.
    expect(wedges[0].endRad - wedges[0].startRad).toBeCloseTo(TAU / 2, 6);
  });

  it('keeps a team’s colour when someone else is drawn', () => {
    const before = buildWedges(BAG).find((w) => w.team === 'Charlie');
    const after = buildWedges(BAG, ['Alpha']).find((w) => w.team === 'Charlie');
    expect(after?.hue).toBe(before?.hue);
  });

  it('drops zero-ball rows rather than leaving slivers the pointer cannot resolve', () => {
    const wedges = buildWedges([...BAG, { team: 'Echo', balls: 0 }]);
    expect(wedges.map((w) => w.team)).not.toContain('Echo');
  });

  it('returns nothing rather than dividing by zero on an empty field', () => {
    expect(buildWedges([])).toEqual([]);
    expect(buildWedges(BAG, ['Alpha', 'Bravo', 'Charlie', 'Delta'])).toEqual([]);
  });
});

describe('landingRotation (#244)', () => {
  /**
   * The property the whole visual rests on: every viewer derives the landing from public data, so
   * the wheel cannot stop on a different team on two screens — and it must stop on the team the
   * reveal actually named.
   */
  it('lands the named team under the pointer, for every team and every pick', () => {
    const wedges = buildWedges(BAG);
    for (const wedge of wedges) {
      for (const pick of [1, 2, 3, 7, 12]) {
        const rotation = landingRotation(wedges, wedge.team, pick);
        expect(wedgeAtPointer(wedges, rotation)?.team).toBe(wedge.team);
      }
    }
  });

  it('is a pure function of its inputs — two viewers compute the same number', () => {
    const wedges = buildWedges(BAG);
    const a = landingRotation(wedges, 'Bravo', 4, 1.234);
    const b = landingRotation(wedges, 'Bravo', 4, 1.234);
    expect(a).toBe(b);
  });

  it('always turns forwards, and by at least the minimum spin', () => {
    const wedges = buildWedges(BAG);
    // From a variety of resting positions, including well past a full turn.
    for (const from of [0, 0.1, Math.PI, TAU * 2.7, TAU * 9]) {
      for (const wedge of wedges) {
        const rotation = landingRotation(wedges, wedge.team, 5, from);
        expect(rotation).toBeGreaterThanOrEqual(from + 3 * TAU);
        // …and still on the right team after all those turns.
        expect(wedgeAtPointer(wedges, rotation)?.team).toBe(wedge.team);
      }
    }
  });

  it('varies the spin with the pick so consecutive landings do not look identical', () => {
    const wedges = buildWedges(BAG);
    const even = landingRotation(wedges, 'Alpha', 2);
    const odd = landingRotation(wedges, 'Alpha', 3);
    expect(even).not.toBe(odd);
    // Same destination, different journey.
    expect(wedgeAtPointer(wedges, even)?.team).toBe('Alpha');
    expect(wedgeAtPointer(wedges, odd)?.team).toBe('Alpha');
  });

  it('stays put for a team that is not on the wheel', () => {
    const wedges = buildWedges(BAG, ['Alpha']);
    expect(landingRotation(wedges, 'Alpha', 1, 2.5)).toBe(2.5);
  });
});

describe('wedgeAtPointer (#244)', () => {
  it('reads the wedge at 12 o’clock, not at the +x axis', () => {
    const wedges = buildWedges(BAG);
    // Unrotated, the pointer sits three quarters of the way round the ring.
    const at = POINTER_RAD < 0 ? POINTER_RAD + TAU : POINTER_RAD;
    const expected = wedges.find((w) => at >= w.startRad && at < w.endRad);
    expect(wedgeAtPointer(wedges, 0)?.team).toBe(expected?.team);
  });

  it('has no answer for an empty wheel', () => {
    expect(wedgeAtPointer([], 1)).toBeUndefined();
  });
});
