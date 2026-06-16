import { renderAwardsRecapCard } from '../awardsRecapCard.js';

describe('renderAwardsRecapCard', () => {
  it('renders an SVG with award labels, winners, and stat lines', async () => {
    const buf = await renderAwardsRecapCard({
      title: 'Season Awards',
      subtitle: '2024',
      awards: [
        { label: 'MVP', winner: 'Team Rocket', detail: '1623.4 pts', emoji: '🏆' },
        { label: 'Bust of the Year', winner: 'Gridiron Gang', detail: '−312 vs proj' },
      ],
      backend: 'svg',
    });
    const svg = buf.toString('utf8');

    expect(svg).toContain('<svg');
    expect(svg).toContain('Season Awards');
    expect(svg).toContain('MVP');
    expect(svg).toContain('Team Rocket');
    expect(svg).toContain('1623.4 pts');
    expect(svg).toContain('Bust of the Year');
    expect(svg).toContain('🏆');
  });

  it('escapes award text and truncates overruns', async () => {
    const longName = 'A'.repeat(200);
    const buf = await renderAwardsRecapCard({
      title: 'PR',
      awards: [{ label: 'Award & <stuff>', winner: longName }],
      backend: 'svg',
    });
    const svg = buf.toString('utf8');
    expect(svg).toContain('Award &amp; &lt;stuff&gt;');
    expect(svg).toContain('…'); // long winner was truncated
    expect(svg).not.toContain(longName); // full string not present
  });

  it('returns a non-empty buffer by default and handles empty awards', async () => {
    const png = await renderAwardsRecapCard({
      title: 'PR',
      awards: [{ label: 'X', winner: 'Y' }],
    });
    expect(png.length).toBeGreaterThan(0);

    const empty = await renderAwardsRecapCard({ title: 'PR', awards: [], backend: 'svg' });
    expect(empty.toString('utf8')).toContain('<svg');
  });
});
