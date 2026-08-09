/**
 * The lottery-machine page shell, served at `/lottery` (#169). Static HTML + inline CSS with no
 * inline logic — the presentation is driven entirely by the bundled client
 * (`src/client/lottery.ts` → `dist/client/lottery.js`), which renders server-pushed beats only.
 * Same shell pattern as the draft board (`board.ts`): relative bundle `src` so it resolves under
 * the backend root in dev or `/.proxy/` inside the Discord Activity iframe, and the Discord app id
 * injected via `window.__DRAFT_CONFIG__`.
 */

import { MAX_TEAM_BALLS } from '@fantasy-canon/core';
import { jsonForScript } from './scriptIsland.js';

/** The lottery-machine HTML for the given Discord application (client) id (`''` in dev). */
export function lotteryHtml(clientId: string, maxTeamBalls: number = MAX_TEAM_BALLS): string {
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
  /* Ambient backdrop (#256): the margins a capped column leaves over are also the atmosphere
     opportunity, so a few very soft, very slow lottery-hue blobs drift behind everything.
     CSS-only on purpose — no rAF and no canvas, so it adds no third animation loop beside the
     hopper and race sims, the compositor owns it, and the browser throttles it for free when
     the tab is hidden. Kept deliberately dim: it must never compete with the reveal.
     Fixed positioning + z-index -1 + pointer-events:none = it can neither scroll-jank nor
     intercept a click (the #202 confetti lesson). */
  .ambient { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; }
  .ambient span { position: absolute; border-radius: 50%; filter: blur(70px); opacity: .2; }
  .ambient span:nth-child(1) { width: 46vmin; height: 46vmin; left: -10vmin; top: 8vh;
    background: #f5d67b; animation: drift1 46s ease-in-out infinite alternate; }
  .ambient span:nth-child(2) { width: 40vmin; height: 40vmin; right: -8vmin; top: 30vh;
    background: #4b7bd1; animation: drift2 58s ease-in-out infinite alternate; }
  .ambient span:nth-child(3) { width: 34vmin; height: 34vmin; left: 18vw; bottom: -10vmin;
    background: #8b5cf6; opacity: .15; animation: drift3 64s ease-in-out infinite alternate; }
  @keyframes drift1 { from { transform: translate3d(0,0,0) } to { transform: translate3d(6vw,-6vh,0) } }
  @keyframes drift2 { from { transform: translate3d(0,0,0) } to { transform: translate3d(-5vw,7vh,0) } }
  @keyframes drift3 { from { transform: translate3d(0,0,0) } to { transform: translate3d(4vw,-5vh,0) } }
  /* The backdrop exists to dress margins a phone does not have, and three large blurred layers
     are real GPU work in a mobile webview — so the small screen gets one cheaper blob, not three.
     (This is also the only place the ambient touches mobile at all.) */
  @media (max-width: 760px) {
    .ambient span { filter: blur(48px); opacity: .16; }
    .ambient span:nth-child(2), .ambient span:nth-child(3) { display: none; }
  }

  header { padding: 14px 20px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; font-weight: 700; letter-spacing: .4px; color: #f5d67b; }
  .pill { font-size: 12px; padding: 3px 10px; border-radius: 999px; background: #1b2130; color: #9aa4bd; }
  /* The 🔊 toggle (#216) — the click that arms audio is also the browser's autoplay gesture. */
  .pill.sound { cursor: pointer; font: inherit; font-size: 13px; border: 1px solid #2a3145;
    line-height: 1; transition: background .2s, box-shadow .2s; }
  .pill.sound:hover { background: #232c42; }
  .pill.sound.on { border-color: rgba(245,214,123,.4); box-shadow: 0 0 8px rgba(245,214,123,.18); }
  /* Sticky handshake-failure indicator (#231) — phase renders never touch it, unlike the status
     pill, so an auth outage stays visible instead of being overwritten by the first repaint. */
  .pill.authwarn { color: #fecaca; background: rgba(58,22,32,.7); border: 1px solid #55202c;
    cursor: help; }
  .pill.live { background: #113526; color: #4ade80; }
  .pill.err { background: #3a1620; color: #f87171; }
  .commit { margin-left: auto; font-size: 11px; color: #5c657d; font-family: ui-monospace, monospace; }
  main { max-width: 980px; margin: 0 auto; padding: 8px 20px 60px; }

  /* Use the width (#256). On a desktop Activity window the capped column left the sides empty,
     which is dead space in something meant to be a spectacle. The fix is CONTENT, not a wider
     column: the running board moves out of the scroll and sits beside the stage, so the
     order-so-far is visible during the reveal instead of below the fold.

     ONE breakpoint, and a high one. The rail costs the reveal column 340px + a gap, so opening
     it at 1200px made the stage NARROWER than the 980px centred layout it replaced — the
     spectacle got worse as the window got bigger, which is the opposite of the ask. 1500px is
     where there is genuinely room for both.

     Machine mode only: race already spends its width on the track (#239), and a third column
     would take it straight back. Below the breakpoint nothing here applies at all. */
  @media (min-width: 1500px) {
    /* Only the showfloor widens. The main element carries every other card too, and stretching a 5-column
       odds table (plus the #252 commissioner panel) across 1600px puts a team's name a screen
       away from its own numbers — so those keep the reading measure they were designed at. */
    body:not(.race) main { max-width: 1560px; }
    body:not(.race) main > section.card { max-width: 980px; margin-left: auto; margin-right: auto; }
    body:not(.race) .showfloor { display: grid; grid-template-columns: minmax(0, 1fr) 340px;
      gap: 16px; align-items: start; }
    /* Inside the grid the stage is the wide item and must NOT keep the 980 measure above. */
    body:not(.race) .showfloor > section.card { max-width: none; margin-left: 0; margin-right: 0; }
    /* The stage owns the scroll; the board rides along beside it. */
    body:not(.race) .showfloor > #board { position: sticky; top: 12px; margin-top: 16px;
      max-height: calc(100vh - 40px); overflow: auto; }
    /* In the narrow rail the heading and the replay button cannot share a line. Scoped to the
       rail: on the finished screen (grid collapsed below) the button must not become a
       full-width pill. */
    body:not(.race) .showfloor:not(:has(> #stage.hidden)) > #board .board-head {
      flex-direction: column; align-items: stretch; }
    /* Once the stage is gone (the finished board, an abort) the rail has nothing to sit beside,
       so the grid collapses and the board becomes an ordinary card — including the 980px reading
       measure, for the same reason the lobby keeps one: a 12-row order stretched across 1520px
       puts a team's name a screen away from its own odds. (.hidden is display:none, so the
       element is still a grid child; :only-child cannot see that, :has can.)

       Deliberately NOT done for a hidden BOARD. Collapsing then would make the stage ~356px
       wider during the opening drum roll and snap it back the instant the first pick lands —
       a lurch at the showcase moment, which is worse than a reserved track nobody looks at. */
    body:not(.race) .showfloor:has(> #stage.hidden) { grid-template-columns: minmax(0, 1fr); }
    body:not(.race) .showfloor:has(> #stage.hidden) > #board { position: static;
      max-height: none; overflow: visible;
      max-width: 980px; margin-left: auto; margin-right: auto; }
    /* The hopper column widens with the drum below. */
    body:not(.race) .machine { grid-template-columns: 360px 1fr; }
  }

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
  /* Team avatar (#242): the ESPN logo, proxied same-origin; sits beside the swatch, never
     replacing it — the swatch is the color link to the balls/racer. */
  .avatar { width: 18px; height: 18px; border-radius: 50%; object-fit: cover;
    vertical-align: -4px; margin-right: 6px; background: #10141d;
    box-shadow: 0 1px 2px rgba(0,0,0,.4); }
  /* Commissioner ball steppers (#210) — only rendered on a pre-commitment lobby, only for the
     member who ran setup. 30px targets keep them tappable on the mobile Activity. */
  td.edit { white-space: nowrap; }
  .step { font: inherit; font-size: 15px; line-height: 1; width: 30px; height: 30px;
    border-radius: 8px; border: 1px solid #2a3145; background: #1b2233; color: #cdd4e4;
    cursor: pointer; vertical-align: middle; transition: background .15s, border-color .15s; }
  .step:hover:enabled { background: #232c42; border-color: rgba(245,214,123,.4); }
  .step:disabled { opacity: .3; cursor: default; }
  .stepval { display: inline-block; min-width: 26px; text-align: center; font-weight: 700;
    vertical-align: middle; }
  #edit-hint { text-align: center; color: #f5d67b; font-size: 13px; margin: 10px 0 0; }
  /* The commissioner panel (#252): one bordered card so the knobs read as A SETTINGS PANEL —
     the scattered controls it replaces went unfound in live use. */
  #commish-panel { margin: 14px 0 0; padding: 12px 12px 10px; border-radius: 12px;
    border: 1px solid rgba(245,214,123,.4); background: rgba(245,214,123,.05); }
  .panel-head { text-align: center; font-size: 12px; font-weight: 800; letter-spacing: .14em;
    text-transform: uppercase; color: #f5d67b; margin-bottom: 10px; }
  .panel-row { text-align: center; margin: 8px 0 0; display: flex; flex-wrap: wrap;
    justify-content: center; align-items: center; gap: 8px; }
  .bulk-input { width: 56px; text-align: center; }
  .pickwrap { color: #7c869e; font-size: 12px; }
  .picker { font: inherit; font-size: 12px; color: #cdd4e4; background: #1b2233;
    border: 1px solid #2a3145; border-radius: 8px; padding: 4px 6px; margin-left: 4px; }
  .replay:disabled { opacity: .4; cursor: default; box-shadow: none; }
  .picker:disabled { opacity: .4; cursor: default; }
  /* Renaming: the team cell becomes an input in place, so the row never reflows (#219). */
  .rename { font: inherit; font-size: 14px; color: #e7e9ee; background: #10141d;
    border: 1px solid #2a3145; border-radius: 6px; padding: 3px 6px; width: 170px; }
  .rename:focus { outline: none; border-color: rgba(245,214,123,.6); }
  .teamname.editable { cursor: text; border-bottom: 1px dashed #3a4258; }

  /* the machine */
  .machine { display: grid; grid-template-columns: 300px 1fr; gap: 20px; align-items: start; }
  @media (max-width: 760px) { .machine { grid-template-columns: 1fr; } }
  /* The drum grows on a wide screen (#256): hopperSim reads clientWidth at construction and its
     packing-fit sizing (#211) scales the balls to match, so a bigger circle means bigger, more
     readable numbers and logos for free. Deliberately a media-query step rather than a live
     resize — the sim's drum geometry, vanes and ball radii are all derived once when it is
     built, so a viewer who resizes mid-session keeps the size they opened at. Inside the
     Activity iframe that is effectively always the final size. */
  /* One source of truth for the drum size (#256). It lives on <body> rather than in the .hopper
     rule because the CLIENT has to read it too: the sim is built from the lobby, while #stage is
     display:none and the canvas measures 0, so it cannot discover its own size. Both steps sit
     together and in ascending order — identical specificity means source order decides, and
     split across the sheet the smaller one silently won at every width. */
  /* --hopper-px is the CANVAS size, not the drum's border box. The client feeds it straight to
     hopperSim as the scene size, and the canvas fills the padding box — 3px of border on each
     side smaller than the element — so .hopper adds the border back rather than the sim being
     handed a value 6px too large for what it actually draws into. */
  body { --hopper-px: 254px; --tube-ball-px: 18px; --chute-px: 20px; --hold-px: 56px; }
  /* One step, at the same breakpoint the layout uses. The chute, its ball and the ball held at
     the mouth (#265) all scale WITH the drum (#256 review): the pile's ball radius is packing-fit
     to the canvas (#211), so growing only the drum would make the ball that leaves the pile
     visibly shrink as it enters the tube — the same identity break #258 just closed at the other
     end of the handoff. */
  @media (min-width: 1500px) {
    body:not(.race) { --hopper-px: 334px; --tube-ball-px: 23px; --chute-px: 26px; --hold-px: 72px; }
  }
  .hopper { position: relative; width: calc(var(--hopper-px) + 6px);
    height: calc(var(--hopper-px) + 6px); margin: 10px auto 0; border-radius: 50%;
    border: 3px solid #2b3550; background: radial-gradient(circle at 35% 30%, #1c2338, #10141f 70%);
    overflow: hidden; box-shadow: inset 0 -18px 40px rgba(0,0,0,.5), 0 0 40px rgba(245,214,123,.06); }
  /* The ball pile is a physics sim on this canvas (#211, hopperSim.ts); the pull overlays it. */
  #hopper-canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
  .hopper.spinning { animation: agitate .22s linear infinite; }
  /* The chute is a clear tube: the pulled ball is visible sliding down inside it. */
  .chute { position: relative; width: var(--chute-px); height: 46px; margin: -4px auto 0;
    overflow: hidden;
    background: linear-gradient(180deg, rgba(43,53,80,.28), rgba(43,53,80,.55));
    border: 1px solid #2b3550; border-top: none; border-radius: 0 0 10px 10px;
    transition: box-shadow .3s, border-color .3s; }
  /* The hold (#265). The chute is ~20px wide and clips, so the ball can never be READ inside it;
     once it clears the mouth it is handed to this, which lives outside the clip and grows to
     camera size. Absolutely positioned so the drum above it never reflows mid-reveal, and only
     ever shown when exitBudget says the gap affords the beat. */
  .machine-left { position: relative; }
  #tube-hold { position: absolute; left: 50%; top: var(--hold-top, 0px);
    width: var(--hold-px); height: var(--hold-px);
    margin-left: calc(var(--hold-px) / -2); border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 15px; color: #14181f; letter-spacing: -.3px;
    box-shadow: 0 6px 18px rgba(0,0,0,.55), 0 0 26px rgba(245,214,123,.22);
    opacity: 0; transform: scale(.18); transform-origin: 50% 0;
    pointer-events: none; z-index: 3; }
  /* Grow, then hold: forwards-filled so the ball simply STAYS at full size for the rest of the
     beat — no second animation, and a hidden tab still ends in the right state. */
  #tube-hold.present { animation: holdgrow var(--hold-grow, 240ms)
    cubic-bezier(.2,.9,.3,1.25) forwards; }
  @keyframes holdgrow { from { opacity: 0; transform: scale(.18) }
    to { opacity: 1; transform: scale(1) } }
  /* Reserve the overhang: the hold is absolutely positioned so it adds no height, and on the
     phone stack the drum panel is followed directly by the reveal column. The ball is placed
     20px up into the mouth, so it hangs (--hold-px - 20) below it; 4px of clearance on top of
     that. Derived rather than a fixed 40px, which was tuned for the 56px ball and left the wide
     breakpoint's 72px one hanging 12px out of the panel. */
  body:not(.race) .machine-left { padding-bottom: calc(var(--hold-px) - 16px); }

  .chute.active { border-color: rgba(245,214,123,.5);
    box-shadow: 0 0 14px rgba(245,214,123,.28), inset 0 0 8px rgba(245,214,123,.18); }

  /* the race (#235): swaps in for the hopper+chute when the ceremony's visual is 'race'.
     Everything on it is canvas (raceSim.ts); the shell only provides the framed track. */
  .racetrack { position: relative; margin: 10px auto 0; border-radius: 12px;
    border: 1px solid #2b3550; overflow: hidden;
    background: linear-gradient(180deg, #10141f 0%, #151a2a 100%);
    box-shadow: inset 0 -12px 30px rgba(0,0,0,.4), 0 0 40px rgba(245,214,123,.05); }
  #race-canvas { display: block; width: 100%; }
  /* the wheel (#244): the third visual. A circle like the drum, so it takes the drum's footprint
     and its breakpoint — no wide mode, nothing to gain from the extra width. Everything on it is
     canvas (wheelSim.ts); the shell only reserves the square. */
  #wheel-canvas { display: block; margin: 10px auto 0;
    width: var(--hopper-px); height: var(--hopper-px);
    filter: drop-shadow(0 6px 22px rgba(0,0,0,.5)); }
  /* Race mode wants the monitor (#239): the page cap lifts and the spare width goes to the
     TRACK (the reveal column keeps a readable fixed measure), so lanes fit whole team names.
     The machine keeps the cozy 980px frame — its drum is a fixed circle and gains nothing.
     Scoped min-width so the 760px single-column stack below still wins on phones. */
  body.race main { max-width: 1500px; }
  @media (min-width: 761px) { body.race .machine { grid-template-columns: 1fr 360px; } }

  /* the exit (#215): once the reveal lands, the drawn ball leaves the pile (canvas, hopperSim),
     then this tinted ball slides the clear tube and FLIPs into the big drop ball (client). */
  .pullball { position: absolute; border-radius: 50%;
    background: radial-gradient(circle at 32% 28%, #fff 0%, #f5d67b 35%, #c8912e 100%);
    box-shadow: 0 2px 5px rgba(0,0,0,.5); opacity: 0; pointer-events: none; }
  /* 18px, not 14 (#258): the descent is the first sight of the drawn team's face, and a logo at
     14px is a smudge. The size is the only thing that changed — the transit keeps its original
     duration, because the exit chain (extraction + transit + the drop ball's own .62s flip)
     already fits its gap with barely 140ms to spare. Giving the ball real screen time means
     re-planning that whole chain, which is its own piece of work. */
  #tube-ball { width: var(--tube-ball-px); height: var(--tube-ball-px);
    left: calc(50% - var(--tube-ball-px) / 2); top: calc(var(--tube-ball-px) * -1);
    background-size: cover; background-position: center; }
  /* Duration comes from the exit planner via --tube-ms (#265), not from a number typed here: the
     budget decides how much of the gap the descent may spend, and a fixed .4s turned every extra
     millisecond it granted into a frozen ball parked in the tube. The literal is the floor the
     planner never goes below, kept only as the pre-first-reveal fallback. */
  #tube-ball.transit { animation: tube var(--tube-ms, .4s) cubic-bezier(.45,0,.85,.6) forwards; }
  #drum .now { font-size: 22px; font-weight: 800; text-align: center; color: #f5d67b;
    animation: pulse 0.9s ease-in-out infinite; margin: 8px 0 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
  .chip { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px;
    background: #1b2233; color: #cdd4e4; border: 1px solid #2a3145; }
  .chip.dim { opacity: .35; text-decoration: line-through; }

  /* The pick-#1 envelope (#243). Fixed overlay, pure CSS choreography: dim in, flap opens, the
     card rises out of the pocket. Every animation is forwards-filled and finite; the overlay
     is dismissed by the client's timer/token, never by animation events, so a frozen (hidden)
     tab can't strand it. */
  #envelope { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center;
    justify-content: center; background: rgba(6, 8, 14, 0); pointer-events: none; }
  #envelope.playing { background: rgba(6, 8, 14, .78); transition: background .45s ease-out; }
  #envelope .env { position: relative; width: min(340px, 86vw); height: 300px; }
  .env-pocket { position: absolute; left: 0; right: 0; bottom: 24px; height: 150px;
    background: linear-gradient(180deg, #232c42, #161c2c); border: 1px solid rgba(245,214,123,.5);
    border-radius: 10px; box-shadow: 0 18px 50px rgba(0,0,0,.6); z-index: 3; }
  .env-flap { position: absolute; left: 0; right: 0; bottom: 172px; height: 96px; z-index: 4;
    background: linear-gradient(180deg, #2a3450, #1b2233);
    clip-path: polygon(0 100%, 50% 0, 100% 100%); transform-origin: 50% 100%;
    transform: rotate(180deg); border-radius: 8px 8px 0 0; }
  #envelope.playing .env-flap { animation: envFlap .5s .45s cubic-bezier(.4,0,.4,1) forwards; }
  @keyframes envFlap { to { transform: rotate(0deg); opacity: 0; } }
  .env-seal { position: absolute; left: 50%; top: 46px; transform: translateX(-50%);
    font-size: 26px; z-index: 5; filter: drop-shadow(0 2px 6px rgba(0,0,0,.6)); }
  .env-card { position: absolute; left: 16px; right: 16px; bottom: 40px; z-index: 2;
    background: linear-gradient(180deg, #f7f2e2, #e8dfc2); color: #201a08; border-radius: 8px;
    padding: 18px 14px 20px; text-align: center; transform: translateY(46px);
    box-shadow: 0 8px 26px rgba(0,0,0,.45); }
  #envelope.playing .env-card { animation: envCard .8s .95s cubic-bezier(.22,1.2,.36,1) forwards; }
  @keyframes envCard { to { transform: translateY(-96px); z-index: 6; } }
  .env-eyebrow { font-size: 11px; font-weight: 800; letter-spacing: .18em;
    text-transform: uppercase; color: #8a7433; margin-bottom: 8px; }
  #env-logo { width: 64px; height: 64px; border-radius: 50%; object-fit: cover;
    box-shadow: 0 2px 8px rgba(0,0,0,.35); margin-bottom: 6px; }
  /* No-logo fallback (#243): the team's hue disc with its initial — the card is never faceless. */
  #env-disc { width: 64px; height: 64px; border-radius: 50%; margin: 0 auto 6px;
    display: flex; align-items: center; justify-content: center; color: #fff;
    font-size: 30px; font-weight: 900; box-shadow: 0 2px 8px rgba(0,0,0,.35); }
  #env-team { font-size: 24px; font-weight: 900; line-height: 1.15; }

  /* the drop */
  #drop { text-align: center; }
  #drop .dropball { width: 120px; height: 120px; margin: 6px auto 10px; border-radius: 50%;
    background: radial-gradient(circle at 32% 28%, #fff 0%, #f5d67b 30%, #c8912e 100%);
    display: flex; align-items: center; justify-content: center; color: #201a08; font-weight: 900;
    font-size: 34px; box-shadow: 0 10px 30px rgba(0,0,0,.55); will-change: transform; }
  /* Handoff from the chute exit: the client sets a translate+scale start transform, then clears
     it under this transition (FLIP). .fall is the fallback when the chute can't be measured. */
  /* --flip-ms is written from the planner's FLIP_MS (#265) — this phase is the one the budget
     most often gets billed for, so the stylesheet must not hold a second opinion about it. */
  #drop .dropball.flip { transition: transform var(--flip-ms, .62s) cubic-bezier(.22,1.35,.36,1); }
  #drop .dropball.fall { animation: drop .8s cubic-bezier(.22,1.4,.36,1); }
  /* Logo face (#242): the ball number now sits on artwork, so it needs its own contrast. */
  #drop .dropball.logo-face { color: #fff; text-shadow: 0 2px 8px rgba(0,0,0,.9),
    0 0 3px rgba(0,0,0,.9); }
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
  /* Ends at 44px, not 46: the chute's padding box is 45px tall and clips, so the taller 18px
     ball (#258) must stop with its bottom inside that or the mouth shears it. */
  /* Size-independent by construction: the ball starts at top:-1em-of-itself, so translating a
     fixed 44px always lands its BOTTOM edge at 44 — inside the 45px clip whether the ball is the
     base 18px or the wide-screen 23px (#256). Only the travel distance would need revisiting if
     the chute's own height ever changed. */
  @keyframes tube { 0% { opacity: 0; transform: translateY(0) } 20% { opacity: 1 }
    100% { opacity: 1; transform: translateY(44px) } }
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
    /* The hold is currently unreachable under reduced motion — extractBall resolves false, so the
       choreography never flies and presentAtMouth is never called — but the sheet should not
       depend on a guard in another module. If it ever does render, it appears at full size with
       no grow rather than animating. */
    #tube-hold.present { animation: none !important; opacity: 1; transform: scale(1); }
    /* The backdrop stays — it is atmosphere, not motion — but it stops drifting (#256). */
    .ambient span { animation: none !important; }
    /* The canvas pile honors this too — hopperSim renders a settled still frame, no loop. */
  }
</style>
</head>
<body>
<div class="ambient" aria-hidden="true"><span></span><span></span><span></span></div>
<header>
  <h1 id="title">The Lottery Machine</h1>
  <span id="status" class="pill">connecting…</span>
  <button id="sound-btn" class="pill sound" type="button" title="Sound is off — click to enable">&#128263;</button>
  <span id="auth-warn" class="pill authwarn hidden">&#9888; sign-in failed</span>
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
    <!-- The start doorbell (#253): idle-only, visible to everyone — the BOT verifies Manage
         Server before honouring a press, and a refusal comes back on the status pill. -->
    <div id="setup-actions" class="panel-row hidden">
      <label class="pickwrap">Season
        <input id="setup-season" class="picker bulk-input" type="number" min="2020" max="2100" value="2025">
      </label>
      <button id="setup-btn" class="replay" type="button">&#127920; Start a lottery</button>
    </div>
    <!-- The commissioner panel (#252): every knob in one visibly-distinct card, because the
         scattered controls it replaces went unnoticed by the actual commissioner. -->
    <div id="commish-panel" class="hidden">
      <div class="panel-head">&#128736; Commissioner controls</div>
      <div class="panel-row" id="begin-actions">
        <label class="pickwrap">Reveal every
          <select id="begin-delay" class="picker">
            <option value="5">5s</option>
            <option value="10">10s</option>
            <option value="20" selected>20s</option>
            <option value="30">30s</option>
          </select>
        </label>
        <label class="pickwrap">Order
          <select id="begin-direction" class="picker">
            <option value="worst-to-first" selected>last pick &rarr; pick #1</option>
            <option value="first-to-last">pick #1 &rarr; last pick</option>
          </select>
        </label>
        <label class="pickwrap">Visual
          <select id="begin-visual" class="picker">
            <option value="machine" selected>the ball machine</option>
            <option value="race">the lane race</option>
            <option value="wheel">the wheel</option>
          </select>
        </label>
        <label class="pickwrap">Balls
          <select id="begin-faces" class="picker">
            <option value="numbers" selected>numbered</option>
            <option value="logos">team logos</option>
          </select>
        </label>
        <button id="begin-btn" class="replay" type="button">&#128274; Seal the bag &amp; start the draw</button>
      </div>
      <div class="panel-row" id="bulk-actions">
        <label class="pickwrap">Set every team to
          <input id="bulk-balls" class="picker bulk-input" type="number" min="1" step="1" value="1">
          ball(s)
        </label>
        <button id="bulk-btn" class="replay" type="button">&#9878; Apply to all</button>
        <label class="pickwrap">Channel updates
          <select id="audit-mode" class="picker">
            <option value="live" selected>every change (silent)</option>
            <option value="seal-only">only at seal</option>
          </select>
        </label>
        <button id="reimport-btn" class="replay" type="button">&#128260; Re-import from ESPN</button>
      </div>
      <p id="edit-hint">You're the commissioner &mdash; adjust the balls or tap a team name to rename it, then seal the bag right here (or with <code>/canon draftorder begin</code>). Everyone watching sees the changes live, and the bot re-posts the final odds card before the commitment.</p>
    </div>
  </section>

  <!-- The stage and the running board are one unit (#256): stacked on a phone, side by side on
       a wide desktop so the order-so-far stays on screen through the reveal. -->
  <div class="showfloor">
  <section class="card hidden" id="stage">
    <div class="machine">
      <div class="machine-left" id="machine-left">
        <div class="hopper" id="hopper"><canvas id="hopper-canvas"></canvas></div>
        <div class="chute" id="chute"><div class="pullball" id="tube-ball"></div></div>
        <div id="tube-hold" aria-hidden="true"></div>
        <div class="racetrack hidden" id="racetrack"><canvas id="race-canvas"></canvas></div>
        <canvas class="hidden" id="wheel-canvas"></canvas>
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
  </div>

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
<!-- The pick-#1 envelope (#243): a self-dismissing overlay ABOVE the normal reveal state, which
     renders regardless — hidden tabs, catch-ups, and reduced motion simply never open this. -->
<div id="envelope" class="hidden" aria-hidden="true">
  <div class="env">
    <div class="env-pocket">
      <div class="env-flap"></div>
      <div class="env-seal">&#127944;</div>
    </div>
    <div class="env-card">
      <div class="env-eyebrow">The first overall pick</div>
      <img id="env-logo" class="hidden" alt="">
      <div id="env-disc" class="hidden"></div>
      <div id="env-team"></div>
    </div>
  </div>
</div>
<script>window.__DRAFT_CONFIG__ = { clientId: ${jsonForScript(clientId)}, maxTeamBalls: ${jsonForScript(maxTeamBalls)} };</script>
<script type="module" src="./client/lottery.js"></script>
</body>
</html>`;
}
