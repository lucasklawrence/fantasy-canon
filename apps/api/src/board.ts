/**
 * The draft dashboard page shell, served at `/`. Static HTML + inline CSS with **no inline logic**:
 * the board's render + transport + the Discord Embedded App SDK handshake all live in the bundled
 * browser client (`src/client/`, built by esbuild to `dist/client/activity.js`) so there is one
 * implementation shared by the standalone dev board and the in-Discord Activity (ADR 0005 Phase 2).
 *
 * The page loads the bundle with a **relative** `src` (`./client/activity.js`) so it resolves under
 * whatever base the page is served from — the backend root in dev, or `/.proxy/` inside the Discord
 * Activity iframe, with no hardcoded prefix. The server injects the Discord application (client) id
 * into `window.__DRAFT_CONFIG__`; the client feature-detects Discord and only runs the SDK handshake
 * there, falling back to the manual-entry dev board otherwise.
 */

import { jsonForScript } from './scriptIsland.js';

/** The dashboard HTML for the given Discord application (client) id (`''` in dev / standalone). */
export function boardHtml(clientId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Draft Dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #0f1115; color: #e7e9ee; }
  header { padding: 14px 20px; border-bottom: 1px solid #222634; display: flex; align-items: center;
    gap: 14px; flex-wrap: wrap; position: sticky; top: 0; background: #0f1115; z-index: 5; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .2px; color: #aab2c5; }
  /* The clock keeps its margin-left:auto right-push; the link rides just left of it. */
  .lottery-link { font-size: 12px; font-weight: 700; color: #f5d67b; text-decoration: none;
    border: 1px solid rgba(245,214,123,.35); border-radius: 999px; padding: 4px 12px; }
  .lottery-link:hover { background: rgba(245,214,123,.08); }
  .pill { font-size: 12px; padding: 3px 9px; border-radius: 999px; background: #1b2130; color: #9aa4bd; }
  .pill.live { background: #113526; color: #4ade80; }
  .pill.err { background: #3a1620; color: #f87171; }
  .clock { margin-left: auto; font-size: 13px; color: #9aa4bd; text-align: right; }
  .clock b { color: #e7e9ee; }
  main { max-width: 1100px; margin: 0 auto; padding: 18px 20px 48px; display: grid;
    grid-template-columns: 1fr 300px; gap: 18px; }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } }
  .entry { grid-column: 1 / -1; display: flex; gap: 8px; flex-wrap: wrap; }
  .entry input { flex: 1; min-width: 180px; padding: 9px 12px; border-radius: 9px; border: 1px solid #2a3145;
    background: #10141d; color: #e7e9ee; font-size: 14px; }
  .entry button { padding: 9px 14px; border-radius: 9px; border: 1px solid #2a3145; background: #1b2233;
    color: #cdd4e4; font-size: 13px; font-weight: 600; cursor: pointer; }
  .entry button.ghost { background: transparent; color: #8b93a9; }
  .turn { grid-column: 1 / -1; padding: 12px 16px; border-radius: 12px; background: #151a24;
    border: 1px solid #222634; font-size: 14px; color: #b9c1d4; }
  .turn.mine { background: #12261b; border-color: #1f5138; color: #d6ffe6; }
  .turn b { color: #fff; }
  section { background: #141821; border: 1px solid #212636; border-radius: 12px; padding: 14px 16px; }
  section h2 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .8px;
    color: #7c869e; font-weight: 600; }
  .rec { border-color: #2b3550; background: linear-gradient(180deg,#182034,#141821); }
  .rec .name { font-size: 26px; font-weight: 700; }
  .rec .meta { color: #9aa4bd; font-size: 14px; margin-top: 2px; }
  .rec .reason { margin-top: 8px; font-size: 14px; color: #cdd4e4; }
  .row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid #1c2130; }
  .row:first-of-type { border-top: 0; }
  .row .nm { font-weight: 600; }
  .row .sub { color: #7c869e; font-size: 12px; margin-left: auto; text-align: right; }
  .pos { font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 5px; background: #232a3b;
    color: #aeb7cd; min-width: 30px; text-align: center; }
  .pos.RB { background: #12332a; color: #5be6b1; } .pos.WR { background: #142b3c; color: #6cc6ff; }
  .pos.QB { background: #331d2c; color: #ff8fc0; } .pos.TE { background: #33290f; color: #f2b955; }
  .tag { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 999px; }
  .tag.value { background: #123322; color: #4ade80; } .tag.reach { background: #33260f; color: #fbbf24; }
  .tag.wait { background: #21283a; color: #93a0bd; }
  .side { display: flex; flex-direction: column; gap: 18px; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; }
  .need { font-size: 12px; font-weight: 700; padding: 3px 8px; border-radius: 6px; background: #33260f;
    color: #fbbf24; }
  .need.none { background: #123322; color: #4ade80; }
  .recent .row { font-size: 13px; padding: 5px 0; }
  .recent .ov { color: #7c869e; min-width: 34px; font-variant-numeric: tabular-nums; }
  .recent .row.mine .nm { color: #7ee7ad; }
  .empty { color: #6b7590; font-size: 14px; padding: 8px 0; }
  footer { max-width: 1100px; margin: 0 auto; padding: 0 20px 30px; color: #5c657d; font-size: 12px; }
</style>
</head>
<body>
<header>
  <h1>Draft Dashboard</h1>
  <span id="status" class="pill">connecting…</span>
  <div class="clock" id="clock"></div>
  <!-- The doorway to the idle lottery screen (#253): the Activity always opens at the root, and
       the #192 mode-switch serves this dashboard while the stage is idle — which is exactly the
       phase the "start a lottery" button lives in. Same-origin relative nav works through the
       Discord proxy. -->
  <a class="lottery-link" href="./lottery">&#127920; Draft-order lottery</a>
</header>
<main>
  <form class="entry" id="entry">
    <input id="playerName" type="text" placeholder="Enter the next pick — player name…" autocomplete="off" />
    <button type="submit">Add pick</button>
    <button type="button" class="ghost" id="reset">Reset</button>
  </form>
  <div class="turn" id="turn"></div>
  <section class="rec" id="rec-wrap" style="grid-column:1 / -1">
    <h2>Recommended pick</h2>
    <div id="rec"></div>
  </section>
  <section>
    <h2>Alternatives</h2>
    <div id="alts"></div>
  </section>
  <div class="side">
    <section>
      <h2>Fill a need</h2>
      <div id="byneed"></div>
    </section>
    <section>
      <h2>Your roster</h2>
      <div class="badges" id="needs" style="margin-bottom:10px"></div>
      <div id="roster"></div>
    </section>
  </div>
  <section class="recent" style="grid-column:1 / -1">
    <h2>Recent picks</h2>
    <div id="recent"></div>
  </section>
</main>
<footer id="meta"></footer>
<script>window.__DRAFT_CONFIG__ = { clientId: ${jsonForScript(clientId)} };</script>
<script type="module" src="./client/activity.js"></script>
</body>
</html>`;
}
