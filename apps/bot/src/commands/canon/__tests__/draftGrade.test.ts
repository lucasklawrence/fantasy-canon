import { gradeRoster, type PlayerTier, type RosterPick } from '@fantasy-canon/core';
import { gradeHeadline, gradePicksBlock, toGradeCardOptions } from '../draftSession.js';

/** No K/DST slots, so `required` is deterministic (K/DST are only evaluated when tagged). */
const SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, BENCH: 6 };

function player(name: string, position: PlayerTier['position'], adp?: number): PlayerTier {
  return { name, position, adp, source: 'test' };
}

describe('gradeHeadline', () => {
  it('summarizes grade, mean value, penalized score, and starters filled', () => {
    const pool = [player('Steal RB', 'RB', 20), player('Reach WR', 'WR', 30)];
    const picks: RosterPick[] = [
      { overall: 10, playerName: 'Reach WR' }, // 10 − 30 = −20 → reach
      { overall: 40, playerName: 'Steal RB' }, // 40 − 20 = +20 → steal
    ];
    const grade = gradeRoster(picks, pool, { rosterSlots: SLOTS });
    const headline = gradeHeadline(grade);

    // valueScore (−20 + 20)/2 = 0; only 2 of 7 starters fillable → score 0 − 8×5 = −40 → F.
    expect(headline).toMatch(/^\*\*F\*\*/);
    expect(headline).toContain('value 0');
    expect(headline).toContain('score -40');
    expect(headline).toContain('starters 2/7');
  });
});

describe('gradePicksBlock', () => {
  it('renders a fenced per-pick table with tone glyphs, ADP, and signed value', () => {
    const pool = [player('Steal RB', 'RB', 20), player('Reach WR', 'WR', 30)];
    const picks: RosterPick[] = [
      { overall: 10, playerName: 'Reach WR' },
      { overall: 40, playerName: 'Steal RB' },
    ];
    const block = gradePicksBlock(gradeRoster(picks, pool, { rosterSlots: SLOTS }));

    expect(block.startsWith('```')).toBe(true);
    expect(block.endsWith('```')).toBe(true);
    // Draft order: reach first, then steal.
    expect(block.indexOf('Reach WR')).toBeLessThan(block.indexOf('Steal RB'));
    expect(block).toContain('🟧'); // reach glyph
    expect(block).toContain('💎'); // steal glyph
    expect(block).toContain('adp 30');
    expect(block).toContain('-20');
    expect(block).toContain('+20');
  });

  it('handles an empty roster without throwing', () => {
    const grade = gradeRoster([], [], { rosterSlots: SLOTS });
    expect(gradePicksBlock(grade)).toBe('_No picks yet._');
  });
});

describe('toGradeCardOptions', () => {
  const pool = [player('Steal RB', 'RB', 20), player('Reach WR', 'WR', 30)];
  const picks: RosterPick[] = [
    { overall: 10, playerName: 'Reach WR' }, // reach
    { overall: 40, playerName: 'Steal RB' }, // steal
  ];
  const grade = gradeRoster(picks, pool, { rosterSlots: SLOTS });

  it('carries the grade numbers, subtitle, and footer through to card options', () => {
    const opts = toGradeCardOptions(grade, { teams: 12, slot: 7, adpAsOf: '2026-07-13' });

    expect(opts.grade).toBe(grade.grade);
    expect(opts.score).toBe(grade.score);
    expect(opts.valueScore).toBe(grade.valueScore);
    expect(opts.starters).toEqual(grade.starters);
    expect(opts.subtitle).toBe('12-team PPR • 2 picks • slot 7');
    expect(opts.footer).toBe(
      '12-team PPR • slot 7 • ADP as of 2026-07-13 • grade assumes a completed roster',
    );
    // Steal/reach rows are mapped to plain rows the renderer understands.
    expect(opts.steals[0]).toMatchObject({ playerName: 'Steal RB', overall: 40, position: 'RB' });
    expect(opts.reaches[0]).toMatchObject({ playerName: 'Reach WR', overall: 10, position: 'WR' });
  });

  it('orders position bars RB→WR→TE→QB and drops the ADP note when absent', () => {
    const opts = toGradeCardOptions(grade, { teams: 12, slot: 7 });

    // byPosition is a superset-ordered list; RB must sort before WR regardless of Record order.
    const positions = opts.byPosition.map((b) => b.pos);
    expect(positions).toEqual(['RB', 'WR']);
    // No adpAsOf → footer omits the "ADP as of" segment.
    expect(opts.footer).toBe('12-team PPR • slot 7 • grade assumes a completed roster');
  });
});
