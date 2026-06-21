import { classifyArchetype, type ArchetypeStats } from '../archetype.js';

const team = (stats: Partial<ArchetypeStats>): ArchetypeStats => ({
  acquisitions: 0,
  moves: 0,
  movesToIr: 0,
  totalMoves: 0,
  ...stats,
});

describe('classifyArchetype', () => {
  // A baseline league where each average is 10 (one team at 10 across the board).
  const league: ArchetypeStats[] = [
    team({ acquisitions: 10, moves: 10, movesToIr: 10, totalMoves: 10 }),
  ];

  it('labels the strongest above-average tendency', () => {
    expect(classifyArchetype(team({ acquisitions: 30, totalMoves: 30 }), league).label).toBe(
      'Wire Addict',
    );
    expect(classifyArchetype(team({ moves: 30, totalMoves: 30 }), league).label).toBe(
      'Lineup Tinkerer',
    );
    expect(classifyArchetype(team({ movesToIr: 30, totalMoves: 30 }), league).label).toBe(
      'IR Surgeon',
    );
  });

  it('labels a Minimalist when total moves are below half the league average', () => {
    // totalMoves 4 vs avg 10 → ratio 0.4 < 0.5, overrides the leading tendency.
    const t = team({ acquisitions: 3, moves: 1, totalMoves: 4 });
    expect(classifyArchetype(t, league)).toEqual({ label: 'Minimalist', detail: 'total moves 4' });
  });

  it('breaks tendency ties in declaration order', () => {
    // Equal ratios across the three tendencies → Wire Addict wins.
    expect(
      classifyArchetype(
        team({ acquisitions: 20, moves: 20, movesToIr: 20, totalMoves: 20 }),
        league,
      ).label,
    ).toBe('Wire Addict');
  });

  it('emits a supporting detail for the chosen label', () => {
    expect(classifyArchetype(team({ moves: 25, totalMoves: 25 }), league).detail).toBe(
      'lineup moves 25',
    );
  });

  it('treats a zero/empty baseline without dividing by zero', () => {
    expect(classifyArchetype(team({ acquisitions: 5, totalMoves: 5 }), []).label).toBe(
      'Wire Addict',
    );
  });
});
