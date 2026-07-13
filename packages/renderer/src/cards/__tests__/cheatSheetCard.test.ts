import { renderCheatSheetCard } from '../cheatSheetCard.js';

describe('renderCheatSheetCard', () => {
  it('renders an SVG with band labels, players, stats, and fades', async () => {
    const buf = await renderCheatSheetCard({
      title: 'Draft Cheat Sheet',
      subtitle: '12-team PPR • pick 24 made',
      tiers: [
        {
          label: '🎯 Best available',
          players: [
            {
              name: 'Bijan Robinson',
              pos: 'RB',
              adp: 1.6,
              vor: 12.3,
              note: 'grab now',
              tone: 'reach',
            },
            { name: 'Tee Higgins', pos: 'WR', adp: 30, vor: 4.1, tone: 'value' },
          ],
        },
      ],
      fades: [{ name: 'Bucky Irving', pos: 'RB', reason: 'goal-line & pass-down competition' }],
      backend: 'svg',
    });
    const svg = buf.toString('utf8');

    expect(svg).toContain('<svg');
    expect(svg).toContain('Draft Cheat Sheet');
    expect(svg).toContain('Best available');
    expect(svg).toContain('Bijan Robinson');
    expect(svg).toContain('ADP 1.6');
    expect(svg).toContain('VOR +12.3');
    expect(svg).toContain('Fades');
    expect(svg).toContain('Bucky Irving');
  });

  it('escapes text and truncates long names', async () => {
    const longName = 'Z'.repeat(200);
    const buf = await renderCheatSheetCard({
      title: 'PR & <b>',
      tiers: [{ label: 'RB', players: [{ name: longName, pos: 'RB' }] }],
      backend: 'svg',
    });
    const svg = buf.toString('utf8');
    expect(svg).toContain('PR &amp; &lt;b&gt;');
    expect(svg).toContain('…');
    expect(svg).not.toContain(longName);
  });

  it('returns a non-empty PNG buffer by default and tolerates empty content', async () => {
    const png = await renderCheatSheetCard({
      title: 'PR',
      tiers: [{ label: 'RB', players: [{ name: 'A', pos: 'RB' }] }],
    });
    expect(png.length).toBeGreaterThan(0);

    const empty = await renderCheatSheetCard({ title: 'PR', tiers: [], backend: 'svg' });
    expect(empty.toString('utf8')).toContain('<svg');
  });
});
