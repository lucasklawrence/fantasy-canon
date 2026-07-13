// ==UserScript==
// @name         Fantasy Canon — ESPN Draft Capture
// @namespace    fantasy-canon
// @version      0.1.0
// @description  Read-only: watches your ESPN draft room's pick-history and pushes each pick to the local Fantasy Canon bot so /canon draft best updates itself. Never submits a pick.
// @match        https://fantasy.espn.com/football/draft*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

/*
 * How this fits together
 * ----------------------
 * `/canon draft start source:espn` opens a localhost capture sink (default http://127.0.0.1:7331).
 * This userscript runs in your ESPN draft tab, scrapes the pick-history table every ~1.5s, and
 * POSTs the board to that sink. The bot dedupes and drains it into the live session — so picks flow
 * in without you re-typing them. It only ever READS the page; it never clicks "draft" or submits.
 *
 * The pick log is an ESPN `.pick-history` FixedDataTable. Each pick row has a bare-integer pick
 * cell, a `.player-column` cell (player-link name + team + position, sometimes a status badge), and
 * the drafting fantasy team. Virtualization means only on-screen rows exist in the DOM, but each
 * pick is rendered when it's the newest, so polling as picks land captures them incrementally.
 */

(function () {
  'use strict';

  const SINK_PORT = 7331; // must match FANTASY_DRAFT_SINK_PORT / the bot's start reply
  const SINK_URL = `http://127.0.0.1:${SINK_PORT}/`;
  const POLL_MS = 1500;

  /** Read the pick-history table into [{ overall, playerName, nflTeam, position, fantasyTeam }]. */
  function readBoard() {
    const rows = [];
    const cells = document.querySelectorAll('.pick-history .player-column');
    for (const pc of cells) {
      const row =
        pc.closest('[class*="fixedDataTableRow"]') || pc.closest('tr') || pc.parentElement;
      // Name from the player link avoids the injury badge that sits beside it in the cell text.
      const nameEl = pc.querySelector('.player-news, a');
      const playerName = (nameEl ? nameEl.textContent : pc.textContent || '').trim();
      if (!playerName || !row) continue;

      const cellTexts = [...row.querySelectorAll('.public_fixedDataTableCell_cellContent, td')].map(
        (c) => (c.textContent || '').trim(),
      );
      let overall = null;
      for (const t of cellTexts) {
        if (/^\d+$/.test(t)) {
          overall = parseInt(t, 10);
          break;
        }
      }
      if (!overall) continue;

      rows.push({ overall, playerName });
    }
    return rows;
  }

  /** Parse "On the Clock: Pick 37" → 37. */
  function readOnTheClock() {
    const el = document.querySelector('.on-the-clock');
    const m = el && (el.textContent || '').match(/pick\s+(\d+)/i);
    return m ? parseInt(m[1], 10) : undefined;
  }

  let lastSignature = '';

  function push() {
    const rows = readBoard();
    const onTheClock = readOnTheClock();
    const signature = `${rows.length}|${onTheClock || ''}`;
    if (signature === lastSignature) return; // nothing changed since last tick
    lastSignature = signature;

    GM_xmlhttpRequest({
      method: 'POST',
      url: SINK_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ rows, onTheClock }),
      onerror: () => {
        // Bot not listening yet — reset so we retry on the next change.
        lastSignature = '';
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log('[fantasy-canon] ESPN draft capture active →', SINK_URL);
  setInterval(push, POLL_MS);
})();
