import { renderBumpChartGraph } from '../bumpChartGraph.js';

describe('renderBumpChartGraph', () => {
  it('renders an SVG with team end-labels, week ticks, and rank gridlines', async () => {
    const buf = await renderBumpChartGraph(
      {
        title: 'Standings by Week',
        subtitle: '2024',
        weeks: [1, 2, 3],
        lines: [
          { team: 'Team Rocket', ranks: [1, 1, 2] },
          { team: 'Gridiron Gang', ranks: [2, 2, 1] },
        ],
      },
      { backend: 'svg' },
    );
    const svg = buf.toString('utf8');

    expect(svg).toContain('<svg');
    expect(svg).toContain('Standings by Week');
    // Direct line-end labels rather than a legend.
    expect(svg).toContain('Team Rocket');
    expect(svg).toContain('Gridiron Gang');
    // Week ticks and a polyline per team.
    expect(svg).toContain('W1');
    expect(svg).toContain('W3');
    expect(svg).toContain('<polyline');
    expect(svg).toContain('Standings rank');
  });

  it('escapes team names', async () => {
    const buf = await renderBumpChartGraph(
      { title: 'B', weeks: [1], lines: [{ team: 'A & B <C>', ranks: [1] }] },
      { backend: 'svg' },
    );
    expect(buf.toString('utf8')).toContain('A &amp; B &lt;C&gt;');
  });

  it('returns a non-empty buffer by default and handles empty input', async () => {
    const png = await renderBumpChartGraph({
      title: 'B',
      weeks: [1, 2],
      lines: [{ team: 'A', ranks: [1, 1] }],
    });
    expect(png.length).toBeGreaterThan(0);

    const empty = await renderBumpChartGraph(
      { title: 'B', weeks: [], lines: [] },
      { backend: 'svg' },
    );
    expect(empty.toString('utf8')).toContain('<svg');
  });
});
