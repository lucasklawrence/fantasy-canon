import { describe, it, expect } from 'vitest';
import { extractRoster, positionLabel } from '../roster.js';

function entry(fullName: string, defaultPositionId: number, lineupSlotId: number): unknown {
  return { lineupSlotId, playerPoolEntry: { player: { fullName, defaultPositionId } } };
}

const payload = {
  teams: [
    {
      id: 1,
      roster: {
        entries: [
          entry('Josh Allen', 1, 0), // QB, starting
          entry('Backup RB', 2, 20), // RB, bench
          entry('CMC', 2, 2), // RB, starting
          entry('IR Guy', 3, 21), // WR, IR (non-starter)
        ],
      },
    },
    { id: 2, roster: { entries: [entry('Other Team QB', 1, 0)] } },
  ],
};

describe('positionLabel', () => {
  it('maps known ESPN position ids', () => {
    expect(positionLabel(1)).toBe('QB');
    expect(positionLabel(16)).toBe('D/ST');
  });

  it('returns "?" for unknown or missing ids', () => {
    expect(positionLabel(99)).toBe('?');
    expect(positionLabel(undefined)).toBe('?');
  });
});

describe('extractRoster', () => {
  it('returns the requested team only, starters before bench/IR', () => {
    const roster = extractRoster(payload, 1);
    expect(roster.map((p) => p.name)).toEqual(['Josh Allen', 'CMC', 'Backup RB', 'IR Guy']);
    expect(roster.map((p) => p.starting)).toEqual([true, true, false, false]);
    expect(roster[0]).toEqual({ name: 'Josh Allen', position: 'QB', starting: true });
  });

  it('returns an empty array for an unknown team or malformed payload', () => {
    expect(extractRoster(payload, 999)).toEqual([]);
    expect(extractRoster(undefined, 1)).toEqual([]);
    expect(extractRoster({ teams: 'nope' }, 1)).toEqual([]);
  });

  it('skips entries without a player name', () => {
    const broken = { teams: [{ id: 1, roster: { entries: [{ lineupSlotId: 0 }] } }] };
    expect(extractRoster(broken, 1)).toEqual([]);
  });
});
