import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { computeWeeklyTrophies } from '@fantasy-canon/core';
import { parseStarterSlots } from '../lineupEfficiency.js';
import { extractTrophyExtras } from '../trophyExtras.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

// Trimmed real 2024 week-1 mBoxscore: the team 10 vs team 13 matchup, with each player's
// projected (statSourceId 1) and actual (0) lines.
const mBoxscore = fixture('mBoxscore-2024-wk1.json');
const mSettings = fixture('mSettings-2024.json');
const slots = parseStarterSlots(mSettings);

describe('extractTrophyExtras', () => {
  const extras = extractTrophyExtras(mBoxscore, slots, 1);

  it('builds projected points per team from started players', () => {
    expect(extras.projected!.get(10)).toBeCloseTo(119.97, 2);
    expect(extras.projected!.get(13)).toBeCloseTo(117.94, 2);
  });

  it('builds optimal-lineup % per team (matches lineup efficiency)', () => {
    expect(extras.optimalPct!.get(10)).toBeCloseTo(95.81 / 106.91, 4);
    expect(extras.optimalPct!.get(13)).toBeCloseTo(102.12 / 122.52, 4);
  });

  it('returns empty maps for a payload with no schedule', () => {
    const empty = extractTrophyExtras({}, slots, 1);
    expect(empty.projected!.size).toBe(0);
    expect(empty.optimalPct!.size).toBe(0);
  });
});

describe('extras light up all ten trophies through the engine', () => {
  // Their engine takes matchups; build the one from this fixture's totals.
  const box = mBoxscore as {
    schedule: {
      home: { teamId: number; totalPoints: number };
      away: { teamId: number; totalPoints: number };
    }[];
  };
  const m = box.schedule[0];
  const matchups = [
    {
      home: { teamId: m.home.teamId, score: m.home.totalPoints },
      away: { teamId: m.away.teamId, score: m.away.totalPoints },
    },
  ];

  it('emits the four data-dependent categories that are dark without extras', () => {
    const withoutExtras = computeWeeklyTrophies(matchups).map((t) => t.key);
    expect(withoutExtras).not.toContain('overachiever');
    expect(withoutExtras).not.toContain('best-manager');

    const extras = extractTrophyExtras(mBoxscore, slots, 1);
    const keys = computeWeeklyTrophies(matchups, extras).map((t) => t.key);
    expect(keys).toEqual(
      expect.arrayContaining(['overachiever', 'underachiever', 'best-manager', 'worst-manager']),
    );
    // Team 10 managed its lineup better (89.6% vs 83.3%).
    const best = computeWeeklyTrophies(matchups, extras).find((t) => t.key === 'best-manager')!;
    expect(best.teamId).toBe(10);
  });
});
