/**
 * Pure request routing for the Activity backend. Every route resolves to an {@link HttpReply} value
 * given injected deps, so the whole surface is unit-tested with no socket, no real `fetch`, and no
 * lingering handles (the Node-24 native-crash lesson from the bot's server tests). The transport —
 * `node:http` + a WebSocket for push — lives in `server.ts` and just applies these replies.
 *
 * Routes (each also matches under a leading `/.proxy` — see {@link normalizePath}):
 *   GET  /                   → the dashboard page shell (loads the bundled client)
 *   GET  /client/activity.js → the esbuild browser bundle (503 until `build:client` has run)
 *   GET  /api/state          → current {@link Envelope} (JSON); the WS pushes the same shape
 *   POST /api/pick           → enter a pick ({ playerName } or an idempotent { picks: [...] } board)
 *   POST /api/reset          → clear the board
 *   POST /api/token          → exchange the SDK's OAuth code for an access token (server-side secret)
 *
 * `routeRequest` is async solely because the token exchange is; the `exchangeToken` dep is injected
 * so tests never touch the network.
 */

import type { DraftPick } from '@fantasy-canon/core';
import { boardHtml } from './board.js';
import type { HubSnapshot } from './hub.js';
import { lotteryHtml } from './lotteryPage.js';
import {
  parseLotteryAbort,
  parseLotteryBeat,
  parseLotteryFinish,
  parseLotteryReveal,
  parseLotteryStart,
  StageBusyError,
  type LotteryStage,
} from './lotteryStage.js';
import { parseTokenRequest } from './token.js';

/** The snapshot plus a server-stamped timestamp — what `/api/state` and the WS push both carry. */
export interface Envelope extends HubSnapshot {
  updatedAt: string;
}

export interface HttpReply {
  status: number;
  contentType: string;
  body: string;
}

export interface RouteDeps {
  getEnvelope: () => Envelope;
  ingest: (picks: DraftPick[]) => { added: DraftPick[]; picks: number };
  nextOverall: () => number;
  reset: () => void;
  /** Discord application (client) id injected into the page for the SDK; `''` in dev / standalone. */
  clientId: string;
  /** The built browser bundle (`dist/client/activity.js`), or `undefined` if `build:client` hasn't run. */
  clientScript: () => string | undefined;
  /** Exchange an OAuth code for an access token (server-side; injected so tests use a stub). */
  exchangeToken: (code: string) => Promise<{ accessToken: string }>;
  /** The lottery-machine reveal stage the bot paces via `POST /api/lottery/*` (#169). */
  lottery: LotteryStage;
  /** The lottery client bundle (`dist/client/lottery.js`), or `undefined` if `build:client` hasn't run. */
  lotteryScript: () => string | undefined;
  /**
   * Shared secret the bot must send as `x-stage-key` on lottery POSTs. Empty ⇒ open (dev: the
   * server binds 127.0.0.1). Set it in production — the mapped host is publicly reachable.
   */
  stageKey: string;
}

const json = (status: number, value: unknown): HttpReply => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(value),
});

/**
 * Strip the query string and a single leading `/.proxy` segment. Inside a Discord Activity every
 * request is proxied under `{clientId}.discordsays.com/.proxy/…`; depending on the portal URL
 * mapping the backend may see that prefix, so the router accepts a route with or without it.
 */
export function normalizePath(url: string): string {
  const path = url.split('?')[0];
  if (path === '/.proxy' || path === '/.proxy/') return '/';
  if (path.startsWith('/.proxy/')) return path.slice('/.proxy'.length);
  return path;
}

export async function routeRequest(
  method: string,
  url: string,
  body: string,
  deps: RouteDeps,
  headers: Record<string, string | string[] | undefined> = {},
): Promise<HttpReply> {
  const path = normalizePath(url);

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    return { status: 200, contentType: 'text/html; charset=utf-8', body: boardHtml(deps.clientId) };
  }
  if (method === 'GET' && path === '/lottery') {
    return {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: lotteryHtml(deps.clientId),
    };
  }
  if (method === 'GET' && (path === '/client/activity.js' || path === '/client/lottery.js')) {
    const script = path === '/client/lottery.js' ? deps.lotteryScript() : deps.clientScript();
    if (script === undefined) {
      return {
        status: 503,
        contentType: 'text/plain; charset=utf-8',
        body: '// client bundle missing — run `pnpm -C apps/api run build:client`',
      };
    }
    return { status: 200, contentType: 'text/javascript; charset=utf-8', body: script };
  }
  if (path.startsWith('/api/lottery/')) {
    return lotteryRoute(method, path, body, deps, headers);
  }
  if (method === 'GET' && path === '/api/state') {
    return json(200, deps.getEnvelope());
  }
  if (method === 'POST' && path === '/api/pick') {
    const parsed = parsePickBody(body, deps.nextOverall);
    if ('error' in parsed) return json(400, { error: parsed.error });
    const result = deps.ingest(parsed.picks);
    return json(200, { added: result.added.length, picks: result.picks });
  }
  if (method === 'POST' && path === '/api/reset') {
    deps.reset();
    return json(200, { ok: true });
  }
  if (method === 'POST' && path === '/api/token') {
    const parsed = parseTokenRequest(body);
    if ('error' in parsed) return json(400, { error: parsed.error });
    try {
      const { accessToken } = await deps.exchangeToken(parsed.code);
      return json(200, { access_token: accessToken });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json(502, { error: message });
    }
  }
  return json(404, { error: 'not found' });
}

/**
 * `/api/lottery/*` — the bot-paced reveal stage (#169).
 *
 *   GET  /api/lottery/state   → {@link LotterySnapshot} (public — it's the shared presentation)
 *   POST /api/lottery/start   → open the stage (bot only)
 *   POST /api/lottery/beat    → drum-roll for the next pick (bot only)
 *   POST /api/lottery/reveal  → the ball drop (bot only)
 *   POST /api/lottery/finish  → final order + seed-reveal verify info (bot only)
 *   POST /api/lottery/abort   → the ceremony aborted (bot only)
 *
 * Bot-only routes require the `x-stage-key` header to match the configured key. With no key
 * configured they are open — acceptable only on the loopback dev bind; production must set one.
 */
function lotteryRoute(
  method: string,
  path: string,
  body: string,
  deps: RouteDeps,
  headers: Record<string, string | string[] | undefined>,
): HttpReply {
  if (method === 'GET' && path === '/api/lottery/state') {
    return json(200, deps.lottery.snapshot());
  }
  if (method !== 'POST') return json(404, { error: 'not found' });

  if (deps.stageKey) {
    const sent = headers['x-stage-key'];
    if (typeof sent !== 'string' || sent !== deps.stageKey) {
      return json(401, { error: 'missing or bad x-stage-key' });
    }
  }

  switch (path) {
    case '/api/lottery/start': {
      const parsed = parseLotteryStart(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      try {
        deps.lottery.start(parsed.value);
      } catch (error) {
        // Another guild's ceremony is armed/live — the caller's bot falls back to its
        // in-channel reveal rather than interleaving two ceremonies on shared screens.
        if (error instanceof StageBusyError) return json(409, { error: error.message });
        throw error;
      }
      return json(200, { ok: true });
    }
    case '/api/lottery/beat': {
      const parsed = parseLotteryBeat(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      deps.lottery.beat(parsed.value);
      return json(200, { ok: true });
    }
    case '/api/lottery/reveal': {
      const parsed = parseLotteryReveal(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      deps.lottery.reveal(parsed.value);
      return json(200, { ok: true });
    }
    case '/api/lottery/finish': {
      const parsed = parseLotteryFinish(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      deps.lottery.finish(parsed.value);
      return json(200, { ok: true });
    }
    case '/api/lottery/abort': {
      const parsed = parseLotteryAbort(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      deps.lottery.abort(parsed.value);
      return json(200, { ok: true });
    }
    default:
      return json(404, { error: 'not found' });
  }
}

type ParsedPicks = { picks: DraftPick[] } | { error: string };

/**
 * Parse a `POST /api/pick` body. Accepts either a convenience single pick `{ playerName }` (appended
 * at the next overall) or an explicit `{ picks: [{ overall, playerName, teamId? }] }` board (diffed
 * server-side, so it's idempotent). Pure and guarded — untrusted JSON never reaches the session
 * without a name and a 1-based integer overall.
 */
export function parsePickBody(body: string, nextOverall: () => number): ParsedPicks {
  let data: unknown;
  try {
    data = JSON.parse(body || '{}');
  } catch {
    return { error: 'invalid JSON body' };
  }
  if (typeof data !== 'object' || data === null) {
    return { error: 'body must be { playerName } or { picks: [...] }' };
  }
  const rec = data as Record<string, unknown>;

  if (Array.isArray(rec.picks)) {
    const rawList = rec.picks as unknown[];
    const picks: DraftPick[] = [];
    for (const raw of rawList) {
      const pick = toPick(raw);
      if (!pick) return { error: 'each pick needs a playerName and a positive-integer overall' };
      picks.push(pick);
    }
    return { picks };
  }

  if (typeof rec.playerName === 'string' && rec.playerName.trim()) {
    // An explicit overall must honour the same 1-based integer contract; otherwise take the next slot.
    let overall: number;
    if (typeof rec.overall === 'number') {
      if (!Number.isInteger(rec.overall) || rec.overall < 1) {
        return { error: 'overall must be a positive (1-based) integer' };
      }
      overall = rec.overall;
    } else {
      overall = nextOverall();
    }
    const teamId = typeof rec.teamId === 'number' ? rec.teamId : 0;
    return { picks: [{ overall, teamId, playerName: rec.playerName.trim() }] };
  }

  return { error: 'body must be { playerName } or { picks: [...] }' };
}

function toPick(raw: unknown): DraftPick | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.playerName !== 'string' || !r.playerName.trim()) return undefined;
  // overall is a 1-based draft slot: reject non-numbers, non-integers, and anything < 1.
  if (typeof r.overall !== 'number' || !Number.isInteger(r.overall) || r.overall < 1) {
    return undefined;
  }
  const teamId = typeof r.teamId === 'number' ? r.teamId : 0;
  return { overall: r.overall, teamId, playerName: r.playerName.trim() };
}
