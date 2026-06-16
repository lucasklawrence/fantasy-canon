import { renderPowerRankingGraph } from '../powerRankingGraph.js';

describe('renderPowerRankingGraph', () => {
  it('renders an SVG with team names, scores, and the gap-to-above marker', async () => {
    const buf = await renderPowerRankingGraph(
      {
        title: 'Power Rankings',
        subtitle: 'Season 2024',
        rows: [
          { rank: 1, team: 'Team Rocket', score: 120.5, gap: 0 },
          { rank: 2, team: 'Gridiron Gang', score: 110.2, gap: 10.3 },
        ],
      },
      { backend: 'svg' },
    );
    const svg = buf.toString('utf8');

    expect(svg).toContain('<svg');
    expect(svg).toContain('Power Rankings');
    expect(svg).toContain('Team Rocket');
    expect(svg).toContain('Gridiron Gang');
    expect(svg).toContain('120.5');
    // The headline insight: the gap to the team above is annotated.
    expect(svg).toContain('▼ 10.3');
    // The #1 team has no gap marker.
    expect(svg).not.toContain('▼ 0.0');
  });

  it('escapes team names to keep the SVG well-formed', async () => {
    const buf = await renderPowerRankingGraph(
      { title: 'PR', rows: [{ rank: 1, team: 'Dover & Out <FC>', score: 1, gap: 0 }] },
      { backend: 'svg' },
    );
    const svg = buf.toString('utf8');
    expect(svg).toContain('Dover &amp; Out &lt;FC&gt;');
  });

  it('returns a non-empty buffer by default (png path) and handles empty rows', async () => {
    const png = await renderPowerRankingGraph({
      title: 'PR',
      rows: [{ rank: 1, team: 'A', score: 1, gap: 0 }],
    });
    expect(png.length).toBeGreaterThan(0);

    const empty = await renderPowerRankingGraph({ title: 'PR', rows: [] }, { backend: 'svg' });
    expect(empty.toString('utf8')).toContain('<svg');
  });
});
