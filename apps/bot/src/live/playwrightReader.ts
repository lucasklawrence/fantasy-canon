/**
 * The Playwright edge of the read-only capture: turn a live ESPN draft-room `Page` into a
 * {@link DraftRoomReader}. This is the *only* code that touches Playwright, and it does exactly one
 * thing — run a single `page.evaluate` that reads text out of the pick-history DOM and returns
 * strings. No clicks, no input, no navigation: it observes, nothing more (ADR 0004, Tier B).
 *
 * The in-page scraper mirrors the proven `apps/bot/assets/espn-draft-capture.user.js` selectors
 * (`.pick-history .player-column`, the bare-integer pick cell, `.on-the-clock`). It is passed as a
 * string so this module needs no DOM `lib` in tsconfig; the untrusted return is validated by
 * {@link normalizeDom} and then by the pure, unit-tested logic in `playwrightSource.ts`. If ESPN
 * reshuffles its markup, this selector string is the one spot to re-tune against a live draft.
 */

import type { Page } from 'playwright-core';
import type { DraftRoomReader, RawDraftDom, RawDomRow } from './playwrightSource.js';

/**
 * Scrape the pick-history table in the page's own context. Returns `{ rows, onTheClockText,
 * complete }` as plain strings/numbers. Read-only: it selects and reads text, never interacts.
 * Kept as a string expression so tsc doesn't need the DOM lib for this Node package.
 */
const SCRAPE_EXPRESSION = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const rows = [];
  const cells = document.querySelectorAll('.pick-history .player-column');
  for (const pc of cells) {
    const row = pc.closest('[class*="fixedDataTableRow"]') || pc.closest('tr') || pc.parentElement;
    if (!row) continue;
    // Name from the player link avoids the injury badge glued beside it in the raw cell text.
    const nameEl = pc.querySelector('.player-news, a');
    const playerText = clean(nameEl ? nameEl.textContent : (pc.textContent || ''));
    if (!playerText) continue;
    const cellTexts = [...row.querySelectorAll('.public_fixedDataTableCell_cellContent, td')].map((c) => clean(c.textContent));
    let overall = null;
    let pickText = '';
    for (const t of cellTexts) {
      if (/^\\d+$/.test(t)) { overall = parseInt(t, 10); pickText = t; break; }
    }
    rows.push({ overall, pickText, playerText });
  }
  const otcEl = document.querySelector('.on-the-clock');
  const onTheClockText = otcEl ? clean(otcEl.textContent) : undefined;
  const bodyText = (document.body && document.body.innerText) || '';
  const complete = /draft complete|draft is complete|draft has ended/i.test(bodyText);
  return { rows, onTheClockText, complete };
})()`;

/** Wrap a Playwright `Page` as a read-only {@link DraftRoomReader}. */
export function createPlaywrightReader(page: Page): DraftRoomReader {
  return {
    async read(): Promise<RawDraftDom> {
      const raw: unknown = await page.evaluate(SCRAPE_EXPRESSION);
      return normalizeDom(raw);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Coerce the untrusted `page.evaluate` return into a well-formed {@link RawDraftDom}. */
export function normalizeDom(raw: unknown): RawDraftDom {
  const root = asRecord(raw);
  const rawRows = Array.isArray(root?.rows) ? root.rows : [];
  const rows: RawDomRow[] = [];
  for (const item of rawRows) {
    const rec = asRecord(item);
    if (!rec) continue;
    const overall =
      typeof rec.overall === 'number' && Number.isFinite(rec.overall) ? rec.overall : null;
    rows.push({
      overall,
      pickText: typeof rec.pickText === 'string' ? rec.pickText : '',
      playerText: typeof rec.playerText === 'string' ? rec.playerText : '',
    });
  }
  return {
    rows,
    onTheClockText: typeof root?.onTheClockText === 'string' ? root.onTheClockText : undefined,
    complete: root?.complete === true,
  };
}
