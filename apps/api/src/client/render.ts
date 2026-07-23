/**
 * The dashboard's DOM render (#127 Phase 2). Ported from the former inline board script into the
 * bundled client so dev and the in-Discord Activity share one implementation. Pure view → DOM: it
 * reads the {@link AdviceView} projection the backend pushes and paints the page containers defined
 * in `board.ts`.
 *
 * This is browser-only (touches `document`) and, like #156's Playwright reader, is the deliberately
 * un-unit-tested shell — the testable logic (transport base/proxy math, token parsing) lives in
 * pure modules. It is typed against core's real `AdviceView`/`CandidateView` (erased at bundle time)
 * so a projection change surfaces here at typecheck.
 */

// Deep type-only import from core's pure advice module: importing the `@fantasy-canon/core` barrel
// would drag in `draftOrder` (which uses `node:crypto`) and force Node types into this DOM-only
// browser program. These types are erased at bundle time.
import type { AdviceView, CandidateView } from '@fantasy-canon/core/draft/advice.js';

/** The envelope the backend serves at `/api/state` and pushes over the WebSocket. */
export interface BoardState {
  view?: AdviceView;
  status?: string;
  updatedAt?: string;
}

type StatusKind = 'live' | 'err' | undefined;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
}

function adpStr(c: CandidateView): string {
  return c.adp != null ? `ADP ${Math.round(c.adp)}` : 'no ADP';
}

function tierStr(c: CandidateView): string {
  return c.tier != null ? `Tier ${c.tier}` : '';
}

function candRow(c: CandidateView): HTMLElement {
  const r = el('div', 'row');
  r.appendChild(el('span', `pos ${c.position}`, c.position));
  r.appendChild(el('span', 'nm', c.name));
  r.appendChild(el('span', `tag ${c.recommend}`, c.recommend));
  const sub = [tierStr(c), adpStr(c)].filter(Boolean).join(' · ');
  r.appendChild(el('span', 'sub', sub));
  return r;
}

export function setStatus(text: string, kind?: StatusKind): void {
  const s = byId('status');
  s.textContent = text;
  s.className = 'pill' + (kind ? ' ' + kind : '');
}

function fill<T>(
  id: string,
  items: T[] | undefined,
  mk: (it: T) => HTMLElement,
  empty: string,
): void {
  const node = byId(id);
  clear(node);
  if (!items || items.length === 0) {
    node.appendChild(el('div', 'empty', empty));
    return;
  }
  items.forEach((it) => node.appendChild(mk(it)));
}

/** Paint the whole board from a fresh state envelope. */
export function renderState(state: BoardState): void {
  const v = state.view;
  if (!v) {
    setStatus(state.status ?? 'waiting', 'err');
    byId('turn').textContent = state.status ?? 'Waiting for the draft…';
    return;
  }
  setStatus(v.complete ? 'draft complete' : (state.status ?? 'watching draft'), 'live');

  const clock = byId('clock');
  clear(clock);
  const line1 = el('div');
  line1.append(
    `Round `,
    strong(String(v.round)),
    ` · Pick `,
    strong(String(v.pickInRound)),
    ` · Overall `,
    strong(String(v.currentOverall)),
  );
  clock.appendChild(line1);
  clock.appendChild(el('div', undefined, `${v.remaining} players left · pool ${v.poolSize}`));

  const turn = byId('turn');
  clear(turn);
  turn.className = 'turn' + (v.isMyPick ? ' mine' : '');
  if (v.isMyPick) {
    turn.append(strong("You're on the clock"), ` — pick ${v.currentOverall}.`);
  } else if (v.myNextOverall != null) {
    const until = v.picksUntilMine;
    const inTxt = until != null ? ` (in ${until} pick${until === 1 ? '' : 's'})` : '';
    turn.append(
      `Slot `,
      strong(String(v.onTheClockSlot)),
      ` on the clock. Your next pick: overall `,
      strong(String(v.myNextOverall)),
      inTxt,
    );
  } else {
    turn.append(`Slot `, strong(String(v.onTheClockSlot)), ` on the clock. No more picks for you.`);
  }

  const rec = byId('rec');
  clear(rec);
  if (v.recommended) {
    const c = v.recommended;
    const head = el('div');
    head.appendChild(el('span', `pos ${c.position}`, c.position));
    head.appendChild(el('span', 'name', ` ${c.name}`));
    head.appendChild(el('span', `tag ${c.recommend}`, ` ${c.recommend}`));
    rec.appendChild(head);
    rec.appendChild(
      el('div', 'meta', [tierStr(c), adpStr(c), `VONA ${c.vona}`].filter(Boolean).join(' · ')),
    );
    rec.appendChild(el('div', 'reason', c.reason));
  } else {
    rec.appendChild(el('div', 'empty', 'No players left on the board.'));
  }

  fill('alts', v.alternatives, candRow, 'No alternatives.');
  fill(
    'byneed',
    (v.byNeed ?? []).map((x) => x.candidate),
    candRow,
    'Skill starters filled.',
  );

  const needs = byId('needs');
  clear(needs);
  if (!v.needs || v.needs.length === 0) {
    needs.appendChild(el('span', 'need none', 'Skill starters set'));
  } else {
    v.needs.forEach((p) => needs.appendChild(el('span', 'need', p)));
  }

  fill(
    'roster',
    v.myRoster,
    (spot) => {
      const r = el('div', 'row');
      r.appendChild(el('span', `pos ${spot.position}`, spot.position));
      r.appendChild(el('span', 'nm', spot.name));
      r.appendChild(el('span', 'sub', `#${spot.overall}`));
      return r;
    },
    'No picks yet.',
  );

  fill(
    'recent',
    v.recentPicks,
    (p) => {
      const r = el('div', 'row' + (p.mine ? ' mine' : ''));
      r.appendChild(el('span', 'ov', `#${p.overall}`));
      r.appendChild(el('span', 'nm', p.name));
      r.appendChild(el('span', 'sub', `slot ${p.slot}`));
      return r;
    },
    'No picks entered yet.',
  );

  const meta = byId('meta');
  const bits: string[] = [];
  if (v.adp) bits.push(`ADP ${v.adp.asOf} (${v.adp.sampleSize} drafts)`);
  if (state.updatedAt) bits.push(`updated ${new Date(state.updatedAt).toLocaleTimeString()}`);
  meta.textContent = bits.join('  ·  ');
}

function strong(text: string): HTMLElement {
  return el('b', undefined, text);
}

/** Wire the manual-entry form + reset button to the given handlers (dev / standalone board). */
export function wireControls(handlers: {
  onPick: (name: string) => void;
  onReset: () => void;
}): void {
  const form = byId('entry') as HTMLFormElement;
  const input = byId('playerName') as HTMLInputElement;
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    handlers.onPick(name);
    input.value = '';
    input.focus();
  });
  byId('reset').addEventListener('click', () => handlers.onReset());
}
