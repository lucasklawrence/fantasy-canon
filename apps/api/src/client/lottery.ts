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
  LotteryReveal,
  LotterySnapshot,
  LotteryStart,
} from '../lotteryStage.js';
import { buildReplayTimeline, REPLAY_MAX_STEP_MS, replayStepMs } from './replayTimeline.js';
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

/** The odds table + hopper fill, shared by the lobby (#198) and the committed waiting room. */
function renderOddsTable(
  oddsRows: { team: string; balls: number; firstPct: number; top3Pct: number }[],
  totalBalls: number,
): void {
  const rows = byId('odds-rows');
  clear(rows);
  const maxBalls = Math.max(...oddsRows.map((r) => r.balls), 1);
  for (const row of oddsRows) {
    const tr = el('tr');
    tr.appendChild(el('td', undefined, row.team));
    tr.appendChild(el('td', 'num', String(row.balls)));
    const barCell = el('td');
    const bar = el('span', 'ballbar');
    bar.style.width = `${Math.max(8, Math.round((row.balls / maxBalls) * 90))}px`;
    barCell.appendChild(bar);
    tr.appendChild(barCell);
    tr.appendChild(el('td', 'num', `${row.firstPct.toFixed(1)}%`));
    tr.appendChild(el('td', 'num', `${row.top3Pct.toFixed(1)}%`));
    rows.appendChild(tr);
  }
  fillHopper(totalBalls);
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
  renderOddsTable(lobby.rows, lobby.totalBalls);
}

function renderWaiting(start: LotteryStart): void {
  currentStart = start; // remembered for pull scheduling (delayMs) across later phases
  byId('title').textContent = start.title;
  byId('waiting-sub').textContent =
    `${start.teamCount} teams · ${start.totalBalls} balls in the hopper`;
  byId('commit').textContent = `commitment ${start.commitment.slice(0, 16)}…`;
  renderOddsTable(start.rows, start.totalBalls);
}

/** Cosmetic only — ball positions/timings are random because they represent nothing. */
function fillHopper(totalBalls: number): void {
  const hopper = byId('hopper');
  // Keep the #suck-ball pull element (static markup) — only the decorative balls are rebuilt.
  for (const stale of [...hopper.querySelectorAll('.ball')]) stale.remove();
  const count = Math.min(totalBalls, 48);
  for (let i = 0; i < count; i += 1) {
    // Two keyframe variants + randomized period/size via custom props (see lotteryPage.ts CSS)
    // so the pile reads as physical tumbling, not one synchronized wobble.
    const ball = el('div', i % 2 === 0 ? 'ball' : 'ball alt');
    ball.style.left = `${8 + Math.random() * 75}%`;
    ball.style.top = `${30 + Math.random() * 55}%`;
    ball.style.animationDelay = `${-Math.random() * 1.6}s`;
    ball.style.setProperty('--jig', `${(0.9 + Math.random() * 0.9).toFixed(2)}s`);
    ball.style.setProperty('--s', (0.55 + Math.random() * 0.45).toFixed(2));
    hopper.appendChild(ball);
  }
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
  byId('drum-now').textContent = `Drawing pick #${pick}…`;
  armPull(pick, windowMs ?? currentStart?.delayMs ?? 4000);
  const chips = byId('drum-remaining');
  clear(chips);
  for (const team of remaining) chips.appendChild(el('span', 'chip', team));
}

function renderDrop(reveal: LotteryReveal): void {
  show('stage', true);
  byId('hopper').classList.remove('spinning');
  show('drop', true);
  const rerun = lastDropPick !== reveal.pick;
  lastDropPick = reveal.pick;
  // Measure the chute exit BEFORE tearing down the pull so the handoff starts where it ended.
  const chuteRect = byId('chute').getBoundingClientRect();
  cancelPull();
  const oddsText = `${reveal.balls} ball${reveal.balls === 1 ? '' : 's'} · ${reveal.oddsPct.toFixed(1)}% chance at this slot`;
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
  show('replay-btn', snapshot.reveals.length > 0 || !!snapshot.finish);
  if (!celebrated) {
    celebrated = true;
    confetti();
  }
}

// --- replay (#197): re-run the published reveal locally; live events always win ---

let finishedSnapshot: LotterySnapshot | null = null;
let replayTimers: number[] = [];
let replaying = false;
let replayWindowMs = REPLAY_MAX_STEP_MS;

function sameFinish(a: LotteryFinish | undefined, b: LotteryFinish | undefined): boolean {
  return (
    !!a &&
    !!b &&
    a.verify.commitment === b.verify.commitment &&
    JSON.stringify(a.order) === JSON.stringify(b.order)
  );
}

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
      setStatus('replaying the reveal', 'live');
      break;
    case 'lottery-reveal':
      reveals.push(event.reveal);
      renderDrop(event.reveal);
      renderBoard(reveals);
      break;
    case 'lottery-finish':
      // End the replay first so renderFinish paints the sealed state (status, confetti) normally.
      stopReplay();
      renderFinish({ phase: 'finished', reveals, finish: event.finish });
      break;
    default:
      break;
  }
}

function startReplay(): void {
  const source = finishedSnapshot;
  if (!source || replaying) return;
  const timeline = buildReplayTimeline(source);
  if (timeline.length === 0) return;
  replaying = true;
  replayWindowMs = replayStepMs(source);
  celebrated = false; // the finale deserves its confetti again
  lastDropPick = null;
  reveals = [];
  show('board', false);
  show('verify', false);
  show('waiting', false);
  show('replay-btn', false);
  show('replay-skip', true);
  show('stage', true);
  show('drop', false);
  setStatus('replaying the reveal', 'live');
  for (const step of timeline) {
    replayTimers.push(window.setTimeout(() => applyReplayStep(step.event), step.atMs));
  }
}

function stopReplay(): void {
  for (const timer of replayTimers) clearTimeout(timer);
  replayTimers = [];
  replaying = false;
  show('replay-skip', false);
  cancelPull();
}

/** Skip straight back to the sealed final state (the "final state wins" control). */
function skipReplay(): void {
  const source = finishedSnapshot;
  if (!source) return;
  stopReplay();
  celebrated = true; // skipping isn't a finale moment — no second confetti burst
  reveals = [...source.reveals];
  renderSnapshot(source);
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
      // Only the decorative balls — `#suck-ball` is static markup the pull animation needs, and
      // `byId` throws if it's gone (same reason `fillHopper` removes selectively).
      for (const stale of [...byId('hopper').querySelectorAll('.ball')]) stale.remove();
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
      if (snapshot.start) renderWaiting(snapshot.start);
      setStatus('live reveal', 'live');
      renderBoard(snapshot.reveals);
      if (snapshot.pendingBeat) {
        renderDrum(snapshot.pendingBeat.pick, snapshot.pendingBeat.remaining);
      } else if (snapshot.reveals.length > 0) {
        renderDrop(snapshot.reveals[snapshot.reveals.length - 1]);
      }
      break;
    case 'finished':
      if (snapshot.start) renderWaiting(snapshot.start);
      renderFinish(snapshot);
      break;
    case 'aborted':
      cancelPull();
      show('waiting', false);
      show('stage', false);
      show('abort', true);
      byId('abort-reason').textContent = snapshot.abort?.reason ?? 'The ceremony was aborted.';
      setStatus('aborted', 'err');
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
      setStatus('live reveal', 'live');
      renderDrum(event.beat.pick, event.beat.remaining);
      break;
    case 'lottery-reveal':
      reveals.push(event.reveal);
      renderDrop(event.reveal);
      renderBoard(reveals);
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
      if (replaying) {
        // An identical finished snapshot is just the fallback repainting — the replay runs on.
        if (snapshot.phase === 'finished' && sameFinish(snapshot.finish, finishedSnapshot?.finish))
          return;
        stopReplay(); // anything else is real news, and live state wins
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
      if (replaying) {
        if (isReplayEcho(event)) return; // same finished ceremony — the replay runs on
        stopReplay(); // anything else is real news, and live events win
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
  byId('replay-btn').addEventListener('click', startReplay);
  byId('replay-skip').addEventListener('click', skipReplay);
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
