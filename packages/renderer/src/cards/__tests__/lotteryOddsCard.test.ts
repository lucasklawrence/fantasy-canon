import { renderLotteryOddsCard } from '../lotteryOddsCard.js';

const TEAMS = [
  'Ball Hawks',
  'Gridiron Gurus',
  'Waiver Wire Wizards',
  'The Comeback Kids',
  'Draft Day Regrets',
  'FAAB Fiends',
  'Bench Warmers',
  'Hail Mary Heroes',
  'The Luck Dragons',
  'Trade Machine',
  'Taco Corp',
  'Punt Squad',
];

// Worst seed holds the most balls; odds are precomputed by the caller (engine-side).
const ROWS = TEAMS.map((team, i) => ({
  team,
  balls: 12 - i,
  firstPct: +(((12 - i) / 78) * 100).toFixed(1),
  top3Pct: +(((3 * (12 - i)) / 78) * 100).toFixed(1),
}));

describe('renderLotteryOddsCard', () => {
  it('renders all 12 teams with headers, ball counts, and headline odds', async () => {
    const buf = await renderLotteryOddsCard({
      title: 'Draft Lottery Odds',
      subtitle: '2026 season • 78 balls in the hopper',
      rows: ROWS,
      backend: 'svg',
    });
    const svg = buf.toString('utf8');

    expect(svg).toContain('<svg');
    expect(svg).toContain('Draft Lottery Odds');
    expect(svg).toContain('TEAM');
    expect(svg).toContain('BALLS');
    expect(svg).toContain('#1 PICK');
    expect(svg).toContain('TOP 3');
    for (const team of TEAMS) {
      expect(svg).toContain(team);
    }
    // Top seed: 12 balls, 15.4% at #1, 46.2% top-3.
    expect(svg).toContain('15.4%');
    expect(svg).toContain('46.2%');
  });

  it('escapes markup in team names and truncates long ones', async () => {
    const buf = await renderLotteryOddsCard({
      title: 'Odds & <Ends>',
      rows: [
        { team: 'Taco & Corp <LLC>', balls: 5, firstPct: 10, top3Pct: 30 },
        { team: 'Z'.repeat(80), balls: 3, firstPct: 5, top3Pct: 15 },
      ],
      backend: 'svg',
    });
    const svg = buf.toString('utf8');
    expect(svg).toContain('Odds &amp; &lt;Ends&gt;');
    expect(svg).toContain('Taco &amp; Corp &lt;LLC&gt;');
    expect(svg).toContain('…');
    expect(svg).not.toContain('Z'.repeat(80));
  });

  it('returns a non-empty PNG buffer by default and tolerates empty rows', async () => {
    const png = await renderLotteryOddsCard({ title: 'Odds', rows: ROWS.slice(0, 3) });
    expect(png.length).toBeGreaterThan(0);

    const empty = await renderLotteryOddsCard({ title: 'Odds', rows: [], backend: 'svg' });
    expect(empty.toString('utf8')).toContain('<svg');
  });
});
