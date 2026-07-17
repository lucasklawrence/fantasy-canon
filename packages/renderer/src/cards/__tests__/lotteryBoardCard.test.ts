import { renderLotteryBoardCard } from '../lotteryBoardCard.js';

const TEAMS = [
  'Punt Squad',
  'Taco Corp',
  'Trade Machine',
  'The Luck Dragons',
  'Hail Mary Heroes',
  'Bench Warmers',
  'FAAB Fiends',
  'Draft Day Regrets',
  'The Comeback Kids',
  'Waiver Wire Wizards',
  'Gridiron Gurus',
  'Ball Hawks',
];

const ENTRIES = TEAMS.map((team, i) => ({
  pick: i + 1,
  team,
  balls: i + 1,
  oddsPct: +((100 * (i + 1)) / 78).toFixed(1),
}));

describe('renderLotteryBoardCard', () => {
  it('renders the full 1–12 order with pick badges and odds annotations', async () => {
    const buf = await renderLotteryBoardCard({
      title: '2026 Draft Order',
      subtitle: 'Sealed by the lottery',
      entries: ENTRIES,
      backend: 'svg',
    });
    const svg = buf.toString('utf8');

    expect(svg).toContain('<svg');
    expect(svg).toContain('2026 Draft Order');
    for (const team of TEAMS) {
      expect(svg).toContain(team);
    }
    // Pick 1 annotation: 1 ball at 1.3%; pick 12: 12 balls at 15.4%.
    expect(svg).toContain('1 ball · 1.3% odds');
    expect(svg).toContain('12 balls · 15.4% odds');
  });

  it('omits the annotation when balls/odds are not provided', async () => {
    const buf = await renderLotteryBoardCard({
      title: 'Order',
      entries: [
        { pick: 1, team: 'Ball Hawks' },
        { pick: 2, team: 'Taco Corp', balls: 4 },
      ],
      backend: 'svg',
    });
    const svg = buf.toString('utf8');
    expect(svg).toContain('Ball Hawks');
    expect(svg).toContain('4 balls');
    expect(svg).not.toContain('odds');
  });

  it('escapes markup in team names and truncates long ones', async () => {
    const buf = await renderLotteryBoardCard({
      title: 'Order & <Chaos>',
      entries: [
        { pick: 1, team: 'Taco & Corp <LLC>' },
        { pick: 2, team: 'Z'.repeat(80) },
      ],
      backend: 'svg',
    });
    const svg = buf.toString('utf8');
    expect(svg).toContain('Order &amp; &lt;Chaos&gt;');
    expect(svg).toContain('Taco &amp; Corp &lt;LLC&gt;');
    expect(svg).toContain('…');
    expect(svg).not.toContain('Z'.repeat(80));
  });

  it('returns a non-empty PNG buffer by default and tolerates empty entries', async () => {
    const png = await renderLotteryBoardCard({ title: 'Order', entries: ENTRIES });
    expect(png.length).toBeGreaterThan(0);

    const empty = await renderLotteryBoardCard({ title: 'Order', entries: [], backend: 'svg' });
    expect(empty.toString('utf8')).toContain('<svg');
  });
});
