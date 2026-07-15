/**
 * Pure request routing for the Activity backend. Every route resolves to an {@link HttpReply} value
 * given injected deps, so the whole surface is unit-tested with no socket, no `fetch`, and no
 * lingering handles (the Node-24 native-crash lesson from the bot's server tests). The transport —
 * `node:http` + a WebSocket for push — lives in `server.ts` and just applies these replies.
 *
 * Routes:
 *   GET  /            → the dev dashboard page (served over the Activity proxy in production)
 *   GET  /api/state   → current {@link Envelope} (JSON); the WS pushes the same shape
 *   POST /api/pick    → enter a pick ({ playerName } or an idempotent { picks: [...] } board)
 *   POST /api/reset   → clear the board
 */

import type { DraftPick } from '@fantasy-canon/core';
import { BOARD_HTML } from './board.js';
import type { HubSnapshot } from './hub.js';

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
}

const json = (status: number, value: unknown): HttpReply => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(value),
});

export function routeRequest(
  method: string,
  url: string,
  body: string,
  deps: RouteDeps,
): HttpReply {
  const path = url.split('?')[0];

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    return { status: 200, contentType: 'text/html; charset=utf-8', body: BOARD_HTML };
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
  return json(404, { error: 'not found' });
}

type ParsedPicks = { picks: DraftPick[] } | { error: string };

/**
 * Parse a `POST /api/pick` body. Accepts either a convenience single pick `{ playerName }` (appended
 * at the next overall) or an explicit `{ picks: [{ overall, playerName, teamId? }] }` board (diffed
 * server-side, so it's idempotent). Pure and guarded — untrusted JSON never reaches the session
 * without a name and a finite overall.
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
      if (!pick) return { error: 'each pick needs a playerName and a numeric overall' };
      picks.push(pick);
    }
    return { picks };
  }

  if (typeof rec.playerName === 'string' && rec.playerName.trim()) {
    const overall = typeof rec.overall === 'number' ? rec.overall : nextOverall();
    const teamId = typeof rec.teamId === 'number' ? rec.teamId : 0;
    return { picks: [{ overall, teamId, playerName: rec.playerName.trim() }] };
  }

  return { error: 'body must be { playerName } or { picks: [...] }' };
}

function toPick(raw: unknown): DraftPick | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.playerName !== 'string' || !r.playerName.trim()) return undefined;
  if (typeof r.overall !== 'number' || !Number.isFinite(r.overall)) return undefined;
  const teamId = typeof r.teamId === 'number' ? r.teamId : 0;
  return { overall: r.overall, teamId, playerName: r.playerName.trim() };
}
