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
import {
  createPlaybackCursor,
  onHiddenAction,
  type PlaybackClock,
  type PlaybackCursor,
  type PlaybackMode,
} from './playbackCursor.js';
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
} from './replayTimeline.js';
import { configuredMaxTeamBalls, runHandshake } from './sdk.js';
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

// The race (#235). Same lazy pattern; only the ceremony's active visual ever instantiates its sim,
// so a machine ceremony never pays for lanes and a race never boils an invisible pile.
let raceSim: RaceSim | null = null;
function race(): RaceSim {
  if (!raceSim) raceSim = createRaceSim(byId('race-canvas') as HTMLCanvasElement, teamLogo);
  return raceSim;
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
      // broadcast: the odds table repaints, the race refaces in place (its `sync` no-ops on an
      // unchanged bag), and a drop ball on screen re-dresses.
      if (currentLobby) repaintLobbyEdits();
      raceSim?.reface();
      redressDropBall();
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

/** The face the drop ball currently wears, so a late-decoding logo can re-dress it (#242). */
let lastDropFace: { team: string; hue: number | undefined } | null = null;

/**
 * Dress the big drop ball (#242): the team's logo cover-fit over the hue face when we have it
 * (the gradient shows as a rim and behind transparent artwork), today's plain face otherwise.
 * The `#N` text stays either way — the ball number is the auditable link to the commitment.
 */
function applyDropFace(ball: HTMLElement, team: string, hue: number | undefined): void {
  lastDropFace = { team, hue };
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

/**
 * The ceremony's reveal visualization (#235), fixed by `start` so every viewer renders the same
 * spectacle. The lobby has no start yet — it always shows the machine's loaded hopper.
 */
function activeVisual(): 'machine' | 'race' {
  return currentStart?.visual === 'race' ? 'race' : 'machine';
}

/** Swap the stage's left panel to match the active visual: hopper+chute, or the racetrack. */
function applyStageLayout(): void {
  const racing = activeVisual() === 'race';
  show('hopper', !racing);
  show('chute', !racing);
  show('racetrack', racing);
  // The wide-page mode rides the same switch (#239): race mode takes the monitor's spare width
  // for the track; the machine (and every pre-ceremony phase) keeps the cozy centered frame.
  document.body.classList.toggle('race', racing);
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
  if (activeVisual() === 'race') {
    race().sync(oddsRows, drawn);
    // Don't leave the machine simulating behind a hidden panel — but never *create* it for this.
    hopperSim?.sync([], []);
  } else {
    hopper().sync(
      oddsRows,
      drawn.map((entry) => entry.team),
    );
    raceSim?.sync([], []);
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
/** Server-truth "a seal-and-start is pending" (#233) — same broadcast-driven discipline. */
let beginPending = false;

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
  // No timer (#227): an accepted request broadcasts `reimportRequested`, and the button tracks
  // that flag through `renderLobby` until the bot's re-arm clears it — disabled for exactly as
  // long as an import is genuinely pending. Only a rejected/failed POST re-enables here, since
  // no broadcast will.
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
  button.disabled = true;
  setStatus('sealing the bag…', 'live');
  const accepted = await commissionerPost(
    '/api/lottery/begin',
    { delaySeconds, direction, visual },
    (status) => (status === 409 ? 'the lobby changed — begin rejected' : 'begin rejected'),
  );
  if (!accepted) button.disabled = false;
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
  show('edit-hint', commissioner && !beginPending);
  // Re-import only makes sense for an ESPN-backed ceremony, but the client can't tell — the bot
  // refuses a manual `teams:` setup server-side and says so.
  show('edit-actions', commissioner);
  show('begin-actions', commissioner);
  // The buttons follow the broadcast, not a timer (#227): each flag is set the moment its request
  // is accepted and cleared when the bot's re-arm or `start` replaces the lobby — the exact
  // lifetime of "that work is actually pending". Every viewer's snapshot agrees, so late joiners
  // see the true state too. The two block each other (#233): a re-import replaces the very bag a
  // seal would commit, and a seal makes a refetch moot.
  (byId('reimport-btn') as HTMLButtonElement).disabled = reimportPending || beginPending;
  (byId('begin-btn') as HTMLButtonElement).disabled = beginPending || reimportPending;
  (byId('begin-delay') as HTMLSelectElement).disabled = beginPending;
  (byId('begin-direction') as HTMLSelectElement).disabled = beginPending;
  (byId('begin-visual') as HTMLSelectElement).disabled = beginPending;
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

function renderWaiting(start: LotteryStart, drawn: { pick: number; team: string }[] = []): void {
  currentStart = start; // remembered for pull scheduling (delayMs) across later phases
  // The commitment binds the bag: past this point nothing on screen is editable, so drop the
  // lobby we were holding and retract the offer (#210) — the seal controls with it (#233), or a
  // slash-started draw would leave a live-looking begin button on the waiting screen.
  currentLobby = undefined;
  show('edit-hint', false);
  show('edit-actions', false);
  show('begin-actions', false);
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
/** Tube descent duration; a fixed timer rather than animationend so it settles even when hidden. */
const TUBE_MS = 420;
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
  tube.classList.remove('transit');
  tube.style.background = '';
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
  applyStageLayout();
  byId('drum-now').textContent = `Drawing pick #${pick}…`;
  const win = windowMs ?? currentStart?.delayMs ?? 4000;
  if (activeVisual() === 'race') {
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
): Promise<void> {
  const token = ++choreoToken;
  exitInFlight = reveal.pick;
  // Glow through the exit even when the reveal outran the glow's lead timer.
  byId('chute').classList.add('active');
  // The extraction resolves from the sim's rAF loop — which never runs in a hidden tab. The race
  // keeps the reveal bounded regardless: setTimeout fires even hidden (clamped, but it fires), so
  // a backgrounded viewer still has the correct drop state waiting when they return.
  const flew =
    num !== null
      ? await Promise.race([
          hopper().extractBall(num),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1800)),
        ])
      : false;
  if (token !== choreoToken) return;
  if (flew) {
    const tube = byId('tube-ball');
    if (hue !== undefined) tube.style.background = ballFace(hue);
    tube.classList.remove('transit');
    void tube.offsetWidth; // restart the CSS animation for this transit
    tube.classList.add('transit');
    await new Promise((resolve) => setTimeout(resolve, TUBE_MS));
    if (token !== choreoToken) return;
  }
  exitInFlight = null;
  // Measure the chute exit BEFORE tearing the transit down — the FLIP starts where the tube ends.
  const chuteRect = byId('chute').getBoundingClientRect();
  const tube = byId('tube-ball');
  tube.classList.remove('transit');
  tube.style.background = '';
  byId('chute').classList.remove('active');
  show('drop', true);
  const ball = replaceNode('drop-pick');
  ball.textContent = num !== null ? `#${num}` : `#${reveal.pick}`;
  // The clone carries the previous reveal's inline tint — set or clear it explicitly.
  applyDropFace(ball, reveal.team, num !== null ? hue : undefined);
  replaceNode('drop-team').textContent = reveal.team;
  replaceNode('drop-odds').textContent = oddsText;
  flipFromChute(ball, chuteRect);
}

function renderDrop(reveal: LotteryReveal): void {
  show('stage', true);
  applyStageLayout();
  const rerun = lastDropPick !== reveal.pick;
  lastDropPick = reveal.pick;
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
    void runExitChoreography(reveal, num, range?.hue, oddsText);
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

function renderFinish(snapshot: LotterySnapshot): void {
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
  audio.stopRoll(); // a finish can land mid-roll (a skip, or a finish with no drop before it)
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

function beginPlayback(mode: PlaybackMode, source: LotterySnapshot): void {
  const timeline = buildReplayTimeline(source);
  if (timeline.length === 0) return;
  playbackMode = mode;
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
    if (activeVisual() === 'race') race().sync(bagRows, []);
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
    applyStageLayout();
    audio.stopRoll();
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
      // No lobby ⇒ nothing to edit (#210); the stage refuses adjustments in this phase anyway.
      currentLobby = undefined;
      show('edit-hint', false);
      show('edit-actions', false);
      show('begin-actions', false);
      hopperSim?.sync([], []); // empty the pile — the canvas clears on the next frame
      // An idle stage means an api restart or a cleared lobby — either way the armedSeq space
      // may reset (#232), so forget everything commissioner-related and let the next lobby's
      // check start from scratch rather than trust sequence numbers across a process boundary.
      seenArmedSeq = undefined;
      commissioner = false;
      commissionerCheck = null;
      break;
    case 'lobby':
      // Pre-commitment lobby (#198): show odds without the commitment hash.
      reimportPending = snapshot.reimportRequested === true;
      beginPending = snapshot.beginRequested !== undefined;
      if (snapshot.lobby) renderLobby(snapshot.lobby);
      setStatus(
        beginPending ? 'sealing the bag — draw starting…' : 'setup complete — draw pending',
        'live',
      );
      show('waiting', true);
      show('stage', false);
      break;
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
        ...(event.beginRequested ? { beginRequested: event.beginRequested } : {}),
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
  byId('reimport-btn').addEventListener('click', () => void sendReimport());
  byId('begin-btn').addEventListener('click', () => void sendBegin());
  byId('sound-btn').addEventListener('click', () => audio.toggle());
  document.addEventListener('visibilitychange', onVisibilityChange);
  const inDiscord = isDiscordActivity(window.location);
  const base = proxyBase(inDiscord);
  activityBase = base;
  if (inDiscord) {
    try {
      ({ accessToken } = await runHandshake(base));
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
