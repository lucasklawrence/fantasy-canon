import { renderLotteryRevealCard } from '../lotteryRevealCard.js';

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

describe('renderLotteryRevealCard', () => {
  it('renders the drum-roll beat frame with the pick number and full hopper strip', async () => {
    const buf = await renderLotteryRevealCard({
      title: 'Draft Lottery 2026',
      subtitle: 'The Ceremony',
      phase: 'beat',
      pick: 12,
      remaining: TEAMS,
      backend: 'svg',
    });
    const svg = buf.toString('utf8');

    expect(svg).toContain('<svg');
    expect(svg).toContain('REVEALING PICK');
    expect(svg).toContain('#12');
    expect(svg).toContain('STILL IN THE HOPPER — 12');
    // All 12 chips fit in the two-row strip for a 12-team league.
    for (const team of TEAMS) {
      expect(svg).toContain(team.length > 16 ? team.slice(0, 15) : team);
    }
    expect(svg).not.toContain('more');
  });

  it('renders the reveal frame with team, balls held, odds, and a smaller strip', async () => {
    const buf = await renderLotteryRevealCard({
      title: 'Draft Lottery 2026',
      phase: 'reveal',
      pick: 12,
      team: 'Punt Squad',
      balls: 3,
      oddsPct: 3.8,
      remaining: TEAMS.slice(0, 11),
      backend: 'svg',
    });
    const svg = buf.toString('utf8');

    expect(svg).toContain('PICK #12 GOES TO');
    expect(svg).toContain('Punt Squad');
    expect(svg).toContain('held 3 balls · 3.8% odds');
    expect(svg).toContain('STILL IN THE HOPPER — 11');
  });

  it('collapses a huge remaining list into a +N more chip', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `Team ${i + 1}`);
    const buf = await renderLotteryRevealCard({
      title: 'Lottery',
      phase: 'beat',
      pick: 40,
      remaining: many,
      backend: 'svg',
    });
    const svg = buf.toString('utf8');
    expect(svg).toMatch(/\+\d+ more/);
  });

  it('escapes team names and returns a non-empty PNG for both phases', async () => {
    const svgBuf = await renderLotteryRevealCard({
      title: 'Lottery',
      phase: 'reveal',
      pick: 1,
      team: 'Taco & Corp <LLC>',
      balls: 1,
      oddsPct: 100,
      remaining: [],
      backend: 'svg',
    });
    const svg = svgBuf.toString('utf8');
    expect(svg).toContain('Taco &amp; Corp &lt;LLC&gt;');
    expect(svg).toContain('held 1 ball · 100.0% odds');
    expect(svg).not.toContain('STILL IN THE HOPPER');

    const beatPng = await renderLotteryRevealCard({
      title: 'Lottery',
      phase: 'beat',
      pick: 5,
      remaining: TEAMS,
    });
    expect(beatPng.length).toBeGreaterThan(0);

    const revealPng = await renderLotteryRevealCard({
      title: 'Lottery',
      phase: 'reveal',
      pick: 5,
      team: 'Ball Hawks',
      balls: 8,
      oddsPct: 12.5,
      remaining: TEAMS.slice(0, 4),
    });
    expect(revealPng.length).toBeGreaterThan(0);
  });
});
