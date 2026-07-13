import { renderThrowbackCard } from '../throwbackCard.js';

describe('renderThrowbackCard', () => {
  it('renders an SVG with the badge, headline, and stat rows', async () => {
    const buf = await renderThrowbackCard({
      title: 'My League • Throwback',
      subtitle: 'Season 2024',
      badge: '⚔️ Biggest Rivalry',
      headline: 'Team A vs Team B',
      stats: [
        { label: 'Head-to-head', value: '5–2' },
        { label: 'Team A points', value: '812.4' },
      ],
      backend: 'svg',
    });
    const svg = buf.toString('utf8');

    expect(svg).toContain('<svg');
    expect(svg).toContain('My League • Throwback');
    expect(svg).toContain('Season 2024');
    expect(svg).toContain('⚔️ Biggest Rivalry');
    expect(svg).toContain('Team A vs Team B');
    expect(svg).toContain('Head-to-head');
    expect(svg).toContain('5–2');
    expect(svg).toContain('812.4');
  });

  it('escapes stat text and truncates overruns', async () => {
    const longHeadline = 'Z'.repeat(200);
    const buf = await renderThrowbackCard({
      title: 'PR',
      headline: longHeadline,
      stats: [{ label: 'Series & <edge>', value: '1' }],
      backend: 'svg',
    });
    const svg = buf.toString('utf8');
    expect(svg).toContain('Series &amp; &lt;edge&gt;');
    expect(svg).toContain('…'); // long headline was truncated
    expect(svg).not.toContain(longHeadline); // full string not present
  });

  it('returns a non-empty buffer by default and renders without a badge', async () => {
    const png = await renderThrowbackCard({
      title: 'PR',
      headline: 'Team X',
      stats: [{ label: 'Roster moves', value: '42' }],
    });
    expect(png.length).toBeGreaterThan(0);

    const noBadge = await renderThrowbackCard({
      title: 'PR',
      headline: 'Team X',
      stats: [],
      backend: 'svg',
    });
    expect(noBadge.toString('utf8')).toContain('<svg');
  });
});
