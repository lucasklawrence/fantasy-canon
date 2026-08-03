import { describe, expect, it } from 'vitest';

import { assignBallRanges } from '../client/ballAssignments.js';
import {
  assignLanes,
  FALL_ZONE_START,
  fallPosition,
  laneMetrics,
  lockKind,
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

  it('clamps huge fields under the pack band instead of marching into it', () => {
    // 30 teams would walk past the pack at the raw spacing — the clamp keeps every straggler
    // (and therefore the whole parked order) left of the live racers.
    expect(fallPosition(2, 30)).toBeLessThan(PACK_MIN);
    expect(fallPosition(2, 30)).toBeGreaterThanOrEqual(fallPosition(30, 30));
  });
});
