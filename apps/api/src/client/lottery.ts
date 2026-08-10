/**
 * Browser entry for the lottery machine (#169), bundled by esbuild to `dist/client/lottery.js`
 * and loaded by the shell in `lotteryPage.ts`.
 *
 * Pure presentation: every state change arrives from the backend stage (WS push, polling
 * fallback), which the bot paces — this client never draws, times, or decides anything. It
 * renders the full drama: waiting-room odds table → cage spin + drum-roll (chute glowing) → the
 * drawn ball's exit (#215: the actual numbered ball swims out of the pile, slides the tube, and
 * lands as the drop ball) → per-pick odds flash → the growing order board → final board +
 * seed-verify panel (or the abort banner).
 * Inside Discord it runs the shared SDK handshake and `/.proxy` transport; standalone (dev) it
 * skips the SDK — same split as the draft board client.
 */

import type {
  LotteryBeat,
  LotteryEvent,
  LotteryFinish,
  LotteryLobby,
  LotteryOddsRow,
  LotteryPhase,
  LotteryReveal,
  LotterySnapshot,
  LotteryStart,
} from '../lotteryTypes.js';
import { assignBallRanges, drawnBallFor, rangeLabel } from './ballAssignments.js';
import { createCeremonyAudio } from './ceremonyAudio.js';
import { createHopperSim, type HopperSim } from './hopperSim.js';
import { createRaceSim, type RaceSim } from './raceSim.js';
import { createWheelSim, type WheelSim } from './wheelSim.js';
import {
  createPlaybackCursor,
  onHiddenAction,
  type PlaybackClock,
  type PlaybackCursor,
  type PlaybackMode,
} from './playbackCursor.js';
import {
  ENVELOPE_LEAD_MS,
  ENVELOPE_MS,
  envelopeEligible,
  finaleHoldMs,
  finaleSubject,
  type PlaybackKind,
} from './envelopePlan.js';
import {
  buildReplayTimeline,
  catchUpPace,
  catchUpTailFromSnapshot,
  classifyDuringCatchUp,
  REPLAY_DWELL_MS,
  REPLAY_MAX_STEP_MS,
  replayStepMs,
  sameFinishOrder,
  toPendingSteps,
  type CatchUpContext,
  type ReplayOrder,
} from './replayTimeline.js';
import { configuredMaxTeamBalls, runHandshake } from './sdk.js';
// EXTRACT_CAP_MS is the extraction race cap — the sim's rAF loop never resolves in a hidden tab
// (#215). It lives with the planner, which has to know the worst case it may re-plan around (#265).
import { exitBudget, EXTRACT_CAP_MS, FINISH_LEAD_MS, FLIP_MS } from './exitBudget.js';
import { apiPath, isDiscordActivity, proxyBase, wsUrl } from './transport.js';

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function setStatus(text: string, kind?: 'live' | 'err'): void {
  const s = byId('status');
  s.textContent = text;
  s.className = 'pill' + (kind ? ' ' + kind : '');
}

function show(id: string, visible: boolean): void {
  byId(id).classList.toggle('hidden', !visible);
}

/** Is the sealed board already on screen? Distinguishes the finish SWEEP from a later repaint. */
function boardIsUp(): boolean {
  return !byId('board').classList.contains('hidden');
}

/** The board list is rebuilt from all reveals so late joiners and live viewers converge. */
function renderBoard(reveals: LotteryReveal[]): void {
  const sorted = [...reveals].sort((a, b) => a.pick - b.pick);
  paintBoardList(
    sorted.map((r) => ({ pick: r.pick, team: r.team, reveal: r })),
    sorted.length > 0,
  );
  // The wide-screen rail (#256) caps its height and scrolls. The list is sorted by pick, so in
  // 'first-to-last' order the newest reveal is the LAST row — past ~10 picks it lands below the
  // fold of a rail that nothing ever scrolls, and the team just drawn is the one team the side
  // board fails to show. Worst-to-first is unaffected (newest sorts to the top), but keeping the
  // newest row in view is right either way.
  keepNewestPickVisible(reveals);
}

/** Newest pick the rail has been scrolled to, so a repaint of unchanged data leaves it alone. */
let railScrolledToPick: number | null = null;

/**
 * Keep the row for the pick just drawn inside the wide-screen rail (#256).
 *
 * Three things this deliberately does NOT do, each of which it did in its first version:
 * - **No `scrollIntoView`.** That walks every scrollable ancestor, and the document is one — with
 *   a sticky rail taller than the viewport it scrolled the PAGE, dragging the hopper and the
 *   landing ball out of view at the exact moment of the reveal. The scroll is computed and
 *   applied to the rail alone.
 * - **No scrolling on an unchanged repaint.** `renderBoard` also runs on the 2s poll fallback, so
 *   re-scrolling every paint meant a viewer reading an earlier pick was yanked back every two
 *   seconds. It moves only when the newest pick actually changes.
 * - **No measuring before the stage exists.** On the late-join path `renderBoard` runs while
 *   `#stage` is still hidden, where the rail is uncapped and unscrollable — the one case this was
 *   written for. Deferring past the current render pass lets the stage appear first.
 *
 * The deferral is a timer, not `requestAnimationFrame`: rAF does not run in a hidden tab (#207's
 * lesson), so a backgrounded viewer would come back to an unscrolled rail and a queued callback
 * holding a stale row index. Timers still fire there, clamped — the same reason every wait in
 * the exit choreography is a timer (#215).
 */
function keepNewestPickVisible(reveals: LotteryReveal[]): void {
  if (reveals.length === 0) return;
  // ARRIVAL order, not pick order: the default direction is worst-to-first (#200), where the pick
  // just drawn is the LOWEST number. Sorting by pick and taking the last would scroll to pick 12
  // — the oldest reveal — for a whole ceremony. Every transport preserves arrival order (the
  // stage pushes, the snapshot copies, the WS pushes, replay rebuilds step by step), so the last
  // entry is the newest; the sorted list is only used to find the ROW it was painted into.
  const newest = reveals[reveals.length - 1].pick;
  if (newest === railScrolledToPick) return;
  const order = [...reveals].sort((a, b) => a.pick - b.pick).findIndex((r) => r.pick === newest);
  setTimeout(() => {
    const board = document.getElementById('board');
    if (!board || board.scrollHeight <= board.clientHeight + 1) return; // not a scrolling rail
    const row = board.querySelectorAll('#board-list li')[order] as HTMLElement | undefined;
    if (!row) return;
    railScrolledToPick = newest;
    // Manual, and clamped: bring the row just inside the rail's own box, nothing else moves.
    const top = row.offsetTop - board.clientHeight + row.offsetHeight + 8;
    const bottom = row.offsetTop - 8;
    if (board.scrollTop < top) board.scrollTop = Math.min(top, board.scrollHeight);
    else if (board.scrollTop > bottom) board.scrollTop = Math.max(0, bottom);
  }, 0);
}

/**
 * The finished board comes from the authoritative `finish.order` — a transiently-dropped reveal
 * push must not leave a hole in the final result. Per-pick meta joins from whatever reveals did
 * arrive.
 */
function renderFinalBoard(order: { pick: number; team: string }[], reveals: LotteryReveal[]): void {
  const metaByPick = new Map(reveals.map((r) => [r.pick, r]));
  paintBoardList(
    [...order]
      .sort((a, b) => a.pick - b.pick)
      .map((entry) => ({ ...entry, reveal: metaByPick.get(entry.pick) })),
    true,
  );
}

function paintBoardList(
  entries: { pick: number; team: string; reveal?: LotteryReveal }[],
  visible: boolean,
): void {
  const list = byId('board-list');
  clear(list);
  for (const { pick, team, reveal } of entries) {
    const li = el('li', pick === 1 ? 'first' : undefined);
    li.appendChild(el('span', 'pk', String(pick)));
    li.appendChild(el('span', 'tm', team));
    if (reveal) {
      li.appendChild(
        el(
          'span',
          'meta',
          `${reveal.balls} ball${reveal.balls === 1 ? '' : 's'} · ${reveal.oddsPct.toFixed(1)}%`,
        ),
      );
    }
    list.appendChild(li);
  }
  show('board', visible);
}

// The physics hopper (#211). Lazy: the canvas is static markup, but boot order shouldn't matter.
let hopperSim: HopperSim | null = null;
function hopper(): HopperSim {
  // Logo faces (#252) resolve per sprite build: the mode rides `start` (ADR 0008), so the same
  // lookup returns null in numbers mode and during the lobby, keeping the pile numbered there.
  if (!hopperSim) {
    hopperSim = createHopperSim(
      byId('hopper-canvas') as HTMLCanvasElement,
      (team) => (currentStart?.ballFaces === 'logos' ? teamLogo(team) : null),
      drumSizePx(),
    );
  }
  return hopperSim;
}

/**
 * The drum's CSS size, read from `--hopper-px` on `<body>` (#256).
 *
 * The canvas itself cannot answer this: the sim is built lazily from the lobby, while `#stage`
 * is still `display: none`, so `clientWidth` is 0. `<body>` is always rendered, so the custom
 * property resolves at any phase, and the sizes themselves stay in the stylesheet.
 *
 * The BREAKPOINT is duplicated, though: `watchDrumSize` has to name 1500px to know when to re-ask,
 * because a custom property cannot be observed. Only the trigger is duplicated, never the values —
 * and `.race` is a second trigger that fires no event at all, which is why `applyStageLayout`
 * re-asks too.
 */
function drumSizePx(): number {
  return cssPx('--hopper-px', 260);
}

/**
 * Keep the drum tracking the viewport (#267).
 *
 * Driven by the breakpoint rather than by `resize`, so it fires once per crossing instead of once
 * per frame of a drag — rebuilding a matter-js world is not something to do at 60fps. The query
 * has to name the same 1500px the stylesheet uses; the size itself still comes from `--hopper-px`,
 * so the actual numbers stay in one place.
 *
 * The sim may decline while a ball is in flight, so a refused crossing is retried once the exit
 * finishes rather than dropped — otherwise a viewer who resizes mid-reveal keeps the old drum for
 * the rest of the ceremony.
 */
let pendingDrumResize = false;
function watchDrumSize(): void {
  if (typeof window.matchMedia !== 'function') return;
  const wide = window.matchMedia('(min-width: 1500px)');
  const onCross = (): void => flushDrumResize(true);
  // `addEventListener` on MediaQueryList is the modern form; older Safari only has addListener,
  // and the Activity's webview is Chromium, so the modern one is enough here.
  wide.addEventListener('change', onCross);
}

/**
 * Bring the drum to the current `--hopper-px`, or latch the attempt for later.
 *
 * `force` is for the events that CHANGE the size (the breakpoint, the race class coming off);
 * without it this only retries a crossing that was previously refused. A sim that does not exist
 * yet leaves the latch set rather than clearing it — it will be built at the right size, but a
 * later real refusal must not look already-handled.
 */
function flushDrumResize(force = false): void {
  if (!force && !pendingDrumResize) return;
  if (!hopperSim) {
    pendingDrumResize = true;
    return;
  }
  pendingDrumResize = !hopperSim.ensureSize(drumSizePx());
}

/**
 * Read a pixel-valued custom property off `<body>` (#256). `<body>` rather than the element that
 * uses it, because the elements that care live inside `#stage`, which is `display: none` for the
 * whole lobby — and these values have to be readable exactly then.
 */
function cssPx(prop: string, fallback: number): number {
  const px = Number.parseFloat(getComputedStyle(document.body).getPropertyValue(prop));
  return Number.isFinite(px) && px > 0 ? px : fallback;
}

// The race (#235). Same lazy pattern; only the ceremony's active visual ever instantiates its sim,
// so a machine ceremony never pays for lanes and a race never boils an invisible pile.
let raceSim: RaceSim | null = null;
function race(): RaceSim {
  if (!raceSim) raceSim = createRaceSim(byId('race-canvas') as HTMLCanvasElement, teamLogo);
  return raceSim;
}

// The wheel (#244). Lazy like the other two, and sized from `--hopper-px` for the same reason the
// hopper is (#256): it is built while `#stage` is `display: none`, so the canvas measures 0.
let wheelSim: WheelSim | null = null;
function wheel(): WheelSim {
  if (!wheelSim) {
    wheelSim = createWheelSim(byId('wheel-canvas') as HTMLCanvasElement, drumSizePx());
  }
  return wheelSim;
}

// --- team logos (#242): same-origin proxied images, keyed by ceremony teamId -------------------

/**
 * Loading/loaded logo per teamId, remembering WHICH URL it came from — a re-import (#219) can
 * keep a teamId while swapping its logo, and a stale entry would pin the old art for the rest of
 * the page. 'failed' pins a bad fetch so a dead URL is never retried (a new URL retries fresh).
 */
const logoImages = new Map<string, { url: string; img: HTMLImageElement | 'failed' }>();
/** team display name → teamId, for the canvas sims which only know display names. */
const logoIdByTeam = new Map<string, string>();

/** FNV-1a of the stamped URL — busts both browser and Discord-proxy caches when the art changes. */
function logoVersion(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i += 1) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Kick off (idempotent) loads for every row that advertises a logo. The image never comes from
 * ESPN directly — the Activity CSP forbids third-party hosts — but from the api's proxy, which
 * only serves what the bot stamped on the rows.
 */
function ensureLogos(rows: LotteryOddsRow[]): void {
  for (const row of rows) {
    const teamId = row.teamId;
    if (!teamId || !row.logo) continue;
    const url = row.logo;
    logoIdByTeam.set(row.team, teamId);
    if (logoImages.get(teamId)?.url === url) continue;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      // Everything already painted with the fallback face catches up now rather than at the next
      // broadcast: the odds table repaints, both sims reface in place (their `sync` no-ops on an
      // unchanged bag), and a drop ball on screen re-dresses. The hopper reface is a no-op cost
      // outside logo-face mode — its lookup returns null there.
      if (currentLobby) repaintLobbyEdits();
      raceSim?.reface();
      hopperSim?.reface();
      redressDropBall();
      // A logo that lands mid-hold still makes it onto the ball being held up (#265) — the beat
      // exists for the logo, so catching up here matters more than it does for the drop ball.
      if (holdFace) {
        const hold = document.getElementById('tube-hold');
        if (hold) {
          paintBallFace(hold, holdFace.team, holdFace.hue);
          if (hold.classList.contains('logo-face')) hold.textContent = '';
        }
      }
    };
    img.onerror = () => logoImages.set(teamId, { url, img: 'failed' });
    // `v` rides the proxy URL so a *changed* logo escapes the hour-long browser/proxy cache the
    // unchanged case deliberately enjoys.
    img.src = apiPath(
      activityBase,
      `/api/lottery/logo?team=${encodeURIComponent(teamId)}&v=${logoVersion(url)}`,
    );
    logoImages.set(teamId, { url, img });
  }
}

/** A team's decoded logo, name-keyed for the sims; null until loaded or when there is none. */
function teamLogo(team: string): HTMLImageElement | null {
  const id = logoIdByTeam.get(team);
  const img = id !== undefined ? logoImages.get(id)?.img : undefined;
  return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0 ? img : null;
}

// --- the pick-#1 envelope (#243): a self-dismissing finale overlay ----------------------------

/** Supersession token — any close (or newer open) invalidates every timer a prior open armed. */
let envelopeToken = 0;
let envelopeTimer: number | null = null;

/**
 * When the finale stops owning the screen, as a timestamp (#243 live feedback).
 *
 * The bot posts the finish the moment its board PNG renders, which lands while pick #1's ceremony
 * is still playing — so the board used to sweep in behind the overlay and the finale played over a
 * stage that had already moved on. `renderFinish` waits this out instead.
 *
 * Armed at REVEAL time, not when the overlay opens: on the machine the exit choreography runs for
 * ~1.6s before the envelope is even queued, and the finish can arrive inside that window. Cleared
 * by `closeEnvelope`, so a finale that ends early releases the board immediately rather than
 * burning the rest of its deadline.
 */
let finaleUntil = 0;

/** Whether the finale still owns the screen — the finish sweep waits while this is true. */
function finaleHoldsStage(): boolean {
  return finaleUntil > 0 && performance.now() < finaleUntil;
}

/** Tear the overlay down and invalidate any pending open/dismiss timers. Idempotent. */
function closeEnvelope(): void {
  envelopeToken += 1;
  if (envelopeTimer !== null) {
    clearTimeout(envelopeTimer);
    envelopeTimer = null;
  }
  finaleUntil = 0;
  const overlay = byId('envelope');
  overlay.classList.remove('playing');
  show('envelope', false);
  // The board has been waiting on the ceremony; hand it the screen the moment the ceremony ends.
  flushDeferredFinish();
}

/**
 * Open the overlay for pick #1's reveal (#243). Eligibility was checked at queue time, but the
 * hidden check repeats here: the lead timer can fire after a backgrounding, and an overlay opened
 * in a frozen tab would still be mid-animation when the viewer returns.
 */
function openEnvelope(team: string, hue: number | undefined, token: number): void {
  if (token !== envelopeToken || document.visibilityState === 'hidden') return;
  paintEnvelope(team, hue);
  envelopeTimer = window.setTimeout(() => {
    if (token === envelopeToken) closeEnvelope();
  }, ENVELOPE_MS);
}

/** Dress the card and restart the CSS choreography. Shared by the ceremony and the re-open. */
function paintEnvelope(team: string, hue: number | undefined): void {
  byId('env-team').textContent = team;
  // Logo when we have one; otherwise the team's hue disc with its initial — the card is never
  // faceless (the issue's "logo if it exists, else name + hue").
  const logo = teamLogo(team);
  const img = byId('env-logo') as HTMLImageElement;
  if (logo) img.src = logo.src;
  show('env-logo', logo !== null);
  const disc = byId('env-disc');
  disc.textContent = [...team][0]?.toUpperCase() ?? '?';
  disc.style.background = `hsl(${hue ?? 45} 60% 55%)`;
  show('env-disc', logo === null);
  const overlay = byId('envelope');
  show('envelope', true);
  // Restart the CSS choreography from zero even if a previous run left the class set.
  overlay.classList.remove('playing');
  void (overlay as HTMLElement).offsetWidth;
  overlay.classList.add('playing');
}

/**
 * Re-open the finale from the sealed board, on demand and for as long as the viewer wants it.
 *
 * Deliberately NOT subject to `envelopeEligible`: that gate answers "should this play itself",
 * and every one of its reasons to skip (a catch-up sprint, a hidden tab, reduced motion) is about
 * an unasked-for interruption. A viewer pressing a button has asked. Reduced motion still gets a
 * still card rather than the choreography — the stylesheet holds the end states.
 *
 * No auto-dismiss either: the ceremony's copy is a moment that has to keep moving, this one is a
 * thing you opened and can sit with.
 */
function reopenEnvelope(): void {
  const team = finaleTeam;
  if (team === null) return;
  envelopeToken += 1; // retire any pending open/dismiss from the ceremony
  if (envelopeTimer !== null) {
    clearTimeout(envelopeTimer);
    envelopeTimer = null;
  }
  paintEnvelope(team, hueForTeam(team));
}

/** The team the finale is about, once the draw has produced a pick #1. */
let finaleTeam: string | null = null;

/** A team's ceremony hue, for the no-logo disc. Same assignment the pile and the race read. */
function hueForTeam(team: string): number | undefined {
  const rows = currentStart?.rows;
  if (!rows) return undefined;
  return assignBallRanges(rows).find((range) => range.team === team)?.hue;
}

/**
 * Will this reveal get the envelope? The rule itself lives in `envelopePlan` — this only gathers
 * the browser-side inputs. Both the queueing and the exit choreography ask it, so "which pick owns
 * the finale" stays a single decision: #265 first spelled `pick === 1` inline in the choreography,
 * which quietly disagreed with this predicate for a catch-up or a hidden tab and would have had to
 * be edited in two files the day the finale pick changes.
 *
 * Both callers must pass the SAME `mode` — see `queueEnvelope` — or they can reach opposite
 * answers and leave pick #1 with neither a hold nor an envelope.
 */
function willEnvelope(pick: number, mode: PlaybackKind): boolean {
  const reducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return envelopeEligible(pick, mode, document.visibilityState === 'hidden', reducedMotion);
}

/**
 * Queue the envelope behind the visual's own reveal moment — the machine's extraction FLIP and
 * the race's winning park must land on screen before the dim swallows them. Token-guarded: any
 * later reveal, phase change, or playback start silently retires a queued open.
 *
 * `mode` is the playback mode AS OF THE REVEAL, passed in rather than read here: the machine's
 * call sits behind the exit choreography's awaits, and a catch-up that drains inside that window
 * hands off to live (`playbackMode = null`) — which must not retroactively make the sprint's
 * final compressed reveal envelope-eligible.
 */
function queueEnvelope(
  reveal: LotteryReveal,
  hue: number | undefined,
  leadMs: number,
  mode: PlaybackKind,
): void {
  if (!willEnvelope(reveal.pick, mode)) return;
  const token = ++envelopeToken;
  envelopeTimer = window.setTimeout(() => openEnvelope(reveal.team, hue, token), leadMs);
}

/** The lead this visual gives its finale — the beat its own payoff needs before the dim. */
function envelopeLeadMs(): number {
  return ENVELOPE_LEAD_MS[activeVisual()];
}

/**
 * Reserve the screen for a finale that is about to play, so `renderFinish` holds the board back
 * (#243 live feedback). No-op for every reveal that is not getting one.
 *
 * The deadline is the whole ceremony's worst case: the machine's exit can stretch to the extraction
 * cap plus the FLIP, then the lead, then the overlay's own life. Race and wheel have no exit chain
 * — their lead already spans their payoff — so they budget the lead alone.
 */
function armFinale(pick: number, mode: PlaybackKind): void {
  if (!willEnvelope(pick, mode)) return;
  const exitMs = activeVisual() === 'machine' ? EXTRACT_CAP_MS + FLIP_MS : 0;
  finaleUntil = performance.now() + finaleHoldMs(envelopeLeadMs(), exitMs);
}

/** The face the drop ball currently wears, so a late-decoding logo can re-dress it (#242). */
let lastDropFace: { team: string; hue: number | undefined } | null = null;

/**
 * Dress the big drop ball (#242): the team's logo cover-fit over the hue face when we have it
 * (the gradient shows as a rim and behind transparent artwork), today's plain face otherwise.
 * The `#N` text stays either way — the ball number is the auditable link to the commitment.
 */
function applyDropFace(ball: HTMLElement, team: string, hue: number | undefined): void {
  lastDropFace = { team, hue };
  paintBallFace(ball, team, hue);
}

/**
 * Paint a ball element with a team's face — the logo when we have one, the hue gradient
 * underneath it either way. Shared by the drop ball and the tube ball (#258): the ball sliding
 * down the chute used to wear a bare hue gradient, so in logo mode (#252) the ball the pile
 * released visibly changed identity on its way to the one that lands.
 */
function paintBallFace(ball: HTMLElement, team: string, hue: number | undefined): void {
  const logo = teamLogo(team);
  const face = hue !== undefined ? ballFace(hue) : '';
  ball.style.background = logo
    ? `center / cover no-repeat url("${logo.src}")${face ? `, ${face}` : ''}`
    : face;
  ball.classList.toggle('logo-face', logo !== null);
}

/** Re-apply the current drop face — called when a logo decodes after the ball was painted. */
function redressDropBall(): void {
  if (!lastDropFace) return;
  const ball = document.getElementById('drop-pick');
  if (ball) applyDropFace(ball, lastDropFace.team, lastDropFace.hue);
}

export type Visual = 'machine' | 'race' | 'wheel';

/**
 * Per-viewer visual for a REPLAY only (#255), or null to watch it as it was broadcast.
 *
 * Live, the visual is fixed by `start` because a ceremony is one spectacle for one crowd (ADR
 * 0008). A replay re-renders published data on a local timer and decides nothing, so choosing your
 * own here costs the ceremony nothing — and lets a viewer see the same sealed draw as the machine,
 * the race and the wheel without the commissioner running it three times.
 */
let replayVisual: Visual | null = null;

/**
 * The ceremony's reveal visualization (#235), fixed by `start` so every viewer renders the same
 * spectacle. The lobby has no start yet — it always shows the machine's loaded hopper.
 *
 * The override applies only while a REPLAY is actually running: a catch-up is a live ceremony seen
 * late and must render as broadcast, and once the replay ends the screen belongs to the real one.
 */
function activeVisual(): Visual {
  if (replayVisual !== null && playbackMode === 'replay') return replayVisual;
  const visual = currentStart?.visual;
  return visual === 'race' || visual === 'wheel' ? visual : 'machine';
}

/** Swap the stage's left panel to match the active visual: hopper+chute, racetrack, or wheel. */
function applyStageLayout(): void {
  const visual = activeVisual();
  const racing = visual === 'race';
  const wheeling = visual === 'wheel';
  show('hopper', visual === 'machine');
  show('chute', visual === 'machine');
  show('racetrack', racing);
  show('wheel-canvas', wheeling);
  // The wide-page mode rides the same switch (#239): race mode takes the monitor's spare width
  // for the track. The wheel is a circle like the drum, so it gains nothing from the extra width
  // and keeps the cozy centered frame — same reasoning that left the machine out of it.
  document.body.classList.toggle('race', racing);
  if (wheeling) wheel().ensureSize();
  // `.race` is the SECOND input to --hopper-px — the wide rule is `body:not(.race)` — and toggling
  // a class fires no matchMedia event, so a race ending on a wide screen would otherwise leave the
  // drum stretched from 254 into a 334px box for the rest of the session (#267). The wheel counts
  // as "not racing" here: it leaves `.race` off, so the drum's box really is the wide one even
  // though the drum is hidden, and it has to be right before the machine is ever shown again.
  if (!racing) flushDrumResize(true);
  quiesceHiddenSims(visual);
}

/** The visual the stage is currently laid out for, so the swap below runs once per change. */
let laidVisual: Visual | null = null;

/**
 * Park whatever is no longer on screen (#235's rule, generalised for #255).
 *
 * The panels hide, but a canvas sim behind a hidden panel keeps its rAF loop: loose racers never
 * sleep, and the wheel spins until told not to. That was manageable while the visual was fixed for
 * the whole ceremony — now a replay can switch it mid-session, so the swap needs an owner.
 *
 * Guarded on a change rather than run on every call: `applyStageLayout` fires on every drum roll
 * and every reveal, and `raceSim.sync([], [])` rebuilds a field.
 */
function quiesceHiddenSims(visual: Visual): void {
  if (laidVisual === visual) return;
  laidVisual = visual;
  if (visual !== 'machine') hopperSim?.agitate(false);
  if (visual !== 'race') raceSim?.sync([], []);
  if (visual !== 'wheel') wheelSim?.spin(false);
}

// Ceremony sound (#216) — silent until the viewer arms it; the callback keeps the 🔊 pill honest
// even when the stored preference re-arms audio from a page interaction rather than the button.
const audio = createCeremonyAudio((enabled) => {
  const btn = byId('sound-btn');
  btn.textContent = enabled ? '🔊' : '🔇';
  btn.classList.toggle('on', enabled);
  btn.title = enabled ? 'Sound is on — click to mute' : 'Sound is off — click to enable';
});
/** Beat pick the roll is playing for — poll repaints of the same beat must not restart it. */
let rolledPick: number | null = null;

/**
 * The odds table + the visual's field, shared by the lobby (#198) and the committed waiting room.
 * `drawn` carries pick+team pairs: the machine only needs the team names, but the race parks a
 * racer at the position its pick earned (#235).
 */
function renderOddsTable(
  oddsRows: LotteryOddsRow[],
  drawn: { pick: number; team: string }[] = [],
  editable = false,
): void {
  const rows = byId('odds-rows');
  // A repaint mid-rename must not eat the commissioner's typing (#227): capture the focused
  // editor's state before the rebuild destroys it, and hand it to the matching new row.
  const draft = captureRenameDraft();
  clear(rows);
  ensureLogos(oddsRows);
  const ranges = assignBallRanges(oddsRows);
  const maxBalls = Math.max(...oddsRows.map((r) => r.balls), 1);
  for (let i = 0; i < oddsRows.length; i += 1) {
    const row = oddsRows[i];
    const tr = el('tr');
    const teamCell = el('td');
    // Swatch matches the team's ball color in the hopper, so "watch your balls" actually works.
    const dot = el('span', 'swatch');
    dot.style.background = `hsl(${ranges[i].hue} 60% 62%)`;
    teamCell.appendChild(dot);
    // Team avatar (#242) beside the swatch once its image has actually decoded — a broken img
    // icon would be worse than no avatar, so unloaded/failed logos simply render today's look.
    const logo = row.teamId !== undefined ? logoImages.get(row.teamId)?.img : undefined;
    if (logo instanceof HTMLImageElement && logo.complete && logo.naturalWidth > 0) {
      const avatar = el('img', 'avatar') as HTMLImageElement;
      avatar.src = logo.src;
      avatar.alt = '';
      teamCell.appendChild(avatar);
    }
    teamCell.appendChild(
      editable && row.teamId !== undefined
        ? renameTarget(row, draft ?? undefined)
        : document.createTextNode(row.team),
    );
    tr.appendChild(teamCell);
    const ballsCell =
      editable && row.teamId !== undefined ? stepperCell(row) : el('td', 'num', String(row.balls));
    // The bag range ("#5–7") makes the numbers on the balls mean something checkable.
    const label = rangeLabel(ranges[i]);
    if (label) ballsCell.appendChild(el('span', 'brange', label));
    tr.appendChild(ballsCell);
    const barCell = el('td');
    const bar = el('span', 'ballbar');
    bar.style.width = `${Math.max(8, Math.round((row.balls / maxBalls) * 90))}px`;
    barCell.appendChild(bar);
    tr.appendChild(barCell);
    tr.appendChild(el('td', 'num', `${row.firstPct.toFixed(1)}%`));
    tr.appendChild(el('td', 'num', `${row.top3Pct.toFixed(1)}%`));
    rows.appendChild(tr);
  }
  if (activeVisual() === 'wheel') {
    // Wedge width is ball count, so the wheel and the table beside it say the same thing.
    wheel().sync(
      oddsRows,
      drawn.map((entry) => entry.team),
    );
    hopperSim?.sync([], []);
  } else if (activeVisual() === 'race') {
    race().sync(oddsRows, drawn);
    // Don't leave the machine simulating behind a hidden panel — but never *create* it for this.
    hopperSim?.sync([], []);
  } else {
    hopper().sync(
      oddsRows,
      drawn.map((entry) => entry.team),
    );
    raceSim?.sync([], []);
    wheelSim?.spin(false); // loose animation must not run behind a hidden stage (#235)
  }
}

// --- commissioner editing (#210): only ever offered on a pre-commitment lobby ---

/**
 * Lower bound is structural (a team with no balls could never be drawn). The upper bound is
 * injected by the page shell from core's `MAX_TEAM_BALLS` (#219) rather than hand-copied — core
 * reaches `node:crypto`, so this bundle cannot import it, and a second literal would drift the
 * moment the cap changed. The backend re-checks either way; this only stops silly requests.
 */
const MIN_EDIT_BALLS = 1;
const MAX_EDIT_BALLS = configuredMaxTeamBalls();

/** The bearer the backend re-verifies with Discord. Null outside the Activity (dev/standalone). */
let accessToken: string | null = null;
/** Answered by `GET /api/lottery/me`; false until proven otherwise, so the UI never guesses. */
let commissioner = false;
/** Team ids with an edit in flight — their steppers stay disabled until the WS echo lands. */
const editsInFlight = new Set<string>();
/** Server-truth "an ESPN re-import is pending" (#227) — drives the re-import button's state. */
let reimportPending = false;
/**
 * How long a pending re-import may sit before this client says the bot may not be listening
 * (#250). Generous on purpose: a real refetch is two ESPN round-trips plus a card render plus
 * the logo prefetch, and calling a slow import "offline" would be worse than saying nothing.
 */
const REIMPORT_NO_RESPONSE_MS = 25_000;
/**
 * Which press we are watching — the server's stamp, used purely as an identity token (#250).
 * It is never subtracted from a local `Date.now()`: a phone and the host machine can disagree by
 * minutes, and a skewed subtraction would either cry "offline" instantly or never at all. The
 * elapsed measurement is the local timer below, started when THIS client first saw this token —
 * so a late joiner under-reports the wait, which is the safe direction (it never accuses a bot
 * that is working).
 */
let reimportStamp: number | undefined;
/** True once the pending press has outlived {@link REIMPORT_NO_RESPONSE_MS} on this client. */
let reimportStale = false;
/** Why the last press was refused (#250) — one-shot, cleared by the next press or a re-arm. */
let reimportDenied: string | undefined;
/** The one-shot timer that flips {@link reimportStale} without waiting for a broadcast. */
let reimportStaleTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Track the pending-refetch press across repaints (#250). The stamp is an identity token, so a
 * re-press (new stamp) restarts the local clock and clears a previous refusal, while repeated
 * snapshots carrying the same stamp leave the elapsed measurement alone.
 */
function trackReimportPress(stamp: number | undefined, denied: string | undefined): void {
  reimportDenied = denied;
  if (stamp === undefined) {
    reimportStamp = undefined;
    reimportStale = false;
    if (reimportStaleTimer !== undefined) clearTimeout(reimportStaleTimer);
    reimportStaleTimer = undefined;
    return;
  }
  if (stamp === reimportStamp) return;
  reimportStamp = stamp;
  reimportStale = false;
  if (reimportStaleTimer !== undefined) clearTimeout(reimportStaleTimer);
  // Not the #227 anti-pattern: this timer never *infers* that the import finished — only the
  // broadcast does that. It just stops the page claiming work is in flight when nothing has
  // answered, and hands the button back so a retry is possible.
  reimportStaleTimer = setTimeout(() => {
    reimportStaleTimer = undefined;
    // Both guards matter: the stamp may have moved on (a retry, or the press being answered),
    // and the lobby may be gone entirely — leaving the phase clears the tracker, so `currentLobby`
    // absent means there is no lobby left to paint this onto.
    if (reimportStamp !== stamp || !currentLobby) return;
    reimportStale = true;
    renderLobby(currentLobby);
    paintLobbyStatus();
  }, REIMPORT_NO_RESPONSE_MS);
}

/**
 * The lobby's status pill. Re-import feedback outranks the resting line (#250): a refusal, or a
 * press nothing has answered, is the one thing on this screen the commissioner must act on.
 */
function paintLobbyStatus(): void {
  // Printed verbatim: the bot writes a complete sentence because not every release is a failure
  // — the "import landed but the lobby couldn't be re-armed" path would be a lie under a
  // hardcoded "failed" prefix (#250 review).
  if (reimportDenied) setStatus(reimportDenied, 'err');
  else if (reimportPending && reimportStale) {
    setStatus('re-import: no response from the bot — is it running?', 'err');
  } else if (reimportPending) setStatus('re-importing from ESPN…', 'live');
  else {
    setStatus(
      beginPending ? 'sealing the bag — draw starting…' : 'setup complete — draw pending',
      'live',
    );
  }
}
/** Server-truth "a seal-and-start is pending" (#233) — same broadcast-driven discipline. */
let beginPending = false;
/** Server-truth audit chatter mode (#252) — the select reflects this, never the reverse. */
let auditModeCurrent: 'live' | 'seal-only' = 'live';
/** The guild this Activity instance lives in (#253), from the SDK; null outside Discord. */
let activityGuildId: string | null = null;
/** Server-truth "a setup press is pending" (#253) — the start button's disabled lifetime. */
let setupPending = false;

/**
 * Press the "start a lottery" doorbell (#253). Anyone can press; the BOT verifies Manage Server
 * in this guild before honouring it, and a refusal comes back as `setupDenied` on the broadcast.
 * No timer, no optimistic paint — the pending flag rides the snapshot like every other request.
 */
async function sendSetupRequest(): Promise<void> {
  if (!activityGuildId) {
    setStatus('open this inside your Discord server to start a lottery', 'err');
    return;
  }
  const season = Number((byId('setup-season') as HTMLInputElement).value);
  if (!Number.isInteger(season) || season < 2020 || season > 2100) {
    setStatus('season needs to be a four-digit year', 'err');
    return;
  }
  const button = byId('setup-btn') as HTMLButtonElement;
  button.disabled = true;
  setStatus('asking the bot to set up…', 'live');
  const accepted = await commissionerPost(
    '/api/lottery/setup-request',
    { guildId: activityGuildId, season },
    (status) => (status === 409 ? 'someone already pressed start' : 'start rejected'),
  );
  if (!accepted) button.disabled = false;
}

/**
 * A `Balls` cell with −/+ steppers. One edit per row at a time: the buttons disable on click and
 * come back when the recomputed lobby is broadcast back to us. Waiting for the echo instead of
 * painting optimistically means the number on screen is always a number the server agreed to —
 * which matters more here than snappiness, since this table is the published odds.
 */
function stepperCell(row: LotteryOddsRow): HTMLElement {
  const teamId = row.teamId as string;
  const cell = el('td', 'num edit');
  const busy = editsInFlight.has(teamId);
  const step = (delta: number): HTMLElement => {
    const target = row.balls + delta;
    const button = el('button', 'step', delta < 0 ? '−' : '+') as HTMLButtonElement;
    button.type = 'button';
    button.disabled = busy || target < MIN_EDIT_BALLS || target > MAX_EDIT_BALLS;
    button.setAttribute(
      'aria-label',
      `${delta < 0 ? 'Remove a ball from' : 'Add a ball to'} ${row.team}`,
    );
    button.addEventListener('click', () => void sendAdjust(teamId, target));
    return button;
  };
  cell.appendChild(step(-1));
  cell.appendChild(el('span', 'stepval', String(row.balls)));
  cell.appendChild(step(+1));
  return cell;
}

/**
 * Push one ball edit. The response body carries the fresh snapshot, but we deliberately let the
 * WebSocket broadcast repaint instead — that way the commissioner sees exactly what everyone else
 * sees, and a divergence between the two would be visible rather than hidden by a local paint.
 */
async function sendAdjust(teamId: string, balls: number): Promise<void> {
  if (editsInFlight.has(teamId) || !accessToken) return;
  editsInFlight.add(teamId);
  repaintLobbyEdits();
  try {
    const res = await fetch(apiPath(activityBase, '/api/lottery/adjust'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ teamId, balls }),
    });
    if (!res.ok) {
      // A 403/409 here means the ceremony moved on (committed, or someone else re-ran setup).
      // Say so rather than leaving a dead-looking button.
      setStatus(res.status === 409 ? 'the bag is sealed — edits closed' : 'edit rejected', 'err');
    }
  } catch {
    setStatus('edit failed — backend offline', 'err');
  } finally {
    editsInFlight.delete(teamId);
    repaintLobbyEdits();
  }
}

/** Longest name the backend accepts; keeping the input in step avoids a pointless round-trip. */
const MAX_NAME_LENGTH = 40;

/** An uncommitted rename captured off a focused input the instant before a repaint destroys it. */
interface RenameDraft {
  teamId: string;
  value: string;
  selStart: number | null;
  selEnd: number | null;
}

/**
 * If the element being repainted away is a focused rename input, capture what the commissioner
 * had typed (and where their caret was) so the rebuilt row can pick up mid-keystroke (#227). Only
 * another actor's lobby change can trigger this — in practice the bot's mini-game re-arm — but
 * losing typed text to a background broadcast is the kind of glitch that erodes trust in the UI.
 */
function captureRenameDraft(): RenameDraft | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement) || !active.classList.contains('rename')) return null;
  const teamId = active.dataset.teamId;
  if (!teamId) return null;
  return {
    teamId,
    value: active.value,
    selStart: active.selectionStart,
    selEnd: active.selectionEnd,
  };
}

/**
 * The team name as a click-to-edit target. Committing on Enter or blur and reverting on Escape is
 * the least surprising behaviour for a field that is really a one-off correction, and it avoids a
 * per-keystroke request against a name the server would have to validate for uniqueness anyway.
 *
 * `restore` re-opens the editor mid-keystroke after a repaint (#227): deferred a microtask so the
 * label is in the rebuilt DOM before `replaceWith` swaps it (a detached label can't be replaced).
 */
function renameTarget(row: LotteryOddsRow, restore?: RenameDraft): HTMLElement {
  const teamId = row.teamId as string;
  const label = el('span', 'teamname editable', row.team);
  label.setAttribute('role', 'button');
  label.setAttribute('tabindex', '0');
  label.setAttribute('title', 'Rename this team');
  const open = (draft?: RenameDraft): void => {
    const input = el('input', 'rename') as HTMLInputElement;
    input.value = draft ? draft.value : row.team;
    input.maxLength = MAX_NAME_LENGTH;
    input.dataset.teamId = teamId; // lets a repaint recognise and preserve this editor
    input.setAttribute('aria-label', `Rename ${row.team}`);
    let settled = false;
    const commit = (send: boolean): void => {
      if (settled) return;
      settled = true;
      const next = input.value.trim();
      input.replaceWith(label);
      if (send && next && next !== row.team) void sendRename(teamId, next);
    };
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') commit(true);
      else if (event.key === 'Escape') commit(false);
    });
    input.addEventListener('blur', () => commit(true));
    label.replaceWith(input);
    input.focus();
    if (draft) input.setSelectionRange(draft.selStart, draft.selEnd);
    else input.select();
  };
  label.addEventListener('click', () => open());
  label.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
  if (restore && restore.teamId === teamId) {
    queueMicrotask(() => open(restore));
  }
  return label;
}

/** Push a display-name fix. Same wait-for-the-echo discipline as {@link sendAdjust}. */
async function sendRename(teamId: string, displayName: string): Promise<void> {
  await commissionerPost('/api/lottery/rename', { teamId, displayName }, (status) =>
    status === 409 ? 'that name is already taken' : 'rename rejected',
  );
}

/**
 * Ask the bot to refetch the league from ESPN (#219). The api cannot do it, so this only raises a
 * request; the bot performs the import, posts a fresh odds card in the channel, and re-arms the
 * lobby — which is what repaints this page.
 */
async function sendReimport(): Promise<void> {
  const button = byId('reimport-btn') as HTMLButtonElement;
  button.disabled = true;
  setStatus('re-importing from ESPN…', 'live');
  const accepted = await commissionerPost('/api/lottery/reimport', {}, () => 're-import rejected');
  // The button tracks the broadcast flag through `renderLobby` (#227), not a timer, so an
  // accepted request stays disabled for exactly as long as the stage says work is pending —
  // until the bot's re-arm clears it, it releases the press with a reason, or this client
  // decides nothing ever answered (#250). Only a rejected/failed POST re-enables here, since
  // no broadcast will; the pill would otherwise keep claiming an import is running.
  // Deliberately no repaint here: `commissionerPost` has already put the rejection reason in the
  // pill, and the resting line would bury the one thing the commissioner needs to read.
  if (!accepted) button.disabled = false;
}

/**
 * Ask the bot to seal the bag and start the draw (#233). Like re-import, the api cannot do it —
 * the POST records a request the bot's stage watcher honours by running the identical flow as
 * `/canon draftorder begin`: drain edits, fresh odds card, commitment in-channel, paced reveal.
 * No timer (#227): an accepted request broadcasts `beginRequested`, which disables the button for
 * every commissioner until the draw's `start` replaces the lobby (or a re-arm voids the press).
 */
async function sendBegin(): Promise<void> {
  const button = byId('begin-btn') as HTMLButtonElement;
  const delaySeconds = Number((byId('begin-delay') as HTMLSelectElement).value);
  const direction = (byId('begin-direction') as HTMLSelectElement).value;
  const visual = (byId('begin-visual') as HTMLSelectElement).value;
  const ballFaces = (byId('begin-faces') as HTMLSelectElement).value;
  button.disabled = true;
  setStatus('sealing the bag…', 'live');
  const accepted = await commissionerPost(
    '/api/lottery/begin',
    { delaySeconds, direction, visual, ballFaces },
    // 409 now covers two cases: the lobby moved under the press, or a re-import is still
    // pending (#250 made those mutually exclusive). Naming both beats asserting the wrong one.
    (status) =>
      status === 409
        ? 'begin rejected — the lobby changed, or a re-import is still running'
        : 'begin rejected',
  );
  if (!accepted) button.disabled = false;
}

/**
 * Level every team to the same ball count (#252) — one authorized write, one recompute, one
 * broadcast repaint. No optimistic paint: the table updates when the echo lands, same as the
 * steppers.
 */
async function sendBulk(): Promise<void> {
  const button = byId('bulk-btn') as HTMLButtonElement;
  const input = byId('bulk-balls') as HTMLInputElement;
  const balls = Number(input.value);
  const cap = MAX_EDIT_BALLS;
  if (!Number.isInteger(balls) || balls < 1 || balls > cap) {
    setStatus(`balls must be a whole number from 1 to ${cap}`, 'err');
    return;
  }
  button.disabled = true;
  const accepted = await commissionerPost(
    '/api/lottery/adjust-all',
    { balls },
    () => 'level-all rejected',
  );
  if (accepted) setStatus(`every team set to ${balls} ball${balls === 1 ? '' : 's'}`, 'live');
  button.disabled = false;
}

/** Flip the audit chatter preference (#252); the select reflects the broadcast echo. */
async function sendAuditMode(): Promise<void> {
  const select = byId('audit-mode') as HTMLSelectElement;
  const mode = select.value;
  select.disabled = true;
  const accepted = await commissionerPost(
    '/api/lottery/audit-mode',
    { mode },
    () => 'setting rejected',
  );
  // A rejected flip snaps the select back to server truth rather than lying about the mode.
  if (!accepted) select.value = auditModeCurrent;
  select.disabled = false;
}

/** Shared POST plumbing for the commissioner routes: bearer, error surfacing, no optimistic paint. */
async function commissionerPost(
  route: string,
  body: Record<string, unknown>,
  describe: (status: number) => string,
): Promise<boolean> {
  if (!accessToken) return false;
  try {
    const res = await fetch(apiPath(activityBase, route), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      setStatus(describe(res.status), 'err');
      return false;
    }
    return true;
  } catch {
    setStatus('edit failed — backend offline', 'err');
    return false;
  }
}

/** Re-render the odds table in place so disabled/enabled steppers reflect what's in flight. */
function repaintLobbyEdits(): void {
  if (currentLobby) renderOddsTable(currentLobby.rows, [], commissioner && !beginPending);
}

/** The lobby currently on screen, kept so an in-flight change can repaint without a refetch. */
let currentLobby: LotteryLobby | undefined;

/** The transport base (`/.proxy` inside Discord), captured at boot for the adjust POST. */
let activityBase = '';

/** In-flight/settled commissioner check, so a repainting lobby doesn't re-ask on every event. */
let commissionerCheck: Promise<void> | null = null;
/** Last lobby arm we checked commissioner-ship against — a new arm re-asks (#232). */
let seenArmedSeq: number | undefined;

/**
 * Ask the backend whether *this* member may edit. Authoritative — the client can't derive it,
 * since the commissioner list never leaves the server. A failure just leaves the machine
 * read-only, which is the correct fallback for everyone but one person.
 */
/**
 * Human-readable failure text (#231). The Embedded App SDK rejects with plain `{code, message}`
 * objects, not Errors — `String(error)` renders those as "[object Object]", which is exactly the
 * observability hole that turned a one-field portal misconfiguration into a multi-hour hunt.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error, Object.getOwnPropertyNames(Object(error))).slice(0, 200);
  } catch {
    return String(error);
  }
}

/**
 * Ask the backend whether this member may edit. Returns the answer instead of mutating shared
 * state, so callers can discard a result that resolved out of order — two checks can be in
 * flight when arms come quickly, and the older answer must never overwrite the newer lobby's.
 * `null` means the check could not complete (network, non-2xx): the caller fails closed for the
 * moment but leaves the latch open so a later repaint retries — a definite "no" latches, a blip
 * must not strand a real commissioner read-only until the next re-arm.
 */
async function fetchCommissioner(): Promise<boolean | null> {
  if (!accessToken) return null;
  try {
    const res = await fetch(apiPath(activityBase, '/api/lottery/me'), {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return ((await res.json()) as { commissioner?: boolean }).commissioner === true;
  } catch (error) {
    console.error('[lottery] commissioner check failed', error);
    return null;
  }
}

/**
 * Pre-commitment lobby (#198): odds visible before the draw begins. Shows a placeholder in the
 * commit slot instead of the hash (which doesn't exist yet). For the commissioner (#210) the
 * `Balls` column becomes editable — the only mutable surface in the whole machine.
 */
function renderLobby(lobby: LotteryLobby): void {
  currentLobby = lobby;
  byId('title').textContent = lobby.title;
  byId('waiting-sub').textContent =
    `${lobby.teamCount} teams · ${lobby.totalBalls} balls in the hopper`;
  byId('commit').textContent = beginPending
    ? 'Sealing the bag — the commitment posts in the channel, then the draw begins…'
    : 'Commissioner will begin the draw soon…';
  // A pending seal freezes the whole lobby server-side (#233) — render the table read-only too,
  // so the steppers don't offer writes the stage is going to 409.
  renderOddsTable(lobby.rows, [], commissioner && !beginPending);
  show('edit-hint', !beginPending);
  // The whole panel (#252) shows only to the commissioner — re-import still only makes sense for
  // an ESPN-backed ceremony, but the client can't tell; the bot refuses a manual setup and says so.
  show('commish-panel', commissioner);
  // The buttons follow the broadcast, not a timer (#227): each flag is set the moment its request
  // is accepted and cleared when the bot's re-arm or `start` replaces the lobby — the exact
  // lifetime of "that work is actually pending". Every viewer's snapshot agrees, so late joiners
  // see the true state too. The two block each other (#233): a re-import replaces the very bag a
  // seal would commit, and a seal makes a refetch moot.
  const frozen = beginPending || reimportPending;
  // A press nothing has answered for a while hands back ONLY its own button (#250): the flag is
  // proof the api heard the press, never proof the BOT did, and the live incident was exactly
  // that gap — a retry is the honest recovery. The rest of the lobby stays frozen on server
  // truth, because the bot may simply be slow, and a `begin` recorded while the stage still
  // holds `reimportRequested` is suppressed watcher-side with nothing to release it.
  (byId('reimport-btn') as HTMLButtonElement).disabled = frozen && !reimportStale;
  (byId('begin-btn') as HTMLButtonElement).disabled = frozen;
  (byId('begin-delay') as HTMLSelectElement).disabled = beginPending;
  (byId('begin-direction') as HTMLSelectElement).disabled = beginPending;
  (byId('begin-visual') as HTMLSelectElement).disabled = beginPending;
  (byId('begin-faces') as HTMLSelectElement).disabled = beginPending;
  (byId('bulk-balls') as HTMLInputElement).disabled = frozen;
  (byId('bulk-btn') as HTMLButtonElement).disabled = frozen;
  const auditSelect = byId('audit-mode') as HTMLSelectElement;
  auditSelect.disabled = frozen;
  // Server truth wins over whatever the select was left showing — a late joiner or a second
  // commissioner device must see the mode the stage actually holds.
  auditSelect.value = auditModeCurrent;
  // The answer is lobby-scoped server-side, and commissioner-ship is stamped fresh at every arm —
  // so re-ask whenever a *newly armed* lobby appears (`armedSeq` bumps per arm, not per edit
  // echo, #232), not just once per page. The once-per-page latch left an open Activity holding a
  // stale "no" through a re-setup: the commissioner had to fully close and rejoin to be
  // recognised — rediscovered live, at cost, on 2026-08-01. A same-answer re-ask repaints
  // nothing, so the common re-arm (same commissioner) doesn't flicker.
  const rearmed = lobby.armedSeq !== undefined && lobby.armedSeq !== seenArmedSeq;
  if (rearmed) seenArmedSeq = lobby.armedSeq;
  if (accessToken && (rearmed || (!commissioner && !commissionerCheck))) {
    const seqAtAsk = lobby.armedSeq;
    commissionerCheck = fetchCommissioner().then((answer) => {
      // Bind the answer to the arm it was asked about: a newer arm may have its own check in
      // flight, and this (now stale) result must neither grant nor revoke against that lobby.
      if (currentLobby?.armedSeq !== seqAtAsk) return;
      const next = answer === true; // fail closed while indeterminate
      if (next !== commissioner) {
        commissioner = next;
        if (currentLobby) renderLobby(currentLobby);
      }
      // An indeterminate check leaves the latch open so the next repaint retries; a definite
      // answer latches (viewers' clients must not re-ask /me on every edit echo).
      if (answer === null) commissionerCheck = null;
    });
  }
}

/** The last ball-face mode the hopper was built/refaced under (#252), so a change is one-shot. */
let facesApplied: string | undefined;

function renderWaiting(start: LotteryStart, drawn: { pick: number; team: string }[] = []): void {
  currentStart = start; // remembered for pull scheduling (delayMs) across later phases
  // A face-mode change (#252): the lobby built a numbered pile, and the hopper's `sync`
  // deliberately short-circuits on an unchanged bag — so the moment the committed start declares
  // its mode, reface in place. Guarded so the per-reveal repaints don't rebuild 78 sprites each.
  const faces = start.ballFaces ?? 'numbers';
  if (faces !== facesApplied) {
    facesApplied = faces;
    hopperSim?.reface();
  }
  // The commitment binds the bag: past this point nothing on screen is editable, so drop the
  // lobby we were holding and retract the offer (#210) — the seal controls with it (#233), or a
  // slash-started draw would leave a live-looking begin button on the waiting screen.
  currentLobby = undefined;
  show('edit-hint', false);
  show('commish-panel', false);
  byId('title').textContent = start.title;
  byId('waiting-sub').textContent =
    `${start.teamCount} teams · ${start.totalBalls} balls in the hopper`;
  byId('commit').textContent = `commitment ${start.commitment.slice(0, 16)}…`;
  renderOddsTable(start.rows, drawn);
}

// --- the exit (#215): the drawn ball leaves the drum through the chute when the reveal lands ---
//
// This retires #195's pre-reveal anonymous pull. The client cannot know the winner before the
// reveal event — publishing it earlier (even encoded) would leak the pick — so a *specific* ball
// can only start moving once the reveal is public. The drum-roll's tension cue is now the chute
// glow; the payoff is real: the actual numbered ball (the same `drawnBallFor` derivation every
// viewer shows) swims out of the pile, slides the tube, and lands as the drop ball.

/** Chute-glow lead before the reveal is due — the drum-roll's "something's coming" cue. */
const CHUTE_GLOW_LEAD_MS = 1150;
/** The face the hold currently wears, so a late-decoding logo can repaint it (#242's rule). */
let holdFace: { team: string; hue: number | undefined } | null = null;
/** Diameter of the ball sliding the chute — must match `#tube-ball` in the page CSS (#258). */
function tubeBallPx(): number {
  return cssPx('--tube-ball-px', 18);
}
let chuteTimer: ReturnType<typeof setTimeout> | null = null;
/** Beat pick the glow is armed for — poll repaints of the same beat must not restart it. */
let armedPick: number | null = null;
/** Last reveal actually animated — repeat paints of the same reveal only refresh text. */
let lastDropPick: number | null = null;
// The live pacing, kept for scheduling the chute glow against the beat window.
let currentStart: LotteryStart | undefined;
/** Monotonic token — anything that supersedes a running exit choreography bumps it. */
let choreoToken = 0;
/** Pick whose exit is mid-flight, so a poll repaint doesn't reveal the drop ball early. */
let exitInFlight: number | null = null;

function armChute(pick: number, windowMs: number): void {
  if (armedPick === pick) return;
  // Glow only — a new drum-roll must NOT abort the previous reveal's exit flight. The live bot
  // posts the next beat almost immediately after a reveal, so the flight (~1s) routinely outlives
  // the reveal's own screen time; killing it here would strip the choreography from every
  // non-final pick at live pace. The flight lands into the drop on its own, and the drop then
  // stays up through the next drum-roll — the previous result keeps its moment.
  resetGlow();
  armedPick = pick;
  const lead = Math.max(0, windowMs - CHUTE_GLOW_LEAD_MS);
  chuteTimer = setTimeout(() => byId('chute').classList.add('active'), lead);
}

/** Retire the glow timer + light. Safe under a flight — the flight re-lights what it needs. */
function resetGlow(): void {
  if (chuteTimer) {
    clearTimeout(chuteTimer);
    chuteTimer = null;
  }
  armedPick = null;
  byId('chute').classList.remove('active');
}

/**
 * Tear down glow AND any exit in flight. For paths where the flight itself is stale news: abort,
 * phase wipe, finish, playback transitions. A newer reveal doesn't need this — starting its own
 * choreography supersedes the old one via the token.
 */
function resetChute(): void {
  choreoToken += 1;
  exitInFlight = null;
  resetGlow();
  const tube = byId('tube-ball');
  tube.classList.remove('transit', 'logo-face');
  tube.style.background = '';
  hideHold();
}

/** Swap a node for a bare clone — the only way to retrigger its CSS animations. */
function replaceNode(id: string): HTMLElement {
  const old = byId(id);
  const fresh = old.cloneNode(false) as HTMLElement;
  old.replaceWith(fresh);
  return fresh;
}

/**
 * Where the drop ball's FLIP starts, in viewport coordinates (#258) — and at what diameter (#265).
 *
 * The size travels with the position because the two anchors are no longer the same ball: a plain
 * exit hands off from the 18px chute ball, a held one from the 56px ball at the mouth. Scaling
 * both from the chute ball's diameter would shrink the held ball ~3x in the single frame between
 * `hideHold` and the spring — a pop at precisely the handoff this choreography exists to smooth.
 */
interface FlipAnchor {
  cx: number;
  cy: number;
  px: number;
}

/**
 * FLIP handoff: the drop ball starts at the chute exit (where the pulled ball just arrived) and
 * springs to its resting spot — the pull and the reveal read as one continuous motion.
 *
 * Returns a promise that settles when the spring is **done**, timed from the frame the transition
 * actually starts on rather than from the call (#269). The two rAFs below are the reason that
 * distinction matters: a caller starting its own FLIP_MS timer here finishes a couple of frames
 * early, which is enough for the finale's dim to begin over a ball still in motion.
 *
 * Always settles. rAF does not run in a hidden tab, and a promise that never resolves would strand
 * the envelope — and anything else chained off the exit — for the life of the page.
 */
function flipFromChute(ball: HTMLElement, from: FlipAnchor): Promise<void> {
  // The clone carries the previous reveal's flip/fall classes — strip them so the start
  // transform below is applied instantly, by intent rather than by insertion semantics.
  ball.classList.remove('flip', 'fall');
  const to = ball.getBoundingClientRect();
  if (!to.width || !Number.isFinite(from.cx) || !Number.isFinite(from.cy)) {
    ball.classList.add('fall'); // measurement failed — fall back to the plain drop-in
    return Promise.resolve(); // nothing springs, so there is nothing to wait out
  }
  const dx = from.cx - (to.left + to.width / 2);
  const dy = from.cy - (to.top + to.height / 2);
  // Scale follows the real diameter of whatever the ball is handed off FROM (#258/#265) rather
  // than the old hardcoded `.14`, which was tuned when the chute ball was 14px.
  const scale = Math.min(1, from.px / to.width);
  ball.style.transform = `translate(${dx}px, ${dy}px) scale(${scale.toFixed(3)})`;
  // The spring's length is the planner's FLIP_MS, not a number typed into the stylesheet — the
  // budget is only honest while the phase it bills actually lasts that long.
  ball.style.setProperty('--flip-ms', `${FLIP_MS}ms`);
  return new Promise<void>((resolve) => {
    // The frames never come in a hidden tab; settle on the nominal length rather than hang.
    const unpainted = setTimeout(resolve, FLIP_MS);
    // Double rAF: the start transform must paint before the transition begins.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        ball.classList.add('flip');
        ball.style.transform = '';
        clearTimeout(unpainted);
        setTimeout(resolve, FLIP_MS); // the spring starts NOW, so time it from here
      });
    });
  });
}

function renderDrum(pick: number, remaining: string[], windowMs?: number): void {
  show('waiting', false);
  show('stage', true);
  // The last pick's card deliberately STAYS through this roll (live feedback: "it should stay for
  // a couple seconds, its kinda quick"). It used to be hidden here, which had two consequences:
  // the bot posts the next beat immediately after each reveal, so a card that took ~1.6s of exit
  // choreography to arrive was wiped almost at once — and the 2s poll re-ran this on every tick,
  // so even the surviving window kept getting cut. `renderDrop` hides it when the NEXT ball
  // actually starts coming out, which is the moment it stops being the current result.
  byId('drum').classList.remove('hidden');
  applyStageLayout();
  byId('drum-now').textContent = `Drawing pick #${pick}…`;
  // Between reveals: the safest moment to apply a crossing the sim refused mid-flight, and the
  // path that catches the ones the choreography's early returns would otherwise have dropped.
  flushDrumResize();
  const win = windowMs ?? currentStart?.delayMs ?? 4000;
  if (activeVisual() === 'wheel') {
    // The wheel's drum roll is simply the spin — it free-runs until the reveal names a wedge.
    wheel().spin(true);
  } else if (activeVisual() === 'race') {
    // The race's drum roll: the field bunches and breaks harder (#235). No chute to glow.
    race().agitate(true);
  } else {
    byId('hopper').classList.add('spinning');
    hopper().agitate(true); // the boil (#211); .spinning still shakes the container
    armChute(pick, win);
  }
  // The roll spans the same window the chute glow is scheduled against; a poll repaint of the
  // same beat must not restart the crescendo (same dedupe rule as `armChute`).
  if (rolledPick !== pick) {
    rolledPick = pick;
    audio.drumRoll(win);
  }
  const chips = byId('drum-remaining');
  clear(chips);
  for (const team of remaining) chips.appendChild(el('span', 'chip', team));
}

/** The drawn ball's face on DOM elements (tube ball, drop ball) — matches the pile's sprites. */
function ballFace(hue: number): string {
  return `radial-gradient(circle at 32% 28%, #fff 0%, hsl(${hue} 65% 68%) 32%, hsl(${hue} 55% 38%) 100%)`;
}

/**
 * The exit (#215): steer the drawn ball out of the pile, slide it down the tube, then land it as
 * the drop ball. Strictly cosmetic and strictly bounded — every await is capped, any superseding
 * state change (a newer reveal, an abort, a repaint from scratch) bumps `choreoToken` and the
 * stale run stops touching the DOM. The board/headline were already updated by `renderDrop`; only
 * the drop ball itself waits for the flight.
 */
async function runExitChoreography(
  reveal: LotteryReveal,
  num: number | null,
  hue: number | undefined,
  oddsText: string,
  /**
   * The playback mode AS OF THE REVEAL, passed in for the same reason `queueEnvelope` takes it:
   * this function reads it from behind its awaits, by which point a catch-up may have drained and
   * flipped the global to live. Reading it live here made the hold and the envelope disagree —
   * the choreography would suppress the hold believing an envelope was coming, and `queueEnvelope`
   * would then decline to open one, leaving pick #1 with neither.
   */
  mode: PlaybackKind,
): Promise<boolean> {
  const token = ++choreoToken;
  exitInFlight = reveal.pick;
  // Whatever the run we just superseded left at the mouth is the PREVIOUS pick's ball. Its own
  // cleanup only happens when its hold timer wakes, which is up to a full hold too late — by then
  // the headline, chips and board all read pick N+1 with pick N's logo still held up beside them.
  hideHold();
  // What actually fits before the next event supersedes this one (#265). Everything below reads
  // from the plan rather than from constants, so the chain can never outlast its own gap.
  const gapMs = revealGapMs(reveal);
  const planned = exitBudget(gapMs);
  const startedAt = performance.now();
  // Glow through the exit even when the reveal outran the glow's lead timer.
  byId('chute').classList.add('active');
  // The extraction resolves from the sim's rAF loop — which never runs in a hidden tab. The race
  // keeps the reveal bounded regardless: setTimeout fires even hidden (clamped, but it fires), so
  // a backgrounded viewer still has the correct drop state waiting when they return.
  const flew =
    num !== null && planned.mode !== 'skip'
      ? await Promise.race([
          hopper().extractBall(num),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), EXTRACT_CAP_MS)),
        ])
      : false;
  if (token !== choreoToken) {
    hideHold();
    return false; // superseded: this run no longer owns the screen
  }
  // Re-plan against what the extraction ACTUALLY cost. It is the one phase whose length this side
  // cannot dictate — a throttled tab can spend the whole EXTRACT_CAP_MS in there — and spending a
  // hold out of a budget that was already blown is how the drop card gets wiped mid-spring.
  const budget = flew ? exitBudget(gapMs, performance.now() - startedAt) : planned;
  // Whether the ball actually SLID THE TUBE, which is not the same as whether it left the pile: a
  // re-plan can find the gap already spent and drop the descent. The FLIP anchor below keys off
  // this rather than off `flew`, because a tube ball that never got `.transit` is parked ~44px
  // above the mouth at opacity 0 — springing the card from there is the one thing that made
  // skipping the descent look broken.
  const descended = flew && budget.transitMs > 0;
  if (descended) {
    const tube = byId('tube-ball');
    // The real face, not just the hue (#258) — same helper the drop ball uses, so the pile, the
    // tube and the drop ball are unmistakably one ball.
    paintBallFace(tube, reveal.team, hue);
    tube.style.setProperty('--tube-ms', `${budget.transitMs}ms`);
    tube.classList.remove('transit');
    void tube.offsetWidth; // restart the CSS animation for this transit
    tube.classList.add('transit');
    await new Promise((resolve) => setTimeout(resolve, budget.transitMs));
    if (token !== choreoToken) {
      hideHold();
      return false; // superseded: this run no longer owns the screen
    }
    // The envelope pick (#243) gets no hold: the envelope is chained off this promise and runs
    // 3600ms inside the same gap, so a hold there is 600ms taken straight out of the finale, and
    // that pick already has the better showcase. Asked through the shared predicate, so a reveal
    // that will NOT actually get an envelope — a catch-up, a hidden tab — keeps its hold.
    if (budget.mode === 'full' && !willEnvelope(reveal.pick, mode)) {
      await presentAtMouth(reveal, num, hue, budget.holdMs);
      if (token !== choreoToken) {
        hideHold();
        return false; // superseded: this run no longer owns the screen
      }
    }
  }
  exitInFlight = null;
  const tube = byId('tube-ball');
  // Measure BEFORE tearing the transit down, and measure the BALL, not the chute: while
  // `transit` is applied the ball's own rect is exactly where it parked, so the FLIP needs no
  // constant tracking the keyframe's end or the ball's diameter — the two numbers this PR had
  // to correct once already. A ball that did not descend — never extracted, or extracted into a
  // gap the re-plan found already spent — is still parked above the mouth at opacity 0, so there
  // the chute is the honest anchor: the card springs from the mouth, which is the last place the
  // viewer saw the ball either way.
  const held = holdRect();
  const fromRect =
    held ?? (descended ? tube.getBoundingClientRect() : byId('chute').getBoundingClientRect());
  const fromAnchor: FlipAnchor =
    held || descended
      ? {
          cx: fromRect.left + fromRect.width / 2,
          cy: fromRect.top + fromRect.height / 2,
          px: fromRect.width || tubeBallPx(),
        }
      : {
          cx: fromRect.left + fromRect.width / 2,
          cy: fromRect.bottom - tubeBallPx() / 2,
          px: tubeBallPx(),
        };
  tube.classList.remove('transit', 'logo-face');
  tube.style.background = '';
  byId('chute').classList.remove('active');
  show('drop', true);
  const ball = replaceNode('drop-pick');
  ball.textContent = num !== null ? `#${num}` : `#${reveal.pick}`;
  // The clone carries the previous reveal's inline tint — set or clear it explicitly.
  applyDropFace(ball, reveal.team, num !== null ? hue : undefined);
  replaceNode('drop-team').textContent = reveal.team;
  replaceNode('drop-odds').textContent = oddsText;
  // Started, not awaited yet: `hideHold` has to run in this same synchronous block, once the FLIP
  // has measured its start, or retiring the hold would make the ball vanish before the drop card
  // has taken its place.
  const landing = flipFromChute(ball, fromAnchor);
  hideHold();
  // Resolve when the reveal has LANDED, not when the spring starts (#269).
  //
  // The only thing chained off this promise is the pick-#1 envelope, and it adds a small settle
  // before dimming the screen. Measured from the start of a 620ms spring that settle put the dim
  // at ~90% opacity over the ball-#N face the envelope exists to showcase.
  //
  // This is NOT the same as `exitBudget.totalMs`, and nothing should be scheduled as if it were:
  // the envelope pick skips the hold, a reveal with no ball number never flies at all, and every
  // superseded return above resolves with no FLIP. `totalMs` is the planner's worst case; this is
  // what the run actually spent. What the two do share is a ceiling — see ENVELOPE_LEAD_MS.
  await landing;
  // The ball is out of the drum and its card has settled, so a breakpoint crossing the sim refused
  // mid-flight can land now (#267) — otherwise resizing during a reveal keeps the old drum for the
  // whole ceremony. This is the calmest moment in the beat: rescaling the pile mid-spring would
  // hitch the very animation #269 waits out. Unconditional, before the ownership check, because a
  // superseded run still leaves the drum sized for a viewport that no longer exists.
  flushDrumResize();
  // Whether this run still owns the screen. Waiting out the spring turned a window that used to be
  // one tick into most of a second, and an abort landing inside it tears the stage down WITHOUT
  // clearing `lastDropPick` — that reset only runs for idle/lobby/waiting — so the caller's guard
  // alone would still queue a finale over the abort screen.
  return token === choreoToken;
}

/**
 * The hold (#265): once the ball clears the chute's clip it is handed to a bigger element that
 * grows to camera size wearing the team's face, and stays there for `holdMs`. Only reached when
 * the budget said the gap can afford it.
 *
 * Everything is a plain timer and every wait is bounded, so a hidden tab lands in the right end
 * state. Retiring a superseded hold is the caller's job — its `choreoToken` check runs the moment
 * this returns, with nothing in between that could change the answer.
 */
async function presentAtMouth(
  reveal: LotteryReveal,
  num: number | null,
  hue: number | undefined,
  holdMs: number,
): Promise<void> {
  const chute = byId('chute');
  const hold = byId('tube-hold');
  // Size comes from `--hold-px` (stepped with the drum at #256's breakpoint) read by the
  // stylesheet itself, so there is no third copy of the number here to drift.
  hold.style.setProperty('--hold-grow', `${Math.min(260, Math.round(holdMs * 0.45))}ms`);
  hold.style.setProperty('--hold-top', `${chute.offsetTop + chute.offsetHeight - 20}px`);
  hold.style.left = `${chute.offsetLeft + chute.offsetWidth / 2}px`;
  holdFace = { team: reveal.team, hue };
  paintBallFace(hold, reveal.team, hue);
  // The logo is the point, so the ball number does not sit on top of it — the drop ball leads
  // with `#N` a beat later anyway. Without a logo the number is the ball's only identity.
  hold.textContent = hold.classList.contains('logo-face') || num === null ? '' : `#${num}`;
  hold.classList.remove('present');
  void hold.offsetWidth; // restart the grow for this pick
  hold.classList.add('present');
  await new Promise((resolve) => setTimeout(resolve, holdMs));
}

/** The hold ball's rect while it is on screen, so the FLIP starts from what the viewer sees. */
function holdRect(): DOMRect | null {
  const hold = document.getElementById('tube-hold');
  if (!hold || !hold.classList.contains('present')) return null;
  const rect = hold.getBoundingClientRect();
  return rect.width > 0 ? rect : null;
}

/**
 * Retire the hold. Safe at any time — every superseded path calls it on the way out, and a fresh
 * reveal clears it in its prologue before anything else can look at it.
 *
 * Unconditional on purpose. A superseded run cannot blank a successor's ball by calling this late:
 * its own hold timer runs at most HOLD_MAX_MS, while a successor needs EXTRACT_MS + TUBE_MIN_MS
 * before it has a ball to stage — so the stale wake-up always lands first, on an already-cleared
 * element. An ownership token here would be a second mechanism guarding a race the timings
 * already rule out.
 */
function hideHold(): undefined {
  holdFace = null;
  const hold = document.getElementById('tube-hold');
  if (!hold) return;
  hold.classList.remove('present', 'logo-face');
  hold.style.background = '';
  hold.textContent = '';
}

/**
 * The gap this reveal has before the next event supersedes it (#265).
 *
 * - During replay or catch-up the cursor is the authority, and it is asked FIRST: it holds the
 *   real next step — including the finish that follows the last reveal — and `nextDelayMs` applies
 *   `catchUpPace`'s sprint compression itself, so this never re-derives a pace it could get wrong.
 *   It must be `nextDelayMs`, not `remainingMs`: the cursor nulls its timer handle before
 *   dispatching a step, so a reveal handler reading `remainingMs` gets 0 every single time — an
 *   earlier revision did exactly that and silently planned every replay against the live pacing.
 * - Live, `delayMs` is the bot's beat→reveal pacing, and that is also the reveal→reveal gap this
 *   wants: the ceremony loop posts the next beat immediately after a reveal (no sleep between
 *   them), so the next event that supersedes this exit — the next REVEAL — lands one `delayMs`
 *   away. The intervening beat is expected to overlap the exit and does not wipe the drop card;
 *   see `armChute`.
 * - A drained cursor or an older api with no pacing falls back to the finish lead, the tightest
 *   gap that still animates: guessing generously would overrun a gap that turned out to be short.
 */
function revealGapMs(reveal: LotteryReveal): number {
  if (playbackMode !== null && cursor) {
    // Never fall through to the live pacing from here. `delayMs` is 5000–30000 while a replay runs
    // at a compressed cadence, so treating "the cursor has nothing queued" as "unknown" would hand
    // the planner a runway several times the real one. Nothing queued means the finish is next.
    const next = cursor.nextDelayMs();
    return next > 0 ? next : FINISH_LEAD_MS;
  }
  // No next pick at all — only the finish. Read from the payload's own `remaining` because that is
  // direction-agnostic (#258 assumed pick #1 was last, which `first-to-last` inverts).
  if (reveal.remaining.length === 0) return FINISH_LEAD_MS;
  return currentStart?.delayMs ?? FINISH_LEAD_MS;
}

function renderDrop(reveal: LotteryReveal): void {
  show('stage', true);
  applyStageLayout();
  const rerun = lastDropPick !== reveal.pick;
  lastDropPick = reveal.pick;
  // Claim the screen for the finale before anything animates (#243 live feedback). The finish can
  // land while the machine's exit is still running — a good second before `queueEnvelope` is
  // reached — so arming this at queue time would leave exactly the window the board sweeps into.
  if (rerun) armFinale(reveal.pick, playbackMode);
  // Which ball came out (#211/#215): cosmetic but stable — every viewer, poll repaint, and replay
  // derives the same number from the public commitment. See `drawnBallFor`.
  const range = currentStart
    ? assignBallRanges(currentStart.rows).find((r) => r.team === reveal.team)
    : undefined;
  const num =
    range && range.end >= range.start
      ? drawnBallFor(currentStart?.commitment ?? '', reveal.pick, range)
      : null;
  const oddsText = `${num !== null ? `ball #${num} · ` : ''}${reveal.balls} ball${reveal.balls === 1 ? '' : 's'} · ${reveal.oddsPct.toFixed(1)}% chance at this slot`;
  // The reveal's *information* is public the moment the event lands — headline, board, chips all
  // update immediately. Only the drop ball's appearance waits for the exit choreography.
  const chips = byId('drum-remaining');
  clear(chips);
  for (const team of reveal.remaining) chips.appendChild(el('span', 'chip', team));
  byId('drum-now').textContent = `Pick #${reveal.pick}: ${reveal.team}!`;
  // The card names its own slot, for every visual and every branch below. It outlives the headline
  // — which moves on to the next roll the moment the bot posts the next beat — so without this the
  // two disagree by one pick on screen, which is exactly how it was reported.
  byId('drop-slot').textContent = `Pick #${reveal.pick}`;
  // A later reveal retires the envelope (#243) — reachable in first-to-last, where pick #1 opens
  // the ceremony and pick #2 follows. Pick #1's own repaints leave it alone.
  if (rerun && reveal.pick !== 1) closeEnvelope();
  if (activeVisual() === 'wheel') {
    // The wheel reveal (#244): ease onto the named wedge. Like the race, the card shows straight
    // away rather than waiting on the animation — cosmetics never block a reveal.
    if (rerun) {
      audio.stopRoll();
      audio.hit();
      wheel().land(reveal.team, reveal.pick);
      // Shed the drawn team here, not in `renderOddsTable`. A live ceremony emits only
      // beat/reveal/finish over the socket, and reveals route straight to this function —
      // `renderOddsTable` never runs again after the start, so the wheel a WS viewer sees would
      // keep all twelve wedges at their opening widths while the card beside it prints shrinking
      // odds. The sim holds this until the landing has had its moment, then drops the wedge.
      const wheelRows = currentStart?.rows ?? [];
      const stillIn = new Set(reveal.remaining);
      wheel().sync(
        wheelRows,
        wheelRows.map((row) => row.team).filter((team) => !stillIn.has(team)),
      );
      show('drop', true);
      const ball = replaceNode('drop-pick');
      ball.classList.remove('flip');
      ball.classList.add('fall');
      ball.textContent = num !== null ? `#${num}` : `#${reveal.pick}`;
      applyDropFace(ball, reveal.team, num !== null && range !== undefined ? range.hue : undefined);
      replaceNode('drop-team').textContent = reveal.team;
      replaceNode('drop-odds').textContent = oddsText;
      // The landing ease is the wheel's payoff, so the envelope waits it out the way the race
      // waits for its park — same reason, different animation length.
      queueEnvelope(reveal, range?.hue, ENVELOPE_LEAD_MS.wheel, playbackMode);
    } else {
      show('drop', true);
      byId('drop-pick').textContent = num !== null ? `#${num}` : `#${reveal.pick}`;
      byId('drop-team').textContent = reveal.team;
      byId('drop-odds').textContent = oddsText;
    }
    return;
  }
  if (activeVisual() === 'race') {
    // The race reveal (#235): the racer parks itself — falls off the pace, or crosses the line
    // (`lockKind`) — while the field keeps dueling. Parallel spectacle, so the reveal card shows
    // immediately; nothing waits on the park, same "cosmetics never block" rule as the machine.
    race().agitate(false);
    if (rerun) {
      audio.stopRoll();
      audio.hit();
      race().lock(reveal.pick, reveal.team);
      show('drop', true);
      const ball = replaceNode('drop-pick');
      ball.classList.remove('flip');
      ball.classList.add('fall');
      ball.textContent = num !== null ? `#${num}` : `#${reveal.pick}`;
      applyDropFace(ball, reveal.team, num !== null && range !== undefined ? range.hue : undefined);
      replaceNode('drop-team').textContent = reveal.team;
      replaceNode('drop-odds').textContent = oddsText;
      // Pick #1 gets the envelope (#243) — after the winning cross/fall has parked on screen.
      queueEnvelope(reveal, range?.hue, ENVELOPE_LEAD_MS.race, playbackMode);
    } else {
      // A polling repaint of an already-shown reveal refreshes text without re-animating.
      show('drop', true);
      byId('drop-pick').textContent = num !== null ? `#${num}` : `#${reveal.pick}`;
      byId('drop-team').textContent = reveal.team;
      byId('drop-odds').textContent = oddsText;
    }
    return;
  }
  byId('hopper').classList.remove('spinning');
  hopper().agitate(false);
  if (rerun) {
    // End the roll (early if the network beat the schedule) and land the hit. Poll repaints of an
    // already-shown reveal stay silent, same rule as the animations.
    audio.stopRoll();
    audio.hit();
    show('drop', false); // the drop ball appears when the ball actually comes out
    // Pick #1's envelope (#243) waits for the exit choreography to land its FLIP — really land it
    // now, spring included (#269) — so the dim never swallows the ball-#N extraction, the
    // auditable moment. The choreography is itself time-capped (#215), so this settles promptly
    // even in a hidden tab. The mode is captured NOW: a catch-up draining during the choreography
    // must not launder its final compressed reveal into an eligible one.
    //
    // Two guards, because they catch different things. `landed` is the choreography saying it
    // still owns the screen — an abort tears the stage down without clearing `lastDropPick`, so
    // that guard alone would open a finale over the abort screen. `lastDropPick` catches a newer
    // reveal having taken over.
    const modeAtReveal = playbackMode;
    void runExitChoreography(reveal, num, range?.hue, oddsText, modeAtReveal).then((landed) => {
      if (landed && lastDropPick === reveal.pick) {
        queueEnvelope(reveal, range?.hue, ENVELOPE_LEAD_MS.machine, modeAtReveal);
      }
    });
  } else {
    // A polling repaint of an already-shown reveal refreshes text without re-animating — and
    // must not unveil the drop ball while its exit is still in flight.
    if (exitInFlight !== reveal.pick) show('drop', true);
    byId('drop-pick').textContent = num !== null ? `#${num}` : `#${reveal.pick}`;
    byId('drop-team').textContent = reveal.team;
    byId('drop-odds').textContent = oddsText;
  }
  // The drawn team's other balls fade from the pile (the extracted one exits via the chute) —
  // started AFTER the choreography grabbed its ball, so the fade exemption sees the extraction.
  hopper().removeTeam(reveal.team);
}

// One celebration per finished ceremony — a polling client re-rendering a finished snapshot
// every couple of seconds must not rain confetti forever.
let celebrated = false;

/**
 * A finish sweep held back while the pick-#1 finale plays (#243 live feedback).
 *
 * Only the SWEEP is deferred — the transition from a live stage to the sealed board. Repaints of an
 * already-swept board go straight through, so a poll landing during a replay's finale can't stall
 * the board that is already on screen.
 */
let deferredFinish: LotterySnapshot | null = null;
let deferredFinishTimer: number | null = null;

/** Drop a held sweep without rendering it — a phase change means it is no longer the truth. */
function cancelDeferredFinish(): void {
  deferredFinish = null;
  if (deferredFinishTimer !== null) {
    clearTimeout(deferredFinishTimer);
    deferredFinishTimer = null;
  }
}

/** Render a held sweep now. Safe to call when nothing is held. */
function flushDeferredFinish(): void {
  const held = deferredFinish;
  cancelDeferredFinish();
  if (held) renderFinish(held);
}

function renderFinish(snapshot: LotterySnapshot): void {
  // Hold the board while pick #1's ceremony owns the screen. The bot posts the finish as soon as
  // its PNG renders, which is mid-finale, and the sweep used to land BEHIND the overlay — the
  // ceremony played over a stage that had already moved on. `closeEnvelope` flushes this the
  // instant the finale ends; `finaleUntil` is a deadline, so a finale that never opens still lets
  // the board through. Deferring the sweep costs nothing in the channel: the bot has already
  // posted the board and the seed reveal there by this point.
  if (finaleHoldsStage() && !boardIsUp()) {
    deferredFinish = snapshot;
    if (deferredFinishTimer === null) {
      deferredFinishTimer = window.setTimeout(
        flushDeferredFinish,
        Math.max(0, finaleUntil - performance.now()),
      );
    }
    return;
  }
  cancelDeferredFinish();
  resetChute();
  // A late joiner can land directly on 'finished' without ever rendering the stage — apply the
  // layout here too so a race ceremony's finale board gets the wide frame every viewer saw (#239).
  applyStageLayout();
  hopperSim?.agitate(false); // stage is leaving the screen; let the pile settle and the loop park
  // The race parks itself as the final reveal locks, but a finish that outran a dropped reveal
  // must not leave un-parked racers animating behind a hidden stage (#235) — impose the sealed
  // order, which parks everyone.
  if (activeVisual() === 'race') {
    if (snapshot.finish && currentStart) raceSim?.sync(currentStart.rows, snapshot.finish.order);
    else raceSim?.sync([], []);
  }
  // The wheel has no loose bodies to park, but it does keep spinning if the finish outran the
  // last reveal — stop it rather than leave a hidden canvas animating (#235's rule).
  wheelSim?.spin(false);
  audio.stopRoll(); // a finish can land mid-roll (a skip, or a finish with no drop before it)
  show('waiting', false);
  show('stage', false);
  if (snapshot.finish) {
    renderFinalBoard(snapshot.finish.order, snapshot.reveals);
  } else {
    renderBoard(snapshot.reveals);
  }
  show('board', true);
  // Who the re-openable finale is about. Taken from the sealed ORDER when there is one, so a late
  // joiner who never saw the ceremony can still open the envelope; a board with no pick #1 yet
  // leaves it null and the button stays hidden.
  finaleTeam = finaleSubject(snapshot.finish?.order ?? snapshot.reveals);
  const verify = snapshot.finish?.verify;
  if (verify) {
    byId('verify-commitment').textContent = `commitment: ${verify.commitment}`;
    byId('verify-seed').textContent = `secret seed: ${verify.secretSeed}`;
    byId('verify-salt').textContent = `public salt (commitment message id): ${verify.salt}`;
    byId('verify-drawseed').textContent = `draw seed: ${verify.drawSeed}`;
    show('verify', true);
  }
  setStatus('final order sealed', 'live');
  // Capture the replay source (#197): the full published history this render was built from.
  // The event path passes no `start`, so fall back to the one remembered from `lottery-start`.
  const start = snapshot.start ?? currentStart;
  finishedSnapshot = {
    phase: 'finished',
    reveals: [...snapshot.reveals],
    ...(start ? { start } : {}),
    ...(snapshot.finish ? { finish: snapshot.finish } : {}),
  };
  // Reached directly by a catch-up's buffered finish (not via renderSnapshot), and that finish is
  // the live ceremony genuinely ending — so the phase gate has to be updated here too.
  livePhase = 'finished';
  if (snapshot.reveals.length > 0 || snapshot.finish) updateReplayAffordance();
  if (!celebrated) {
    celebrated = true;
    confetti();
    audio.fanfare(); // same one-shot gate as the confetti — a poll repaint must not replay it
  }
}

// --- replay (#197) + mid-reveal catch-up (#203) ---
//
// Both modes re-render published history on a local timer; they differ only in what a live event
// means. A `replay` re-watches a sealed ceremony, so any real live news wins and cancels it. A
// `catchup` runs *alongside* the ceremony it is replaying, so that ceremony's own beats and
// reveals cannot cancel it — they buffer and splice onto the tail (`classifyDuringCatchUp`), and
// when the queue drains the catch-up has reached the present and hands off to live.
//
// Playback is a chained cursor rather than a batch of absolute `setTimeout`s, because a catch-up
// has to append to a schedule that is already running. Pacing is unchanged: the per-step delays
// are the gaps between the builder's `atMs` values. The cursor itself — queue, timer, pause/resume
// (#204) — lives in `playbackCursor.ts` so it unit-tests without a DOM; this file owns the render.

let finishedSnapshot: LotterySnapshot | null = null;
let playbackMode: PlaybackMode | null = null;
let cursor: PlaybackCursor | null = null;
let replayWindowMs = REPLAY_MAX_STEP_MS;

/** Real timers + wall clock; the cursor takes them injected so it can be tested headless. */
const browserClock: PlaybackClock = {
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle),
  now: () => Date.now(),
};
/** Reveals the running catch-up accounts for — its source plus everything buffered since. */
let catchUpKnown = 0;
let catchUpFinish: LotteryFinish | undefined;
/** Commitment of the ceremony being caught up on, so a re-run is recognised as a different one. */
let catchUpCommitment: string | undefined;
/** Pick of the last drum-roll the catch-up queued or sourced — polling re-serves the same
 * `pendingBeat` every couple of seconds, and this is what keeps it from re-queueing (#207). */
let catchUpBeatPick: number | undefined;
/** Last phase the server reported — catch-up is only meaningful while a draw is actually running. */
let livePhase: LotteryPhase = 'idle';
/** The drum-roll the live ceremony is inside right now, if any — a catch-up started mid-beat
 * carries it so the pick in flight keeps its suspense (#207). */
let livePendingBeat: LotteryBeat | null = null;

/** The context the pure catch-up policy needs, assembled from the running catch-up's state. */
function catchUpContext(): CatchUpContext {
  return {
    known: catchUpKnown,
    ...(catchUpFinish ? { finish: catchUpFinish } : {}),
    ...(catchUpCommitment ? { commitment: catchUpCommitment } : {}),
    ...(catchUpBeatPick !== undefined ? { beatPick: catchUpBeatPick } : {}),
  };
}

/** True while either mode is playing — live handlers consult this before applying an event. */
function isPlaying(): boolean {
  return playbackMode !== null;
}

// Both modes' echo rules must agree on "same sealed result", so they share one implementation
// (`sameFinishOrder`) rather than keeping parallel copies that could drift apart.
const sameFinish = sameFinishOrder;

/**
 * During a replay, a repaint of the same finished ceremony (the polling fallback re-serving the
 * snapshot, a WS reconnect state push) is an echo — ignored, the replay runs on. Anything else
 * (a new start, an abort, a different finish) is real news: the caller cancels the replay and
 * applies it. Replay is a lens, not a fork.
 */
function isReplayEcho(event: LotteryEvent): boolean {
  if (event.type === 'lottery-state') {
    return (
      event.snapshot.phase === 'finished' &&
      sameFinish(event.snapshot.finish, finishedSnapshot?.finish)
    );
  }
  if (event.type === 'lottery-finish') return sameFinish(event.finish, finishedSnapshot?.finish);
  return false;
}

function applyReplayStep(event: LotteryEvent): void {
  switch (event.type) {
    case 'lottery-beat':
      renderDrum(event.beat.pick, event.beat.remaining, replayWindowMs);
      setStatus(playbackMode === 'catchup' ? 'catching up…' : 'replaying the reveal', 'live');
      break;
    case 'lottery-reveal':
      reveals.push(event.reveal);
      renderDrop(event.reveal);
      renderBoard(reveals);
      break;
    case 'lottery-finish':
      // End playback first so renderFinish paints the sealed state (status, confetti) normally.
      // For a catch-up this is the real finale: the ceremony ended while we were catching up, so
      // the viewer lands on the sealed board having watched the whole thing.
      stopPlayback();
      renderFinish({ phase: 'finished', reveals, finish: event.finish });
      break;
    default:
      break;
  }
}

/** The cursor drained on its own: playback reached its end. What that means depends on the mode. */
function onPlaybackDrained(mode: PlaybackMode): void {
  if (mode === 'catchup') {
    handOffToLive();
    return;
  }
  // A replay whose source carried no finish (a snapshot captured mid-reveal) ends by simply
  // running out. Without this it would stay "playing" — skip control up, replay button hidden —
  // until some unrelated live event happened along to cancel it.
  stopPlayback();
  updateReplayAffordance();
}

/**
 * The catch-up reached the present: drop out of playback and let live events render directly.
 * `reveals` already equals the live truth (every buffered reveal was played), so there is nothing
 * to repaint — the board simply keeps growing from here.
 */
function handOffToLive(): void {
  // Keep any armed pull: a catch-up most often drains right after playing a buffered beat, i.e.
  // while the live ceremony is mid-drum-roll. Cancelling here would strip the chute animation off
  // the exact pick the merge lands on — the feature's showcase moment.
  stopPlayback({ keepPull: true });
  setStatus('live reveal', 'live');
  updateReplayAffordance();
}

function beginPlayback(
  mode: PlaybackMode,
  source: LotterySnapshot,
  // Per-viewer replay choices (#255). A catch-up never passes them: it is a live ceremony seen
  // late, and must render as broadcast.
  options: { visual?: Visual | null; order?: ReplayOrder } = {},
): void {
  const timeline = buildReplayTimeline(source, { order: options.order ?? 'as-recorded' });
  if (timeline.length === 0) return;
  // A lingering finale envelope belongs to the run being replayed over (#243); the replay's own
  // pick-#1 step re-opens it at the right moment (a catch-up never does).
  closeEnvelope();
  playbackMode = mode;
  // Before the sim reset below, which asks `activeVisual()` which field to refill.
  replayVisual = mode === 'replay' ? (options.visual ?? null) : null;
  cursor = createPlaybackCursor(
    toPendingSteps(timeline),
    applyReplayStep,
    () => onPlaybackDrained(mode),
    browserClock,
    // A catch-up races the live draw, so it hurries while the queue is deep (#207); a sealed
    // replay races nothing and keeps its full pacing.
    mode === 'catchup' ? catchUpPace : undefined,
  );
  replayWindowMs = replayStepMs(source);
  // Playback re-runs the draw from pick one, so the field must be full again; drops re-empty the
  // pile, reveals re-park the racers — the shrinking lock set forces the race rebuild (#235).
  const bagRows = source.start?.rows ?? currentStart?.rows;
  if (bagRows) {
    if (activeVisual() === 'wheel') wheel().sync(bagRows, []);
    else if (activeVisual() === 'race') race().sync(bagRows, []);
    else hopper().sync(bagRows, []);
  }
  applyStageLayout();
  // Both modes re-arm the finale. A catch-up's `lottery-finish` is buffered and played by
  // `applyReplayStep`, so this *is* the viewer's finale — suppressing it here would mean the one
  // person the feature exists for is the only one who never sees the confetti.
  celebrated = false;
  lastDropPick = null;
  rolledPick = null; // playback replays the same pick numbers — each deserves its roll again
  reveals = [];
  show('board', false);
  show('verify', false);
  show('waiting', false);
  show('replay-btn', false);
  show('replay-skip', true);
  show('stage', true);
  show('drop', false);
  byId('replay-skip').textContent = mode === 'catchup' ? '⏭ skip to live' : '⏭ skip to result';
  setStatus(mode === 'catchup' ? 'catching up…' : 'replaying the reveal', 'live');
  cursor.start();
}

function startReplay(): void {
  const source = finishedSnapshot;
  if (!source || isPlaying() || document.hidden) return;
  const picked = (byId('replay-visual') as HTMLSelectElement).value;
  const order = (byId('replay-order') as HTMLSelectElement).value;
  beginPlayback('replay', source, {
    // Empty means "as it happened" — fall through to the ceremony's own visual.
    visual: picked === 'machine' || picked === 'race' || picked === 'wheel' ? picked : null,
    order:
      order === 'worst-to-first' || order === 'first-to-last'
        ? order
        : ('as-recorded' as ReplayOrder),
  });
}

/**
 * Catch-up (#203): replay this ceremony from pick one while it is still running. The source is
 * whatever has been published so far — the same local accumulator the live board renders from, so
 * no refetch and no server state.
 */
function startCatchUp(): void {
  // Only while a draw is actually running. An aborted ceremony leaves the board (and this button)
  // on screen, and re-animating a discarded draw under the abort banner — ending on a full board
  // labelled "live reveal" — is the worst possible screen for a fairness-critical lottery.
  // `document.hidden` here is unreachable for a human (you can't click a hidden tab's button),
  // but synthetic clicks — tests, automation — can do it, and a playback *started* hidden dodges
  // the #208 visibility handler (it acts on transitions) while Chrome throttles its chained
  // timers toward one fire a minute. Refuse in both starters rather than run in molasses.
  if (isPlaying() || livePhase !== 'revealing' || reveals.length === 0 || document.hidden) return;
  const source: LotterySnapshot = {
    phase: 'revealing',
    reveals: [...reveals],
    ...(currentStart ? { start: currentStart } : {}),
    // The drum-roll in flight when the viewer clicked (#207): carried so the timeline ends on its
    // beat and the pick the catch-up merges on keeps its suspense instead of landing as a bare drop.
    ...(livePendingBeat ? { pendingBeat: livePendingBeat } : {}),
  };
  catchUpKnown = source.reveals.length;
  catchUpFinish = undefined;
  catchUpCommitment = currentStart?.commitment;
  catchUpBeatPick = livePendingBeat?.pick;
  beginPlayback('catchup', source);
}

function stopPlayback(options: { keepPull?: boolean } = {}): void {
  cursor?.stop();
  cursor = null;
  playbackMode = null;
  // The screen goes back to the real ceremony's visual (#255). Cleared here rather than only on
  // the next replay: `activeVisual()` is asked by every repaint, and leaving a stale override set
  // would repaint a live board in a visual nobody else is watching.
  replayVisual = null;
  catchUpCommitment = undefined;
  catchUpBeatPick = undefined;
  show('replay-skip', false);
  // A skip or cancel mid-roll must not leave the crescendo playing. `keepPull` is the catch-up
  // handoff landing mid-drum-roll of the live ceremony — the pull *and* the roll belong to the
  // very pick the merge lands on, so both survive.
  if (!options.keepPull) {
    audio.stopRoll();
    resetChute();
  }
}

/**
 * Cancelling a catch-up abandons its queue, but those queued reveals are *published* picks the
 * viewer is entitled to see. Fold them into the board so a cancel (an abort, most importantly)
 * leaves the full published order on screen rather than the truncated prefix the catch-up had
 * animated so far. The polling path repaints wholesale and doesn't need this; the WS path does.
 */
function flushCatchUpRevealsIntoBoard(): void {
  for (const step of cursor?.pending() ?? []) {
    if (step.event.type === 'lottery-reveal') reveals.push(step.event.reveal);
  }
}

/** Is this pick already on the board or sitting in the queue? */
function catchUpHasPick(pick: number): boolean {
  return (
    reveals.some((r) => r.pick === pick) ||
    (cursor?.pending() ?? []).some(
      (s) => s.event.type === 'lottery-reveal' && s.event.reveal.pick === pick,
    )
  );
}

/** Queue a live event onto the tail of a running catch-up, at the compressed cadence. */
function bufferCatchUpEvent(event: LotteryEvent): void {
  switch (event.type) {
    case 'lottery-beat':
      // The same drum-roll can arrive as a live WS frame and inside a poll snapshot's
      // `pendingBeat` — one roll per pick, whichever transport lands it first (#207).
      if (event.beat.pick === catchUpBeatPick) return;
      catchUpBeatPick = event.beat.pick;
      cursor?.append({ delayMs: REPLAY_DWELL_MS, event });
      break;
    case 'lottery-reveal':
      // Polling and the WebSocket have no cross-transport ordering guarantee, and both are briefly
      // live around a reconnect — so the same published pick can reach us twice, once inside a
      // snapshot-derived tail and once as its own frame. Picks are unique, so dedupe on that
      // rather than trusting arrival order.
      if (catchUpHasPick(event.reveal.pick)) return;
      catchUpKnown += 1;
      cursor?.append({ delayMs: replayWindowMs, event });
      break;
    case 'lottery-finish':
      catchUpFinish = event.finish;
      cursor?.append({ delayMs: REPLAY_DWELL_MS, event });
      break;
    default:
      return;
  }
}

/**
 * Skip: during a replay, jump to the sealed final board; during a catch-up, jump to the live
 * present. Both are "stop pretending and show me what is true now" — they just have different
 * truths, because a catch-up's ceremony has not finished.
 */
function skipReplay(): void {
  if (playbackMode === 'catchup') {
    // Apply everything still queued instantly, so the board lands exactly on the live state.
    const queued = cursor?.pending() ?? [];
    stopPlayback();
    playbackMode = 'catchup'; // keep applyReplayStep's accumulate-into-`reveals` behavior
    for (const step of queued) applyReplayStep(step.event);
    if (isPlaying()) handOffToLive();
    return;
  }
  const source = finishedSnapshot;
  if (!source) return;
  stopPlayback();
  celebrated = true; // skipping isn't a finale moment — no second confetti burst
  reveals = [...source.reveals];
  renderSnapshot(source);
}

/**
 * Show the right button for the phase: "catch up" mid-reveal, "replay" once sealed, nothing while
 * a playback is already running (the skip control takes over).
 */
function updateReplayAffordance(): void {
  const btn = byId('replay-btn');
  // The finale re-open (live feedback) sits beside the replay and follows the same rules: only on
  // a sealed board, never over a running playback, and only once there is a pick #1 to show. It is
  // offered to late joiners too, which is why the subject comes from the ORDER rather than from
  // having witnessed the ceremony.
  show('envelope-btn', !isPlaying() && livePhase === 'finished' && finaleTeam !== null);
  // The replay options (#255) belong to a sealed replay only — never over a running playback, and
  // never beside the "catch up" offer, which must render the ceremony as broadcast.
  const sealed = !isPlaying() && livePhase === 'finished' && finishedSnapshot !== null;
  show('replay-visual-wrap', sealed);
  show('replay-order-wrap', sealed);
  if (isPlaying()) {
    show('replay-btn', false);
    return;
  }
  if (livePhase === 'finished' && finishedSnapshot) {
    btn.textContent = '↻ Replay the reveal';
    show('replay-btn', true);
    return;
  }
  // Mid-reveal: only worth offering once there is history to catch up on. Any other phase
  // (aborted especially, which leaves the board on screen) gets no offer at all.
  btn.textContent = '↻ Catch up from the start';
  show('replay-btn', livePhase === 'revealing' && reveals.length > 0);
}

/**
 * Backgrounding the tab (#204). Chrome throttles and batches timers in a hidden tab, so without
 * this a playback either bursts through on return or crawls at one step a minute — either way the
 * viewer comes back to something that isn't what they left. What to do about it differs by mode;
 * `onHiddenAction` owns that rule and explains why.
 */
function onVisibilityChange(): void {
  // The physics loop pauses whenever the tab hides, playback or not — rAF is throttled in hidden
  // tabs anyway; parking it outright makes the resume clean and costs nothing. The roll stops
  // outright too: nobody hears a drum roll for a hidden tab, and the next beat re-rolls.
  hopperSim?.setRunning(!document.hidden);
  raceSim?.setRunning(!document.hidden);
  wheelSim?.setRunning(!document.hidden);
  if (document.hidden) audio.stopRoll();
  if (!cursor || !playbackMode) return;
  if (document.hidden) {
    if (onHiddenAction(playbackMode) === 'pause') {
      cursor.pause();
      // The pull is a CSS animation the browser freezes too; drop it and re-arm on the way back.
      resetChute();
      return;
    }
    // Cancel (a catch-up): keep every published pick it had queued — those are public results the
    // viewer is entitled to see — then let live state own the screen again. `updateReplayAffordance`
    // re-offers the catch-up if the draw is still running, so returning mid-ceremony can restart it
    // against the present rather than resuming a race it has already lost.
    flushCatchUpRevealsIntoBoard();
    // A catch-up that had already buffered the finish is animating a ceremony that is *over*, and
    // its finish never reached `renderSnapshot` — so `livePhase` is still 'revealing' here. Dropping
    // it would strand the screen on "live reveal" with a catch-up offered on a sealed draw, and that
    // stale gate would let the offer actually start one. Land on the sealed state instead.
    const bufferedFinish = catchUpFinish;
    stopPlayback();
    if (bufferedFinish) {
      // Confetti is one-shot and would play to a tab nobody is watching. Suppress it here; the
      // Replay this now correctly offers re-arms `celebrated`, so the finale isn't lost for good.
      celebrated = true;
      renderFinish({ phase: 'finished', reveals, finish: bufferedFinish });
      return;
    }
    renderBoard(reveals);
    setStatus('live reveal', 'live');
    updateReplayAffordance();
    return;
  }
  if (!cursor.isPaused()) return;
  // Re-arm the chute glow against what is genuinely left of the drum-roll window. A short
  // remainder is fine: `armChute` clamps its lead to 0 and the glow just comes on immediately.
  const next = cursor.peek();
  const leftMs = cursor.remainingMs();
  cursor.resume();
  if (next?.event.type === 'lottery-reveal' && activeVisual() === 'machine') {
    armChute(next.event.reveal.pick, leftMs);
  }
}

function confetti(): void {
  const colors = ['#f5d67b', '#4ade80', '#6cc6ff', '#ff8fc0', '#e8a33d'];
  for (let i = 0; i < 80; i += 1) {
    const piece = el('div', 'confetti');
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDuration = `${2.4 + Math.random() * 2.6}s`;
    piece.style.animationDelay = `${Math.random() * 0.8}s`;
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 6500);
  }
}

/** Repaint everything from a snapshot — the late-join / reconnect path. */
function renderSnapshot(snapshot: LotterySnapshot): void {
  // Track what the *server* says, separately from what playback is animating: the catch-up offer
  // and the replay offer are both phase-gated, and a replay renders a finished snapshot while the
  // live ceremony may be something else entirely.
  livePhase = snapshot.phase;
  // Same for the drum-roll in flight (#207): only a mid-reveal snapshot has one; any other phase
  // means whatever beat we knew about has been consumed or discarded.
  livePendingBeat = snapshot.phase === 'revealing' ? (snapshot.pendingBeat ?? null) : null;
  // The re-import tracker is lobby-scoped (#250). Clearing it here — not only in the lobby
  // branch — is what stops a pending press's timer firing minutes later over an idle or live
  // screen and painting a false "no response from the bot" on top of it.
  if (snapshot.phase !== 'lobby') trackReimportPress(undefined, undefined);
  // A fresh phase repaints from scratch: hide the sections a previous run may have left visible
  // (a re-run start after a finished/aborted ceremony must not show stale board/verify/abort),
  // and re-arm the one-shot celebration.
  if (snapshot.phase === 'idle' || snapshot.phase === 'lobby' || snapshot.phase === 'waiting') {
    show('board', false);
    show('verify', false);
    show('abort', false);
    // A new ceremony invalidates the previous run's replay source — the button must not
    // resurface on the growing board offering a replay of the *last* lottery.
    show('replay-btn', false);
    finishedSnapshot = null;
    celebrated = false;
    lastDropPick = null;
    rolledPick = null;
    resetChute();
    // Any exit from a drum-roll must kill the boil — and the roll (#216) follows the same rule:
    // only drop/finish end them otherwise, and idle() can never park the sim's loop while
    // agitating, even over an empty pile.
    hopperSim?.agitate(false);
    // The previous ceremony's visual leaves with it (#235): the pre-draw field is always the
    // machine's loaded hopper, and a lingering `start` would paint the next lobby as a race —
    // clearing the field also parks the race loop, which never sleeps while racers are loose.
    currentStart = undefined;
    raceSim?.sync([], []);
    wheelSim?.spin(false); // loose animation must not run behind a hidden stage (#235)
    applyStageLayout();
    audio.stopRoll();
  }
  // The envelope survives only the phases its reveal lives in (#243): 'revealing' repaints must
  // not kill a playing finale, and 'finished' arrives moments after pick #1 in worst-to-first.
  // Everything else — idle, a fresh lobby, a new start, an abort — retires it.
  //
  // A held finish sweep is only the truth while the stage says 'finished'. Dropped BEFORE the
  // close, not after: `closeEnvelope` flushes what it is holding, so an abort arriving mid-finale
  // would otherwise paint the sealed board over the abort screen on its way out.
  if (snapshot.phase !== 'finished') cancelDeferredFinish();
  if (snapshot.phase !== 'revealing' && snapshot.phase !== 'finished') closeEnvelope();
  // The start doorbell (#253) is an idle-only surface.
  show('setup-actions', snapshot.phase === 'idle');
  switch (snapshot.phase) {
    case 'idle': {
      // The start doorbell (#253): pending state and one-shot denial both ride the snapshot,
      // like every other request flag — no timers, every viewer agrees.
      setupPending = snapshot.setupRequested !== undefined;
      const denied = snapshot.setupDenied;
      if (setupPending) setStatus('setting up — the bot is importing the league…', 'live');
      else if (denied) setStatus(`start refused: ${denied}`, 'err');
      else setStatus('no ceremony yet');
      show('waiting', true);
      show('stage', false);
      byId('waiting-sub').textContent = setupPending
        ? 'Importing the league from ESPN…'
        : 'No ceremony yet — a member with Manage Server can start one right here.';
      (byId('setup-btn') as HTMLButtonElement).disabled = setupPending;
      (byId('setup-season') as HTMLInputElement).disabled = setupPending;
      // Wipe anything a previous phase painted. This matters more now that a lobby can be armed
      // days before the draw (#198): an api restart, or a `clear` after a cancelled setup, drops
      // an open iframe back to idle, and a leftover odds table under "not opened yet" reads as a
      // live ceremony that no longer exists.
      byId('title').textContent = 'The Lottery Machine';
      byId('commit').textContent = '';
      clear(byId('odds-rows'));
      // No lobby ⇒ nothing to edit (#210); the stage refuses adjustments in this phase anyway.
      currentLobby = undefined;
      show('edit-hint', false);
      show('commish-panel', false);
      hopperSim?.sync([], []); // empty the pile — the canvas clears on the next frame
      // An idle stage means an api restart or a cleared lobby — either way the armedSeq space
      // may reset (#232), so forget everything commissioner-related and let the next lobby's
      // check start from scratch rather than trust sequence numbers across a process boundary.
      seenArmedSeq = undefined;
      commissioner = false;
      commissionerCheck = null;
      break;
    }
    case 'lobby': {
      // Pre-commitment lobby (#198): show odds without the commitment hash.
      reimportPending = snapshot.reimportRequested === true;
      beginPending = snapshot.beginRequested !== undefined;
      auditModeCurrent = snapshot.auditMode === 'seal-only' ? 'seal-only' : 'live';
      trackReimportPress(
        reimportPending ? (snapshot.reimportRequestedAt ?? 0) : undefined,
        snapshot.reimportDenied,
      );
      if (snapshot.lobby) renderLobby(snapshot.lobby);
      paintLobbyStatus();
      show('waiting', true);
      show('stage', false);
      break;
    }
    case 'waiting':
      if (snapshot.start) renderWaiting(snapshot.start);
      setStatus('waiting', 'live');
      show('waiting', true);
      show('stage', false);
      break;
    case 'revealing': {
      // Drawn teams ride along so the pile reflects the live bag, not the full pre-draw one —
      // EXCEPT the newest reveal when this repaint is about to animate it for the first time
      // (#215): `renderDrop` below needs that team's ball still in the pile to extract it, and
      // will fade the rest itself. Poll-only clients get their reveals exclusively through this
      // path, so removing it here would silently downgrade every one of their exits. Repaints of
      // an already-shown reveal (`lastDropPick` matches) remove it like any other drawn team.
      const last = snapshot.reveals[snapshot.reveals.length - 1];
      const aboutToAnimate =
        !snapshot.pendingBeat && last !== undefined && last.pick !== lastDropPick;
      if (snapshot.start)
        renderWaiting(
          snapshot.start,
          snapshot.reveals
            .filter((r) => !(aboutToAnimate && r === last))
            .map((r) => ({ pick: r.pick, team: r.team })),
        );
      setStatus('live reveal', 'live');
      // A draw is running, so any sealed result we were holding belongs to a *previous* ceremony.
      // Left set, it would mislabel the button "Replay the reveal" and replay the old lottery over
      // the live one (reachable on the poll-only path, whose 2s tick can skip the waiting phase).
      finishedSnapshot = null;
      renderBoard(snapshot.reveals);
      if (snapshot.pendingBeat) {
        renderDrum(snapshot.pendingBeat.pick, snapshot.pendingBeat.remaining);
      } else if (snapshot.reveals.length > 0) {
        renderDrop(snapshot.reveals[snapshot.reveals.length - 1]);
      }
      // The late-join path (#203): landing mid-ceremony with picks already published is exactly
      // when catch-up is worth offering. Live state stays on screen — the viewer chooses.
      updateReplayAffordance();
      break;
    }
    case 'finished':
      if (snapshot.start) renderWaiting(snapshot.start);
      renderFinish(snapshot);
      break;
    case 'aborted':
      resetChute();
      // An abort mid-drum-roll arrives with the boil on, and no drop/finish will ever follow to
      // turn it off — without this the sim agitates a hidden pile at 60fps for as long as the
      // iframe stays open on the abort screen. Same for the roll: an abort must not drum on.
      // The race is stricter still: loose racers never sleep, so the field is emptied outright.
      hopperSim?.agitate(false);
      raceSim?.sync([], []);
      wheelSim?.spin(false); // loose animation must not run behind a hidden stage (#235)
      audio.stopRoll();
      show('waiting', false);
      show('stage', false);
      show('abort', true);
      byId('abort-reason').textContent = snapshot.abort?.reason ?? 'The ceremony was aborted.';
      setStatus('aborted', 'err');
      // The board (and the button inside it) stays up, so retract the offer explicitly — an inert
      // "catch up" control sitting on a fairness-critical failure screen is its own problem.
      updateReplayAffordance();
      break;
  }
}

function applyEvent(event: LotteryEvent): void {
  switch (event.type) {
    case 'lottery-state':
      renderSnapshot(event.snapshot);
      break;
    case 'lottery-lobby':
      // Pre-commitment lobby (#198): arm the waiting room from setup onward. The pending-request
      // flags ride the event beside the lobby, so carry them into the synthetic snapshot (#227).
      reveals = [];
      renderSnapshot({
        phase: 'lobby',
        lobby: event.lobby,
        reveals: [],
        ...(event.reimportRequested ? { reimportRequested: true } : {}),
        ...(event.reimportRequestedAt !== undefined
          ? { reimportRequestedAt: event.reimportRequestedAt }
          : {}),
        ...(event.reimportDenied ? { reimportDenied: event.reimportDenied } : {}),
        ...(event.beginRequested ? { beginRequested: event.beginRequested } : {}),
        ...(event.auditMode ? { auditMode: event.auditMode } : {}),
      });
      break;
    case 'lottery-start':
      // A start (re)opens the stage — drop any previous run's reveals before repainting.
      reveals = [];
      renderSnapshot({ phase: 'waiting', start: event.start, reveals: [] });
      break;
    case 'lottery-beat':
      // The draw is running. The server only pushes a full `lottery-state` on WS connect, so for
      // a client that was already watching (the whole lobby, per #198) these incremental events
      // are the *only* signal that `waiting` became `revealing` — without this the catch-up offer
      // would never appear for anyone except a strict mid-ceremony joiner.
      livePhase = 'revealing';
      livePendingBeat = event.beat; // the drum-roll now in flight, for a catch-up started mid-beat
      // Keep the "a draw is running ⇒ no sealed result in hand" invariant local to this path
      // rather than resting on `lottery-start` having arrived first: a stale `finishedSnapshot`
      // would route this button's click into a replay of the *previous* lottery.
      finishedSnapshot = null;
      setStatus('live reveal', 'live');
      renderDrum(event.beat.pick, event.beat.remaining);
      break;
    case 'lottery-reveal':
      livePhase = 'revealing';
      livePendingBeat = null; // the reveal consumes the beat
      reveals.push(event.reveal);
      renderDrop(event.reveal);
      renderBoard(reveals);
      // A late joiner now has history worth catching up on (#203).
      updateReplayAffordance();
      break;
    case 'lottery-finish':
      renderFinish({ phase: 'finished', reveals, finish: event.finish });
      break;
    case 'lottery-abort':
      renderSnapshot({ phase: 'aborted', reveals, abort: event.abort });
      break;
  }
}

// Local reveal accumulator so incremental events don't need a snapshot refetch.
let reveals: LotteryReveal[] = [];

function poll(base: string): void {
  fetch(apiPath(base, '/api/lottery/state'), { cache: 'no-store' })
    .then((r) => r.json())
    .then((snapshot: LotterySnapshot) => {
      if (playbackMode === 'catchup') {
        // Polling only ever hands us whole snapshots, so a poll-only client (no WebSocket) merges
        // back into the present by turning the un-played remainder into tail events.
        const verdict = classifyDuringCatchUp(
          { type: 'lottery-state', snapshot },
          catchUpContext(),
        );
        if (verdict === 'ignore') return;
        if (verdict === 'buffer') {
          for (const tail of catchUpTailFromSnapshot(snapshot, catchUpContext())) {
            bufferCatchUpEvent(tail);
          }
          return;
        }
        stopPlayback(); // cancel: aborted, or a different ceremony
      } else if (playbackMode === 'replay') {
        // An identical finished snapshot is just the fallback repainting — the replay runs on.
        if (snapshot.phase === 'finished' && sameFinish(snapshot.finish, finishedSnapshot?.finish))
          return;
        stopPlayback(); // anything else is real news, and live state wins
      }
      reveals = [...snapshot.reveals];
      renderSnapshot(snapshot);
    })
    .catch(() => setStatus('backend offline', 'err'));
}

// Module-level so every reconnect attempt shares ONE fallback timer: a `connect()`-local timer
// would be orphaned by the next reconnect closure and leak an interval per drop.
let pollTimer: ReturnType<typeof setInterval> | null = null;
function startPolling(base: string): void {
  if (!pollTimer) {
    poll(base);
    pollTimer = setInterval(() => poll(base), 2000);
  }
}
function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function connect(base: string): void {
  poll(base); // paint immediately from the current snapshot
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl(window.location, base, '/api/lottery/ws'));
  } catch {
    startPolling(base);
    return;
  }
  ws.onopen = (): void => stopPolling();
  ws.onmessage = (ev: MessageEvent): void => {
    try {
      const event = JSON.parse(String(ev.data)) as LotteryEvent;
      if (playbackMode === 'catchup') {
        const verdict = classifyDuringCatchUp(event, catchUpContext());
        if (verdict === 'ignore') return;
        if (verdict === 'buffer') {
          // A snapshot that ran ahead becomes the tail events it implies; everything else queues
          // as itself. Either way the catch-up plays on and merges into the present.
          if (event.type === 'lottery-state') {
            for (const tail of catchUpTailFromSnapshot(event.snapshot, catchUpContext())) {
              bufferCatchUpEvent(tail);
            }
          } else {
            bufferCatchUpEvent(event);
          }
          return;
        }
        // cancel: aborted, or a different ceremony. Keep the picks we had already queued.
        flushCatchUpRevealsIntoBoard();
        stopPlayback();
      } else if (playbackMode === 'replay') {
        if (isReplayEcho(event)) return; // same finished ceremony — the replay runs on
        stopPlayback(); // anything else is real news, and live events win
      }
      if (event.type === 'lottery-state') reveals = [...event.snapshot.reveals];
      applyEvent(event);
    } catch {
      /* ignore a malformed frame */
    }
  };
  ws.onclose = (): void => {
    startPolling(base);
    setTimeout(() => connect(base), 3000);
  };
  ws.onerror = (): void => {
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  };
}

async function boot(): Promise<void> {
  // One button, two meanings: replay a sealed ceremony, or catch up on a running one (#203).
  byId('replay-btn').addEventListener('click', () => {
    if (finishedSnapshot) startReplay();
    else startCatchUp();
  });
  byId('replay-skip').addEventListener('click', skipReplay);
  // The finale is dismissible and re-openable (live feedback). Dismissing early also releases a
  // finish sweep the ceremony was holding — a viewer who skips the moment gets the board at once.
  byId('envelope').addEventListener('click', closeEnvelope);
  byId('envelope-btn').addEventListener('click', reopenEnvelope);
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeEnvelope();
  });
  byId('reimport-btn').addEventListener('click', () => void sendReimport());
  byId('begin-btn').addEventListener('click', () => void sendBegin());
  byId('bulk-btn').addEventListener('click', () => void sendBulk());
  byId('audit-mode').addEventListener('change', () => void sendAuditMode());
  byId('setup-btn').addEventListener('click', () => void sendSetupRequest());
  watchDrumSize();
  // Default the season picker to the year the page loaded — draft season in practice.
  (byId('setup-season') as HTMLInputElement).value = String(new Date().getFullYear());
  byId('sound-btn').addEventListener('click', () => audio.toggle());
  document.addEventListener('visibilitychange', onVisibilityChange);
  const inDiscord = isDiscordActivity(window.location);
  const base = proxyBase(inDiscord);
  activityBase = base;
  if (inDiscord) {
    try {
      const handshake = await runHandshake(base);
      accessToken = handshake.accessToken;
      activityGuildId = handshake.guildId ?? null;
    } catch (error) {
      // Three sinks, because the 2026-08-01 outage (a portal misconfiguration failing every
      // desktop handshake) was invisible in all of them (#231): the status pill got overwritten
      // by the first render, the console printed "[object Object]" for the SDK's plain-object
      // rejections, and the operator's api saw nothing at all.
      const reason = describeError(error);
      setStatus('Discord auth failed', 'err');
      const warn = byId('auth-warn');
      warn.title = `Discord sign-in failed — editing is unavailable. ${reason}`;
      show('auth-warn', true);
      console.error('[lottery] handshake failed:', reason, error);
      void fetch(
        apiPath(base, `/api/lottery/diag?msg=${encodeURIComponent(`handshake failed: ${reason}`)}`),
      ).catch(() => {});
      // Fall through — the reveal is public; still show it even if auth didn't complete.
    }
  }
  // Whether this member may edit (#210). Only meaningful once a lobby is armed, so `renderLobby`
  // re-asks if this one lands while the stage is still idle.
  if (accessToken) {
    const boot = fetchCommissioner().then((answer) => {
      commissioner = answer === true;
    });
    commissionerCheck = boot;
    await boot;
    // A boot-time "no" is not final — the lobby may not exist yet. Let the lobby path retry.
    if (!commissioner) commissionerCheck = null;
  }
  connect(base);
}

void boot();
