/**
 * Browser entry for the lottery machine (#169), bundled by esbuild to `dist/client/lottery.js`
 * and loaded by the shell in `lotteryPage.ts`.
 *
 * Pure presentation: every state change arrives from the backend stage (WS push, polling
 * fallback), which the bot paces — this client never draws, times, or decides anything. It
 * renders the full drama: waiting-room odds table → hopper spin + drum-roll → the pull (a ball
 * drawn through the chute, timed against the beat window, #195) → ball drop with a per-pick odds
 * flash → the growing order board → final board + seed-verify panel (or the abort banner).
 * Inside Discord it runs the shared SDK handshake and `/.proxy` transport; standalone (dev) it
 * skips the SDK — same split as the draft board client.
 */

import type {
  LotteryEvent,
  LotteryFinish,
  LotteryLobby,
  LotteryPhase,
  LotteryReveal,
  LotterySnapshot,
  LotteryStart,
} from '../lotteryStage.js';
import { assignBallRanges, drawnBallFor, rangeLabel } from './ballAssignments.js';
import { createHopperSim, type HopperSim } from './hopperSim.js';
import {
  createPlaybackCursor,
  onHiddenAction,
  type PlaybackClock,
  type PlaybackCursor,
  type PlaybackMode,
} from './playbackCursor.js';
import {
  buildReplayTimeline,
  catchUpTailFromSnapshot,
  classifyDuringCatchUp,
  REPLAY_DWELL_MS,
  REPLAY_MAX_STEP_MS,
  replayStepMs,
  sameFinishOrder,
  toPendingSteps,
  type CatchUpContext,
} from './replayTimeline.js';
import { runHandshake } from './sdk.js';
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

/** The board list is rebuilt from all reveals so late joiners and live viewers converge. */
function renderBoard(reveals: LotteryReveal[]): void {
  const sorted = [...reveals].sort((a, b) => a.pick - b.pick);
  paintBoardList(
    sorted.map((r) => ({ pick: r.pick, team: r.team, reveal: r })),
    sorted.length > 0,
  );
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
  if (!hopperSim) hopperSim = createHopperSim(byId('hopper-canvas') as HTMLCanvasElement);
  return hopperSim;
}

/** The odds table + hopper pile, shared by the lobby (#198) and the committed waiting room. */
function renderOddsTable(
  oddsRows: { team: string; balls: number; firstPct: number; top3Pct: number }[],
  drawnTeams: string[] = [],
): void {
  const rows = byId('odds-rows');
  clear(rows);
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
    teamCell.appendChild(document.createTextNode(row.team));
    tr.appendChild(teamCell);
    const ballsCell = el('td', 'num', String(row.balls));
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
  hopper().sync(oddsRows, drawnTeams);
}

/**
 * Pre-commitment lobby (#198): odds visible before the draw begins. Shows a placeholder in the
 * commit slot instead of the hash (which doesn't exist yet).
 */
function renderLobby(lobby: LotteryLobby): void {
  byId('title').textContent = lobby.title;
  byId('waiting-sub').textContent =
    `${lobby.teamCount} teams · ${lobby.totalBalls} balls in the hopper`;
  byId('commit').textContent = 'Commissioner will begin the draw soon…';
  renderOddsTable(lobby.rows);
}

function renderWaiting(start: LotteryStart, drawnTeams: string[] = []): void {
  currentStart = start; // remembered for pull scheduling (delayMs) across later phases
  byId('title').textContent = start.title;
  byId('waiting-sub').textContent =
    `${start.teamCount} teams · ${start.totalBalls} balls in the hopper`;
  byId('commit').textContent = `commitment ${start.commitment.slice(0, 16)}…`;
  renderOddsTable(start.rows, drawnTeams);
}

// --- the pull (#195): a ball leaves the hopper through the chute during the drum-roll window ---

/** Suck-to-chute + tube descent (must track the `suck`/`tube` keyframe timings in the CSS). */
const PULL_MS = 1000;
let pullTimer: ReturnType<typeof setTimeout> | null = null;
/** Beat pick the pull is armed for — poll repaints of the same beat must not restart it. */
let armedPick: number | null = null;
/** Last reveal actually animated — repeat paints of the same reveal only refresh text. */
let lastDropPick: number | null = null;
// The live pacing, kept for scheduling the pull against the beat window.
let currentStart: LotteryStart | undefined;

/**
 * Schedule the pull so the ball reaches the chute exit just before the reveal lands: the bot
 * paces `beat → delayMs → reveal`, so the pull starts at `windowMs - PULL_MS`. Network jitter is
 * fine either way — the ball waits pulsing at the exit, or the reveal fast-forwards past the pull.
 */
function armPull(pick: number, windowMs: number): void {
  if (armedPick === pick) return;
  cancelPull();
  armedPick = pick;
  const lead = Math.max(0, windowMs - PULL_MS - 150);
  pullTimer = setTimeout(() => {
    byId('machine-left').classList.add('pulling');
    byId('chute').classList.add('active');
    // Extraction recoil (#211): the pile reacts to a ball being yanked toward the chute.
    hopper().pulse();
  }, lead);
}

function cancelPull(): void {
  if (pullTimer) {
    clearTimeout(pullTimer);
    pullTimer = null;
  }
  armedPick = null;
  byId('machine-left').classList.remove('pulling');
  byId('chute').classList.remove('active');
}

/** Swap a node for a bare clone — the only way to retrigger its CSS animations. */
function replaceNode(id: string): HTMLElement {
  const old = byId(id);
  const fresh = old.cloneNode(false) as HTMLElement;
  old.replaceWith(fresh);
  return fresh;
}

/**
 * FLIP handoff: the drop ball starts at the chute exit (where the pulled ball just arrived) and
 * springs to its resting spot — the pull and the reveal read as one continuous motion.
 */
function flipFromChute(ball: HTMLElement, from: DOMRect): void {
  // The clone carries the previous reveal's flip/fall classes — strip them so the start
  // transform below is applied instantly, by intent rather than by insertion semantics.
  ball.classList.remove('flip', 'fall');
  const to = ball.getBoundingClientRect();
  if (!to.width || !from.width) {
    ball.classList.add('fall'); // measurement failed — fall back to the plain drop-in
    return;
  }
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.bottom - 7 - (to.top + to.height / 2);
  ball.style.transform = `translate(${dx}px, ${dy}px) scale(.14)`;
  // Double rAF: the start transform must paint before the transition begins.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      ball.classList.add('flip');
      ball.style.transform = '';
    });
  });
}

function renderDrum(pick: number, remaining: string[], windowMs?: number): void {
  show('waiting', false);
  show('stage', true);
  show('drop', false);
  byId('drum').classList.remove('hidden');
  byId('hopper').classList.add('spinning');
  hopper().agitate(true); // the boil (#211); .spinning still shakes the container
  byId('drum-now').textContent = `Drawing pick #${pick}…`;
  armPull(pick, windowMs ?? currentStart?.delayMs ?? 4000);
  const chips = byId('drum-remaining');
  clear(chips);
  for (const team of remaining) chips.appendChild(el('span', 'chip', team));
}

function renderDrop(reveal: LotteryReveal): void {
  show('stage', true);
  byId('hopper').classList.remove('spinning');
  hopper().agitate(false);
  // The drawn team's balls leave the pile — the hopper now shows the live bag for the next draw.
  hopper().removeTeam(reveal.team);
  show('drop', true);
  const rerun = lastDropPick !== reveal.pick;
  lastDropPick = reveal.pick;
  // Measure the chute exit BEFORE tearing down the pull so the handoff starts where it ended.
  const chuteRect = byId('chute').getBoundingClientRect();
  cancelPull();
  // Which ball came out (#211): cosmetic but stable — every viewer, poll repaint, and replay
  // derives the same number from the public commitment. See `drawnBallFor`.
  const range = currentStart
    ? assignBallRanges(currentStart.rows).find((r) => r.team === reveal.team)
    : undefined;
  const ballText =
    range && range.end >= range.start
      ? `ball #${drawnBallFor(currentStart?.commitment ?? '', reveal.pick, range)} · `
      : '';
  const oddsText = `${ballText}${reveal.balls} ball${reveal.balls === 1 ? '' : 's'} · ${reveal.oddsPct.toFixed(1)}% chance at this slot`;
  if (rerun) {
    // Replace the animated nodes to retrigger their CSS animations for this reveal.
    const ball = replaceNode('drop-pick');
    ball.textContent = `#${reveal.pick}`;
    replaceNode('drop-team').textContent = reveal.team;
    replaceNode('drop-odds').textContent = oddsText;
    flipFromChute(ball, chuteRect);
  } else {
    // A polling repaint of an already-shown reveal refreshes text without re-animating.
    byId('drop-pick').textContent = `#${reveal.pick}`;
    byId('drop-team').textContent = reveal.team;
    byId('drop-odds').textContent = oddsText;
  }
  const chips = byId('drum-remaining');
  clear(chips);
  for (const team of reveal.remaining) chips.appendChild(el('span', 'chip', team));
  byId('drum-now').textContent = `Pick #${reveal.pick}: ${reveal.team}!`;
}

// One celebration per finished ceremony — a polling client re-rendering a finished snapshot
// every couple of seconds must not rain confetti forever.
let celebrated = false;

function renderFinish(snapshot: LotterySnapshot): void {
  cancelPull();
  hopper().agitate(false); // stage is leaving the screen; let the pile settle and the loop park
  show('waiting', false);
  show('stage', false);
  if (snapshot.finish) {
    renderFinalBoard(snapshot.finish.order, snapshot.reveals);
  } else {
    renderBoard(snapshot.reveals);
  }
  show('board', true);
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
/** Last phase the server reported — catch-up is only meaningful while a draw is actually running. */
let livePhase: LotteryPhase = 'idle';

/** The context the pure catch-up policy needs, assembled from the running catch-up's state. */
function catchUpContext(): CatchUpContext {
  return {
    known: catchUpKnown,
    ...(catchUpFinish ? { finish: catchUpFinish } : {}),
    ...(catchUpCommitment ? { commitment: catchUpCommitment } : {}),
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

function beginPlayback(mode: PlaybackMode, source: LotterySnapshot): void {
  const timeline = buildReplayTimeline(source);
  if (timeline.length === 0) return;
  playbackMode = mode;
  cursor = createPlaybackCursor(
    toPendingSteps(timeline),
    applyReplayStep,
    () => onPlaybackDrained(mode),
    browserClock,
  );
  replayWindowMs = replayStepMs(source);
  // Playback re-runs the draw from pick one, so the pile must be full again; drops re-empty it.
  const bagRows = source.start?.rows ?? currentStart?.rows;
  if (bagRows) hopper().sync(bagRows, []);
  // Both modes re-arm the finale. A catch-up's `lottery-finish` is buffered and played by
  // `applyReplayStep`, so this *is* the viewer's finale — suppressing it here would mean the one
  // person the feature exists for is the only one who never sees the confetti.
  celebrated = false;
  lastDropPick = null;
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
  if (!source || isPlaying()) return;
  beginPlayback('replay', source);
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
  if (isPlaying() || livePhase !== 'revealing' || reveals.length === 0) return;
  const source: LotterySnapshot = {
    phase: 'revealing',
    reveals: [...reveals],
    ...(currentStart ? { start: currentStart } : {}),
  };
  catchUpKnown = source.reveals.length;
  catchUpFinish = undefined;
  catchUpCommitment = currentStart?.commitment;
  beginPlayback('catchup', source);
}

function stopPlayback(options: { keepPull?: boolean } = {}): void {
  cursor?.stop();
  cursor = null;
  playbackMode = null;
  catchUpCommitment = undefined;
  show('replay-skip', false);
  if (!options.keepPull) cancelPull();
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
  // tabs anyway; parking it outright makes the resume clean and costs nothing.
  hopper().setRunning(!document.hidden);
  if (!cursor || !playbackMode) return;
  if (document.hidden) {
    if (onHiddenAction(playbackMode) === 'pause') {
      cursor.pause();
      // The pull is a CSS animation the browser freezes too; drop it and re-arm on the way back.
      cancelPull();
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
  // Re-arm the pull against what is genuinely left of the drum-roll window. A short remainder is
  // fine: `armPull` clamps its lead to 0, so the ball snaps to the chute and the reveal lands on it.
  const next = cursor.peek();
  const leftMs = cursor.remainingMs();
  cursor.resume();
  if (next?.event.type === 'lottery-reveal') armPull(next.event.reveal.pick, leftMs);
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
    cancelPull();
    // Any exit from a drum-roll must kill the boil: only drop/finish turn it off otherwise, and
    // idle() can never park the sim's loop while agitating — even over an empty pile.
    hopper().agitate(false);
  }
  switch (snapshot.phase) {
    case 'idle':
      setStatus('no ceremony yet');
      show('waiting', true);
      show('stage', false);
      byId('waiting-sub').textContent = 'The commissioner has not opened the stage.';
      // Wipe anything a previous phase painted. This matters more now that a lobby can be armed
      // days before the draw (#198): an api restart, or a `clear` after a cancelled setup, drops
      // an open iframe back to idle, and a leftover odds table under "not opened yet" reads as a
      // live ceremony that no longer exists.
      byId('title').textContent = 'The Lottery Machine';
      byId('commit').textContent = '';
      clear(byId('odds-rows'));
      hopper().sync([], []); // empty the pile — the canvas clears on the next frame
      break;
    case 'lobby':
      // Pre-commitment lobby (#198): show odds without the commitment hash.
      if (snapshot.lobby) renderLobby(snapshot.lobby);
      setStatus('setup complete — draw pending', 'live');
      show('waiting', true);
      show('stage', false);
      break;
    case 'waiting':
      if (snapshot.start) renderWaiting(snapshot.start);
      setStatus('waiting', 'live');
      show('waiting', true);
      show('stage', false);
      break;
    case 'revealing':
      // Drawn teams ride along so the pile reflects the live bag, not the full pre-draw one.
      if (snapshot.start)
        renderWaiting(
          snapshot.start,
          snapshot.reveals.map((r) => r.team),
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
    case 'finished':
      if (snapshot.start) renderWaiting(snapshot.start);
      renderFinish(snapshot);
      break;
    case 'aborted':
      cancelPull();
      // An abort mid-drum-roll arrives with the boil on, and no drop/finish will ever follow to
      // turn it off — without this the sim agitates a hidden pile at 60fps for as long as the
      // iframe stays open on the abort screen.
      hopper().agitate(false);
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
      // Pre-commitment lobby (#198): arm the waiting room from setup onward.
      reveals = [];
      renderSnapshot({ phase: 'lobby', lobby: event.lobby, reveals: [] });
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
      // Keep the "a draw is running ⇒ no sealed result in hand" invariant local to this path
      // rather than resting on `lottery-start` having arrived first: a stale `finishedSnapshot`
      // would route this button's click into a replay of the *previous* lottery.
      finishedSnapshot = null;
      setStatus('live reveal', 'live');
      renderDrum(event.beat.pick, event.beat.remaining);
      break;
    case 'lottery-reveal':
      livePhase = 'revealing';
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
  document.addEventListener('visibilitychange', onVisibilityChange);
  const inDiscord = isDiscordActivity(window.location);
  const base = proxyBase(inDiscord);
  if (inDiscord) {
    try {
      await runHandshake(base);
    } catch (error) {
      setStatus('Discord auth failed', 'err');
      console.error('[lottery] handshake failed', error);
      // Fall through — the reveal is public; still show it even if auth didn't complete.
    }
  }
  connect(base);
}

void boot();
