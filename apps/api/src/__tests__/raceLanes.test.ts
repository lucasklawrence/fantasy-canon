import { describe, expect, it } from 'vitest';

import { assignBallRanges } from '../client/ballAssignments.js';
import {
  assignLanes,
  FALL_ZONE_END,
  FALL_ZONE_START,
  fallPosition,
  laneMetrics,
  lockKind,
  PACK_FLOOR,
  PACK_MIN,
} from '../client/raceLanes.js';

const ROWS = [
  { team: 'Ducks', balls: 3 },
  { team: 'Geese', balls: 1 },
  { team: 'Swans', balls: 2 },
];

describe('assignLanes', () => {
  it('lanes follow odds-table row order with the shared team hues', () => {
    const lanes = assignLanes(ROWS);
    expect(lanes.map((l) => l.team)).toEqual(['Ducks', 'Geese', 'Swans']);
    expect(lanes.map((l) => l.lane)).toEqual([0, 1, 2]);
    // The racer, its balls in the machine, and its odds-table swatch must be one color — the
    // hues come from the same assignment.
    const ranges = assignBallRanges(ROWS);
    expect(lanes.map((l) => l.hue)).toEqual(ranges.map((r) => r.hue));
  });

  it('keeps zero-ball rows so every team still gets a lane', () => {
    const lanes = assignLanes([{ team: 'A', balls: 0 }, ...ROWS]);
    expect(lanes).toHaveLength(4);
    expect(lanes[0]).toMatchObject({ team: 'A', lane: 0 });
  });
});

describe('lockKind', () => {
  it('worst-to-first: everyone falls off the pace until the winner crosses (#235)', () => {
    const teamCount = 4;
    const locked: number[] = [];
    const kinds: string[] = [];
    for (const pick of [4, 3, 2, 1]) {
      kinds.push(lockKind(pick, locked, teamCount));
      locked.push(pick);
    }
    expect(kinds).toEqual(['fall', 'fall', 'fall', 'cross']);
  });

  it('first-to-last: winners cross the line in order (#200 mapping)', () => {
    const teamCount = 4;
    const locked: number[] = [];
    const kinds: string[] = [];
    for (const pick of [1, 2, 3, 4]) {
      kinds.push(lockKind(pick, locked, teamCount));
      locked.push(pick);
    }
    expect(kinds).toEqual(['cross', 'cross', 'cross', 'cross']);
  });

  it('is a pure function of the lock set — arbitrary orders still read correctly', () => {
    // Pick 2 revealed while pick 1 is still open: a better slot remains contested, so it falls.
    expect(lockKind(2, [4, 3], 4)).toBe('fall');
    // Pick 2 revealed after pick 1 went: nothing better is open, so it crosses.
    expect(lockKind(2, [1, 4], 4)).toBe('cross');
  });
});

describe('laneMetrics', () => {
  it('keeps the compact look on narrow tracks and scales up with width (#239)', () => {
    const phone = laneMetrics(360);
    expect(phone.laneH).toBe(26); // the floor — phones keep the original density
    expect(phone.ballR).toBe(9);

    const wide = laneMetrics(1100);
    expect(wide.laneH).toBeGreaterThan(phone.laneH);
    expect(wide.ballR).toBeGreaterThan(phone.ballR);
    expect(wide.labelFont).toBeGreaterThanOrEqual(phone.labelFont);
    expect(wide.labelFont).toBeLessThanOrEqual(13); // legible, never billboard

    expect(laneMetrics(5000).laneH).toBe(40); // the ceiling — a cinema display isn't a stadium
  });

  it('caps the gutter to a minority share so the track always keeps the lion’s width', () => {
    for (const w of [300, 700, 1200]) {
      expect(laneMetrics(w).gutterCap).toBeLessThan(w / 2);
      expect(laneMetrics(w).gutterCap).toBe(Math.round(w * 0.32));
    }
  });
});

describe('fallPosition', () => {
  it('parks later picks further back, never mixing into the pack band', () => {
    const teamCount = 12;
    let previous = -1;
    for (let pick = teamCount; pick >= 2; pick -= 1) {
      const x = fallPosition(pick, teamCount);
      expect(x).toBeGreaterThan(previous); // better pick ⇒ parked further ahead
      expect(x).toBeGreaterThanOrEqual(FALL_ZONE_START);
      expect(x).toBeLessThan(PACK_MIN);
      previous = x;
    }
  });

  it('keeps huge fields inside the standings zone instead of marching into the pack', () => {
    expect(fallPosition(2, 30)).toBeLessThanOrEqual(FALL_ZONE_END);
    expect(fallPosition(2, 30)).toBeGreaterThanOrEqual(fallPosition(30, 30));
  });

  /**
   * The live-feedback bug (#244 follow-up): the order was *there* — worst pick furthest back, each
   * better pick a step ahead — but the step was a fixed 1.8% of the track, about 21px against a
   * 28px ball. Neighbours overlapped, so the parked field read as a clump and the commissioner's
   * report was that position on the board did not mean anything.
   *
   * A ball diameter is the honest floor: below it, two adjacent places are not visibly ordered.
   */
  it('separates adjacent places by more than a ball, at every league size', () => {
    const BALL_DIAMETER_FRAC = 28 / 1200; // widest ball, widest track — the least forgiving case
    for (const teamCount of [4, 8, 12, 14]) {
      for (let pick = teamCount; pick > 2; pick -= 1) {
        const gap = fallPosition(pick - 1, teamCount) - fallPosition(pick, teamCount);
        expect(gap, `${teamCount} teams, picks ${pick} and ${pick - 1}`).toBeGreaterThan(
          BALL_DIAMETER_FRAC,
        );
      }
    }
  });

  it('uses the whole standings zone, so a small league is as legible as a big one', () => {
    // A fixed step would leave a 4-team draw huddled at the back of a zone sized for 12.
    for (const teamCount of [4, 8, 12]) {
      expect(fallPosition(teamCount, teamCount)).toBeCloseTo(FALL_ZONE_START, 6);
      expect(fallPosition(2, teamCount)).toBeGreaterThan(
        FALL_ZONE_START + (FALL_ZONE_END - FALL_ZONE_START) * 0.6,
      );
    }
  });

  /**
   * The second half of the same complaint. A racer still in contention could drift to 0.14 while a
   * team already drawn sat parked at 0.21 — the live pack's floor reached into the parked field, so
   * the board could show an eliminated team ahead of a contender. The zones must not touch.
   */
  it('never lets the live pack drift back into the parked order', () => {
    expect(FALL_ZONE_END).toBeLessThan(PACK_FLOOR);
    expect(PACK_FLOOR).toBeLessThanOrEqual(PACK_MIN);
    for (const teamCount of [4, 12, 30]) {
      expect(fallPosition(2, teamCount)).toBeLessThan(PACK_FLOOR);
    }
  });
});
