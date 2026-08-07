import { describe, expect, it } from 'vitest';

import { renderLotteryBoardCard } from '../cards/lotteryBoardCard.js';
import { renderLotteryOddsCard } from '../cards/lotteryOddsCard.js';
import { rasterizeSvgLogo } from '../render.js';

/**
 * Logo avatars on the lottery cards (#254). resvg is deterministic, so the tests compare whole
 * PNGs: a data-URI logo must change the bytes (it drew), and a rejected logo — network URL,
 * nested SVG — must leave them identical to the no-logo card (it was dropped, not half-drawn).
 */

/** A real PNG data URI, built by the same rasterizer the bot uses in production. */
function pngLogoDataUri(): string {
  const png = rasterizeSvgLogo(
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#e11" /></svg>',
    32,
  );
  if (!png) throw new Error('fixture rasterization failed');
  return `data:image/png;base64,${png.toString('base64')}`;
}

const ODDS_ROWS = [
  { team: 'Alpha', balls: 5, firstPct: 41.7, top3Pct: 92.0 },
  { team: 'Bravo', balls: 4, firstPct: 33.3, top3Pct: 85.1 },
  { team: 'Charlie', balls: 3, firstPct: 25.0, top3Pct: 76.4 },
];

const BOARD_ENTRIES = [
  { pick: 1, team: 'Charlie', balls: 3, oddsPct: 25.0 },
  { pick: 2, team: 'Alpha', balls: 5, oddsPct: 38.9 },
  { pick: 3, team: 'Bravo', balls: 4, oddsPct: 57.1 },
];

function withLogo<T extends object>(rows: T[], logo: string): T[] {
  return rows.map((row, idx) => (idx === 0 ? { ...row, logo } : row));
}

describe('lottery odds card logos (#254)', () => {
  it('draws a data-URI logo', async () => {
    const base = await renderLotteryOddsCard({ title: 'Odds', rows: ODDS_ROWS });
    const decorated = await renderLotteryOddsCard({
      title: 'Odds',
      rows: withLogo(ODDS_ROWS, pngLogoDataUri()),
    });
    expect(decorated.equals(base)).toBe(false);
  });

  it('drops network URLs and nested SVG instead of drawing them', async () => {
    const base = await renderLotteryOddsCard({ title: 'Odds', rows: ODDS_ROWS });
    for (const rejected of [
      'https://cdn.espn.example/alpha.png',
      'data:image/svg+xml;base64,PHN2Zy8+',
      'DATA:IMAGE/SVG+XML;base64,PHN2Zy8+',
      // Attribute-breakout attempt: a hostile media type must fail the whole-URI validation.
      'data:image/png"/><rect width="1080" height="1080"/><a href=";base64,AAAA',
      // A valid-looking head with a non-base64 payload is just as dead.
      'data:image/png;base64,AAAA"/><rect/>',
    ]) {
      const rendered = await renderLotteryOddsCard({
        title: 'Odds',
        rows: withLogo(ODDS_ROWS, rejected),
      });
      expect(rendered.equals(base)).toBe(true);
    }
  });
});

describe('lottery board card logos (#254)', () => {
  it('draws a data-URI logo', async () => {
    const base = await renderLotteryBoardCard({ title: 'Order', entries: BOARD_ENTRIES });
    const decorated = await renderLotteryBoardCard({
      title: 'Order',
      entries: withLogo(BOARD_ENTRIES, pngLogoDataUri()),
    });
    expect(decorated.equals(base)).toBe(false);
  });

  it('drops network URLs and nested SVG instead of drawing them', async () => {
    const base = await renderLotteryBoardCard({ title: 'Order', entries: BOARD_ENTRIES });
    for (const rejected of ['https://cdn.espn.example/alpha.png', 'data:image/svg+xml,<svg/>']) {
      const rendered = await renderLotteryBoardCard({
        title: 'Order',
        entries: withLogo(BOARD_ENTRIES, rejected),
      });
      expect(rendered.equals(base)).toBe(true);
    }
  });
});
