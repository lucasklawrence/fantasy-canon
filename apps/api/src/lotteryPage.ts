/**
 * The lottery-machine page shell, served at `/lottery` (#169). Static HTML + inline CSS with no
 * inline logic — the presentation is driven entirely by the bundled client
 * (`src/client/lottery.ts` → `dist/client/lottery.js`), which renders server-pushed beats only.
 * Same shell pattern as the draft board (`board.ts`): relative bundle `src` so it resolves under
 * the backend root in dev or `/.proxy/` inside the Discord Activity iframe, and the Discord app id
 * injected via `window.__DRAFT_CONFIG__`.
 */

import { jsonForScript } from './scriptIsland.js';

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
  /* The 🔊 toggle (#216) — the click that arms audio is also the browser's autoplay gesture. */
  .pill.sound { cursor: pointer; font: inherit; font-size: 13px; border: 1px solid #2a3145;
    line-height: 1; transition: background .2s, box-shadow .2s; }
  .pill.sound:hover { background: #232c42; }
  .pill.sound.on { border-color: rgba(245,214,123,.4); box-shadow: 0 0 8px rgba(245,214,123,.18); }
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
  /* Ball identity in the odds table (#211): team color swatch + the team's bag numbers. */
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%;
    margin-right: 7px; vertical-align: baseline; box-shadow: 0 1px 2px rgba(0,0,0,.4); }
  .brange { color: #7c869e; font-size: 11px; margin-left: 6px; }

  /* the machine */
  .machine { display: grid; grid-template-columns: 300px 1fr; gap: 20px; align-items: start; }
  @media (max-width: 760px) { .machine { grid-template-columns: 1fr; } }
  .hopper { position: relative; width: 260px; height: 260px; margin: 10px auto 0; border-radius: 50%;
    border: 3px solid #2b3550; background: radial-gradient(circle at 35% 30%, #1c2338, #10141f 70%);
    overflow: hidden; box-shadow: inset 0 -18px 40px rgba(0,0,0,.5), 0 0 40px rgba(245,214,123,.06); }
  /* The ball pile is a physics sim on this canvas (#211, hopperSim.ts); the pull overlays it. */
  #hopper-canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .hopper.spinning { animation: agitate .22s linear infinite; }
  /* The chute is a clear tube: the pulled ball is visible sliding down inside it. */
  .chute { position: relative; width: 20px; height: 46px; margin: -4px auto 0; overflow: hidden;
    background: linear-gradient(180deg, rgba(43,53,80,.28), rgba(43,53,80,.55));
    border: 1px solid #2b3550; border-top: none; border-radius: 0 0 10px 10px;
    transition: box-shadow .3s, border-color .3s; }
  .chute.active { border-color: rgba(245,214,123,.5);
    box-shadow: 0 0 14px rgba(245,214,123,.28), inset 0 0 8px rgba(245,214,123,.18); }

  /* the pull (#195): one ball is sucked to the chute mouth, slides the tube, and waits at the
     exit until the reveal hands it off to the big drop ball (FLIP in the client). */
  .pullball { position: absolute; border-radius: 50%;
    background: radial-gradient(circle at 32% 28%, #fff 0%, #f5d67b 35%, #c8912e 100%);
    box-shadow: 0 2px 5px rgba(0,0,0,.5); opacity: 0; pointer-events: none; }
  #suck-ball { width: 26px; height: 26px; left: calc(50% - 13px); top: 40%; }
  #tube-ball { width: 14px; height: 14px; left: calc(50% - 7px); top: -14px; }
  .machine-left.pulling #suck-ball { animation: suck .5s cubic-bezier(.55,0,.85,.55) forwards; }
  .machine-left.pulling #tube-ball {
    animation: tube .55s .42s cubic-bezier(.45,0,.85,.6) forwards,
      held-pulse .9s 1.1s ease-in-out infinite; }
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
    font-size: 34px; box-shadow: 0 10px 30px rgba(0,0,0,.55); will-change: transform; }
  /* Handoff from the chute exit: the client sets a translate+scale start transform, then clears
     it under this transition (FLIP). .fall is the fallback when the chute can't be measured. */
  #drop .dropball.flip { transition: transform .62s cubic-bezier(.22,1.35,.36,1); }
  #drop .dropball.fall { animation: drop .8s cubic-bezier(.22,1.4,.36,1); }
  #drop .team { font-size: 30px; font-weight: 900; margin-top: 4px;
    animation: rise .45s .18s cubic-bezier(.2,.9,.3,1.4) backwards; }
  #drop .odds { color: #f5d67b; font-weight: 700; margin-top: 2px;
    animation: flash 1.1s .3s ease-out backwards; }

  /* results board + replay (#197) */
  .board-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .replay { font: inherit; font-size: 12px; font-weight: 700; color: #f5d67b; background: #1b2233;
    border: 1px solid rgba(245,214,123,.35); border-radius: 999px; padding: 5px 14px;
    cursor: pointer; transition: background .2s, box-shadow .2s; }
  .replay:hover { background: #232c42; box-shadow: 0 0 10px rgba(245,214,123,.25); }
  .pill.skip { cursor: pointer; font: inherit; font-size: 12px; border: 1px solid #2a3145;
    background: #1b2233; color: #cdd4e4; transition: background .2s; }
  .pill.skip:hover { background: #232c42; }
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

  /* confetti — pointer-events off so falling pieces never swallow a Replay/skip click */
  .confetti { position: fixed; top: -12px; width: 10px; height: 16px; opacity: .9; z-index: 40;
    animation: confetti linear forwards; pointer-events: none; }

  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .45 } }
  @keyframes agitate { 0%,100% { transform: translate(0,0) } 25% { transform: translate(1px,-1px) }
    50% { transform: translate(-1px,1px) } 75% { transform: translate(1px,1px) } }
  @keyframes suck { 0% { opacity: 0; transform: translate(0,0) scale(1) } 12% { opacity: 1 }
    55% { transform: translate(-7px,70px) scale(.85) }
    100% { opacity: 1; transform: translate(0,165px) scale(.55) } }
  @keyframes tube { 0% { opacity: 0; transform: translateY(0) } 20% { opacity: 1 }
    100% { opacity: 1; transform: translateY(46px) } }
  @keyframes held-pulse { 0%,100% { box-shadow: 0 0 4px rgba(245,214,123,.5) }
    50% { box-shadow: 0 0 12px rgba(245,214,123,.95) } }
  @keyframes drop { 0% { transform: translateY(-220px) scale(.6); opacity: 0 }
    60% { transform: translateY(12px) scale(1.04); opacity: 1 } 80% { transform: translateY(-8px) }
    100% { transform: translateY(0) scale(1) } }
  @keyframes rise { from { opacity: 0; transform: translateY(10px) scale(.9) }
    to { opacity: 1; transform: none } }
  @keyframes flash { 0% { text-shadow: 0 0 18px rgba(245,214,123,.9); transform: scale(1.15) }
    100% { text-shadow: none; transform: scale(1) } }
  @keyframes confetti { to { transform: translateY(105vh) rotate(720deg); opacity: .7 } }

  @media (prefers-reduced-motion: reduce) {
    .hopper.spinning, .pullball, #drop .dropball, #drop .team, #drop .odds,
    .confetti, #waiting .pulse, #drum .now { animation: none !important; transition: none !important; }
    #drop .dropball.flip { transition: none !important; }
    /* The canvas pile honors this too — hopperSim renders a settled still frame, no loop. */
  }
</style>
</head>
<body>
<header>
  <h1 id="title">The Lottery Machine</h1>
  <span id="status" class="pill">connecting…</span>
  <button id="sound-btn" class="pill sound" type="button" title="Sound is off — click to enable">&#128263;</button>
  <button id="replay-skip" class="pill skip hidden" type="button">&#9197; skip to result</button>
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
      <div class="machine-left" id="machine-left">
        <div class="hopper" id="hopper"><canvas id="hopper-canvas"></canvas><div class="pullball" id="suck-ball"></div></div>
        <div class="chute" id="chute"><div class="pullball" id="tube-ball"></div></div>
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
    <div class="board-head">
      <h2>The order so far</h2>
      <button id="replay-btn" class="replay hidden" type="button">&#8635; Replay the reveal</button>
    </div>
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
