import { renderGradeCard } from '../gradeCard.js';

describe('renderGradeCard', () => {
  it('renders an SVG with the grade, headline, position bars, and steals/reaches', async () => {
    const buf = await renderGradeCard({
      title: 'Team Canon',
      subtitle: '12-team PPR • 15 picks',
      grade: 'A-',
      score: 8.2,
      valueScore: 8.2,
      starters: { filled: 7, required: 7, missing: [] },
      byPosition: [
        { pos: 'RB', count: 4, avgValue: 3.1 },
        { pos: 'WR', count: 5, avgValue: -1.2 },
      ],
      steals: [{ playerName: 'Mark Andrews', overall: 160, value: 28.8, position: 'TE' }],
      reaches: [{ playerName: 'Aaron Jones', overall: 81, value: -13, position: 'RB' }],
      footer: 'ADP as of 2026-07-13 • grade assumes a completed roster',
      backend: 'svg',
    });
    const svg = buf.toString('utf8');

    expect(svg).toContain('<svg');
    expect(svg).toContain('Team Canon');
    expect(svg).toContain('>A-<');
    expect(svg).toContain('value +8.2');
    expect(svg).toContain('starters 7/7');
    expect(svg).toContain('By position');
    expect(svg).toContain('RB ×4');
    expect(svg).toContain('Steals');
    expect(svg).toContain('Mark Andrews');
    expect(svg).toContain('+28.8');
    expect(svg).toContain('Reaches');
    expect(svg).toContain('Aaron Jones');
    expect(svg).toContain('-13.0');
    expect(svg).toContain('grade assumes a completed roster');
  });

  it('warns about unfilled starters and escapes + truncates long names', async () => {
    const longName = 'Z'.repeat(200);
    const buf = await renderGradeCard({
      title: 'PR & <b>',
      grade: 'F',
      score: -40,
      valueScore: 0,
      starters: { filled: 5, required: 7, missing: ['RB', 'FLEX'] },
      byPosition: [],
      steals: [],
      reaches: [{ playerName: longName, overall: 3, value: -30 }],
      backend: 'svg',
    });
    const svg = buf.toString('utf8');

    expect(svg).toContain('PR &amp; &lt;b&gt;');
    expect(svg).toContain('Unfilled starters: RB, FLEX');
    expect(svg).toContain('…');
    expect(svg).not.toContain(longName);
  });

  it('returns a non-empty PNG buffer by default and tolerates empty breakdown', async () => {
    const png = await renderGradeCard({
      title: 'PR',
      grade: 'B',
      score: 0,
      valueScore: 0,
      starters: { filled: 7, required: 7, missing: [] },
      byPosition: [],
      steals: [],
      reaches: [],
    });
    expect(png.length).toBeGreaterThan(0);

    const empty = await renderGradeCard({
      title: 'PR',
      grade: '',
      score: 0,
      valueScore: 0,
      starters: { filled: 0, required: 0, missing: [] },
      byPosition: [],
      steals: [],
      reaches: [],
      backend: 'svg',
    });
    expect(empty.toString('utf8')).toContain('<svg');
  });
});
