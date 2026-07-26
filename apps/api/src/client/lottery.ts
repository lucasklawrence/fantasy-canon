/**
 * Browser entry for the lottery machine (#169), bundled by esbuild to `dist/client/lottery.js`
 * and loaded by the shell in `lotteryPage.ts`.
 *
 * Pure presentation: every state change arrives from the backend stage (WS push, polling
 * fallback), which the bot paces — this client never draws, times, or decides anything. It
 * renders the full drama: waiting-room odds table → hopper spin + drum-roll → ball drop with a
 * per-pick odds flash → the growing order board → final board + seed-verify panel (or the abort
 * banner). Inside Discord it runs the shared SDK handshake and `/.proxy` transport; standalone
 * (dev) it skips the SDK — same split as the draft board client.
 */

import type {
  LotteryEvent,
  LotteryReveal,
  LotterySnapshot,
  LotteryStart,
} from '../lotteryStage.js';
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

function renderWaiting(start: LotteryStart): void {
  byId('title').textContent = start.title;
  byId('waiting-sub').textContent =
    `${start.teamCount} teams · ${start.totalBalls} balls in the hopper`;
  byId('commit').textContent = `commitment ${start.commitment.slice(0, 16)}…`;
  const rows = byId('odds-rows');
  clear(rows);
  const maxBalls = Math.max(...start.rows.map((r) => r.balls), 1);
  for (const row of start.rows) {
    const tr = el('tr');
    tr.appendChild(el('td', undefined, row.team));
    const balls = el('td', 'num', String(row.balls));
    tr.appendChild(balls);
    const barCell = el('td');
    const bar = el('span', 'ballbar');
    bar.style.width = `${Math.max(8, Math.round((row.balls / maxBalls) * 90))}px`;
    barCell.appendChild(bar);
    tr.appendChild(barCell);
    tr.appendChild(el('td', 'num', `${row.firstPct.toFixed(1)}%`));
    tr.appendChild(el('td', 'num', `${row.top3Pct.toFixed(1)}%`));
    rows.appendChild(tr);
  }
  fillHopper(start.totalBalls);
}

/** Cosmetic only — ball positions/timings are random because they represent nothing. */
function fillHopper(totalBalls: number): void {
  const hopper = byId('hopper');
  clear(hopper);
  const count = Math.min(totalBalls, 36);
  for (let i = 0; i < count; i += 1) {
    const ball = el('div', 'ball');
    ball.style.left = `${8 + Math.random() * 75}%`;
    ball.style.top = `${35 + Math.random() * 50}%`;
    ball.style.animationDelay = `${-Math.random() * 1.2}s`;
    const scale = 0.7 + Math.random() * 0.5;
    ball.style.transform = `scale(${scale})`;
    hopper.appendChild(ball);
  }
}

function renderDrum(pick: number, remaining: string[]): void {
  show('waiting', false);
  show('stage', true);
  show('drop', false);
  byId('drum').classList.remove('hidden');
  byId('hopper').classList.add('spinning');
  byId('drum-now').textContent = `Drawing pick #${pick}…`;
  const chips = byId('drum-remaining');
  clear(chips);
  for (const team of remaining) chips.appendChild(el('span', 'chip', team));
}

function renderDrop(reveal: LotteryReveal): void {
  show('stage', true);
  byId('hopper').classList.remove('spinning');
  show('drop', true);
  // Re-trigger the CSS drop animation for every reveal by replacing the ball node.
  const oldBall = byId('drop-pick');
  const fresh = oldBall.cloneNode(false) as HTMLElement;
  oldBall.replaceWith(fresh);
  fresh.textContent = `#${reveal.pick}`;
  byId('drop-team').textContent = reveal.team;
  byId('drop-odds').textContent =
    `${reveal.balls} ball${reveal.balls === 1 ? '' : 's'} · ${reveal.oddsPct.toFixed(1)}% chance at this slot`;
  const chips = byId('drum-remaining');
  clear(chips);
  for (const team of reveal.remaining) chips.appendChild(el('span', 'chip', team));
  byId('drum-now').textContent = `Pick #${reveal.pick}: ${reveal.team}!`;
}

// One celebration per finished ceremony — a polling client re-rendering a finished snapshot
// every couple of seconds must not rain confetti forever.
let celebrated = false;

function renderFinish(snapshot: LotterySnapshot): void {
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
  if (!celebrated) {
    celebrated = true;
    confetti();
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
  // A fresh phase repaints from scratch: hide the sections a previous run may have left visible
  // (a re-run start after a finished/aborted ceremony must not show stale board/verify/abort),
  // and re-arm the one-shot celebration.
  if (snapshot.phase === 'idle' || snapshot.phase === 'waiting') {
    show('board', false);
    show('verify', false);
    show('abort', false);
    celebrated = false;
  }
  switch (snapshot.phase) {
    case 'idle':
      setStatus('no ceremony yet');
      show('waiting', true);
      show('stage', false);
      byId('waiting-sub').textContent = 'The commissioner has not opened the stage.';
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
