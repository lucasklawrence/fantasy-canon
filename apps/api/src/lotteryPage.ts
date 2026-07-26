/**
 * The lottery-machine page shell, served at `/lottery` (#169). Static HTML + inline CSS with no
 * inline logic — the presentation is driven entirely by the bundled client
 * (`src/client/lottery.ts` → `dist/client/lottery.js`), which renders server-pushed beats only.
 * Same shell pattern as the draft board (`board.ts`): relative bundle `src` so it resolves under
 * the backend root in dev or `/.proxy/` inside the Discord Activity iframe, and the Discord app id
 * injected via `window.__DRAFT_CONFIG__`.
 */

/** Escape a value for safe interpolation inside a `<script>` JSON island (see `board.ts`). */
function jsonForScript(value: unknown): string {
  const LINE_SEP = String.fromCharCode(0x2028);
  const PARA_SEP = String.fromCharCode(0x2029);
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .split(LINE_SEP)
    .join('\\u2028')
    .split(PARA_SEP)
    .join('\\u2029');
}

/** The lottery-machine HTML for the given Discord application (client) id (`''` in dev). */
export function lotteryHtml(clientId: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>The Lottery Machine</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(1200px 700px at 50% -10%, #1a2036 0%, #0c0e16 60%, #08090f 100%);
    color: #e7e9ee; min-height: 100vh; }
  header { padding: 14px 20px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; font-weight: 700; letter-spacing: .4px; color: #f5d67b; }
  .pill { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: #1b2130; color: #9aa4bd; }
  .pill.live { background: #113526; color: #4ade80; }
  .pill.err { background: #3a1620; color: #f87171; }
  .commit { margin-left: auto; font-size: 11px; color: #5c657d; font-family: ui-monospace, monospace; }
  main { max-width: 980px; margin: 0 auto; padding: 8px 20px 60px; }
  .hidden { display: none !important; }
  section.card { background: rgba(20,24,33,.85); border: 1px solid #232a3d; border-radius: 16px;
    padding: 20px 22px; margin-top: 16px; }
  h2 { margin: 0 0 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;
    color: #7c869e; font-weight: 700; }

  /* waiting room */
  #waiting .headline { font-size: 26px; font-weight: 800; text-align: center; margin: 6px 0 2px; }
  #waiting .sub { text-align: center; color: #9aa4bd; margin-bottom: 14px; }
  #waiting .pulse { text-align: center; color: #f5d67b; animation: pulse 1.6s ease-in-out infinite; }
  table.odds { width: 100%; border-collapse: collapse; font-size: 14px; }
  table.odds th { text-align: left; color: #7c869e; font-size: 11px; text-transform: uppercase;
    letter-spacing: .8px; padding: 6px 8px; border-bottom: 1px solid #232a3d; }
  table.odds td { padding: 7px 8px; border-bottom: 1px solid #1a2030; }
  table.odds td.num { text-align: right; font-variant-numeric: tabular-nums; color: #b9c1d4; }
  .ballbar { display: inline-block; height: 8px; border-radius: 4px;
    background: linear-gradient(90deg, #f5d67b, #e8a33d); vertical-align: middle; }

  /* the machine */
  .machine { display: grid; grid-template-columns: 300px 1fr; gap: 20px; align-items: start; }
  @media (max-width: 760px) { .machine { grid-template-columns: 1fr; } }
  .hopper { position: relative; width: 260px; height: 260px; margin: 10px auto; border-radius: 50%;
    border: 3px solid #2b3550; background: radial-gradient(circle at 35% 30%, #1c2338, #10141f 70%);
    overflow: hidden; box-shadow: inset 0 -18px 40px rgba(0,0,0,.5), 0 0 40px rgba(245,214,123,.06); }
  .hopper .ball { position: absolute; width: 34px; height: 34px; border-radius: 50%;
    background: radial-gradient(circle at 32% 28%, #fff 0%, #f5d67b 35%, #c8912e 100%);
    animation: jiggle 1.2s ease-in-out infinite alternate; box-shadow: 0 3px 6px rgba(0,0,0,.5); }
  .hopper.spinning .ball { animation-duration: .35s; }
  .chute { width: 12px; height: 34px; margin: -4px auto 0; background: #2b3550; border-radius: 0 0 6px 6px; }
  #drum .now { font-size: 22px; font-weight: 800; text-align: center; color: #f5d67b;
    animation: pulse 0.9s ease-in-out infinite; margin: 8px 0 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
  .chip { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px;
    background: #1b2233; color: #cdd4e4; border: 1px solid #2a3145; }
  .chip.dim { opacity: .35; text-decoration: line-through; }

  /* the drop */
  #drop { text-align: center; }
  #drop .dropball { width: 120px; height: 120px; margin: 6px auto 10px; border-radius: 50%;
    background: radial-gradient(circle at 32% 28%, #fff 0%, #f5d67b 30%, #c8912e 100%);
    display: flex; align-items: center; justify-content: center; color: #201a08; font-weight: 900;
    font-size: 34px; animation: drop .8s cubic-bezier(.22,1.4,.36,1); box-shadow: 0 10px 30px rgba(0,0,0,.55); }
  #drop .team { font-size: 30px; font-weight: 900; margin-top: 4px; }
  #drop .odds { color: #f5d67b; font-weight: 700; margin-top: 2px; animation: flash 1.1s ease-out; }

  /* results board */
  #board ol { list-style: none; margin: 0; padding: 0; }
  #board li { display: flex; align-items: center; gap: 12px; padding: 8px 6px;
    border-bottom: 1px solid #1a2030; font-size: 15px; }
  #board li .pk { width: 34px; height: 34px; border-radius: 50%; background: #1b2233;
    color: #f5d67b; font-weight: 800; display: flex; align-items: center; justify-content: center; }
  #board li.first .pk { background: linear-gradient(135deg, #f5d67b, #e8a33d); color: #201a08; }
  #board li .tm { font-weight: 700; }
  #board li .meta { margin-left: auto; color: #7c869e; font-size: 12px; }

  /* verify + abort */
  #verify code { display: block; font-size: 11px; color: #9aa4bd; word-break: break-all;
    background: #10141d; border: 1px solid #232a3d; border-radius: 8px; padding: 8px 10px; margin: 6px 0; }
  #abort { border-color: #55202c; background: rgba(58,22,32,.6); color: #fecaca; }

  /* confetti */
  .confetti { position: fixed; top: -12px; width: 10px; height: 16px; opacity: .9; z-index: 40;
    animation: confetti linear forwards; }

  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .45 } }
  @keyframes jiggle { from { transform: translate(0,0) rotate(-6deg) } to { transform: translate(6px,-10px) rotate(8deg) } }
  @keyframes drop { 0% { transform: translateY(-220px) scale(.6); opacity: 0 }
    60% { transform: translateY(12px) scale(1.04); opacity: 1 } 80% { transform: translateY(-8px) }
    100% { transform: translateY(0) scale(1) } }
  @keyframes flash { 0% { text-shadow: 0 0 18px rgba(245,214,123,.9); transform: scale(1.15) }
    100% { text-shadow: none; transform: scale(1) } }
  @keyframes confetti { to { transform: translateY(105vh) rotate(720deg); opacity: .7 } }
</style>
</head>
<body>
<header>
  <h1 id="title">The Lottery Machine</h1>
  <span id="status" class="pill">connecting…</span>
  <span class="commit" id="commit"></span>
</header>
<main>
  <section class="card" id="waiting">
    <div class="headline">The hopper is loaded.</div>
    <div class="sub" id="waiting-sub"></div>
    <h2>Odds</h2>
    <table class="odds">
      <thead><tr><th>Team</th><th>Balls</th><th></th><th style="text-align:right">#1 pick</th><th style="text-align:right">Top 3</th></tr></thead>
      <tbody id="odds-rows"></tbody>
    </table>
    <p class="pulse">Waiting for the commissioner to seal the bag…</p>
  </section>

  <section class="card hidden" id="stage">
    <div class="machine">
      <div>
        <div class="hopper" id="hopper"></div>
        <div class="chute"></div>
      </div>
      <div>
        <div id="drum">
          <div class="now" id="drum-now"></div>
          <h2>Still in the hopper</h2>
          <div class="chips" id="drum-remaining"></div>
        </div>
        <div id="drop" class="hidden">
          <div class="dropball" id="drop-pick"></div>
          <div class="team" id="drop-team"></div>
          <div class="odds" id="drop-odds"></div>
        </div>
      </div>
    </div>
  </section>

  <section class="card hidden" id="board">
    <h2>The order so far</h2>
    <ol id="board-list"></ol>
  </section>

  <section class="card hidden" id="verify">
    <h2>Verify it yourself</h2>
    <p style="margin:0 0 6px;color:#9aa4bd;font-size:13px">Replay the draw from the revealed seed — the bot posted the same values in the channel.</p>
    <code id="verify-commitment"></code>
    <code id="verify-seed"></code>
    <code id="verify-salt"></code>
    <code id="verify-drawseed"></code>
  </section>

  <section class="card hidden" id="abort">
    <h2>Ceremony aborted</h2>
    <p id="abort-reason" style="margin:0"></p>
  </section>
</main>
<script>window.__DRAFT_CONFIG__ = { clientId: ${jsonForScript(clientId)} };</script>
<script type="module" src="./client/lottery.js"></script>
</body>
</html>`;
}
