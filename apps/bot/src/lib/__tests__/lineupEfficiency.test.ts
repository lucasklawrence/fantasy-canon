import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { computeLineupEfficiency, aggregateLineupEfficiency } from '@fantasy-canon/core';
import { parseStarterSlots, parseWeekLineups, regularSeasonWeeks } from '../lineupEfficiency.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

// Trimmed from a real 2024 week-1 ESPN payload for this league (12-team, FLEX). The two
// teams in the matchup are id 10 and 13; ESPN's reported `totalPoints` is the ground truth
// the parser must reproduce.
const mMatchup = fixture('mMatchup-2024-wk1.json');
const mSettings = fixture('mSettings-2024.json');

describe('parseStarterSlots', () => {
  it('reads lineupSlotCounts, dropping bench/IR and zero-count slots', () => {
    const slots = parseStarterSlots(mSettings);
    // QB×1, RB×2, WR×2, TE×1, D/ST×1, K×1, FLEX×1 = 9 starting seats.
    expect(slots).toEqual(
      expect.arrayContaining([
        { slotId: 0, count: 1 },
        { slotId: 2, count: 2 },
        { slotId: 4, count: 2 },
        { slotId: 6, count: 1 },
        { slotId: 16, count: 1 },
        { slotId: 17, count: 1 },
        { slotId: 23, count: 1 },
      ]),
    );
    expect(slots).toHaveLength(7);
    expect(slots.some((s) => s.slotId === 20 || s.slotId === 21)).toBe(false);
    expect(slots.reduce((n, s) => n + s.count, 0)).toBe(9);
  });

  it('returns [] for an unrecognizable payload', () => {
    expect(parseStarterSlots(null)).toEqual([]);
    expect(parseStarterSlots({})).toEqual([]);
    expect(parseStarterSlots({ settings: { rosterSettings: {} } })).toEqual([]);
  });
});

describe('regularSeasonWeeks', () => {
  it('derives weeks from matchupPeriodCount × length', () => {
    expect(regularSeasonWeeks(mSettings)).toBe(14);
  });
  it('falls back when the field is missing', () => {
    expect(regularSeasonWeeks({}, 13)).toBe(13);
  });
});

describe('parseWeekLineups', () => {
  it('extracts both teams with started flags matching bench/IR slots', () => {
    const lineups = parseWeekLineups(mMatchup);
    expect(lineups.map((l) => l.teamId).sort((a, b) => a - b)).toEqual([10, 13]);
    const team10 = lineups.find((l) => l.teamId === 10)!;
    // 9 starters in a standard lineup; the rest are bench/IR.
    expect(team10.players.filter((p) => p.started)).toHaveLength(9);
    expect(team10.players.length).toBeGreaterThan(9);
  });

  it('parsed started points reproduce ESPN’s reported totalPoints (ground truth)', () => {
    const lineups = parseWeekLineups(mMatchup);
    for (const { teamId, players } of lineups) {
      const started = players.filter((p) => p.started).reduce((s, p) => s + p.points, 0);
      const reported = teamId === 10 ? 95.81 : 102.12;
      expect(started).toBeCloseTo(reported, 2);
    }
  });

  it('returns [] for a payload with no schedule', () => {
    expect(parseWeekLineups({})).toEqual([]);
    expect(parseWeekLineups(null)).toEqual([]);
  });
});

describe('end-to-end with computeLineupEfficiency', () => {
  const slots = parseStarterSlots(mSettings);
  const lineups = parseWeekLineups(mMatchup);

  it('matches hand-verified optimal lineups for the fixture teams', () => {
    const team10 = computeLineupEfficiency(lineups.find((l) => l.teamId === 10)!.players, slots);
    expect(team10.actualPoints).toBeCloseTo(95.81, 2);
    expect(team10.optimalPoints).toBeCloseTo(106.91, 2);
    expect(team10.pointsLeftOnBench).toBeCloseTo(11.1, 2);
    expect(team10.efficiency).toBeCloseTo(95.81 / 106.91, 4);

    const team13 = computeLineupEfficiency(lineups.find((l) => l.teamId === 13)!.players, slots);
    expect(team13.actualPoints).toBeCloseTo(102.12, 2);
    expect(team13.optimalPoints).toBeCloseTo(122.52, 2);
    expect(team13.pointsLeftOnBench).toBeCloseTo(20.4, 2);
  });

  it('aggregates the two teams’ single week into season totals (points-based)', () => {
    const weekly = lineups.map((l) => computeLineupEfficiency(l.players, slots));
    const season = aggregateLineupEfficiency(weekly);
    expect(season.actualPoints).toBeCloseTo(95.81 + 102.12, 2);
    expect(season.optimalPoints).toBeCloseTo(106.91 + 122.52, 2);
    expect(season.pointsLeftOnBench).toBeCloseTo(11.1 + 20.4, 2);
    expect(season.efficiency).toBeCloseTo((95.81 + 102.12) / (106.91 + 122.52), 4);
  });
});
