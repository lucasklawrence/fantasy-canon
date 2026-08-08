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
  parseLotteryAdjust,
  parseLotteryAdjustAll,
  parseLotteryAuditMode,
  parseLotteryBegin,
  parseLotteryBeat,
  parseLotteryClear,
  parseLotteryFinish,
  parseLotteryLobby,
  parseLotteryRename,
  parseLotteryReveal,
  parseLotterySetupRelease,
  parseLotterySetupRequest,
  parseLotteryStart,
  DuplicateTeamNameError,
  StageBusyError,
  StageNotEditableError,
  UnknownTeamError,
  type LotteryStage,
} from './lotteryStage.js';
import { parseBearerToken, parseTokenRequest, type DiscordUser } from './token.js';

/** The snapshot plus a server-stamped timestamp — what `/api/state` and the WS push both carry. */
export interface Envelope extends HubSnapshot {
  updatedAt: string;
}

export interface HttpReply {
  status: number;
  contentType: string;
  body: string;
  /**
   * Raw bytes for binary replies — the logo proxy (#242). Wins over `body` when set; kept as a
   * separate field so every existing `JSON.parse(reply.body)` consumer keeps its string.
   */
  bodyBytes?: Buffer;
  /**
   * Override for the `Cache-Control` header. Default is `no-store` (state must never go stale);
   * the logo proxy opts into caching — a team's logo is stable for a ceremony's lifetime, and the
   * odds table repaints on every broadcast.
   */
  cacheControl?: string;
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
  /**
   * Resolve an access token to its Discord user, server-side (#210). The commissioner check is
   * only as trustworthy as this call — never derive the caller's id from the request body.
   */
  identify: (accessToken: string) => Promise<DiscordUser>;
  /**
   * Sink for client-reported diagnostics (#231) — the Activity iframe's console is unreachable
   * from the operator's machine, so handshake failures beacon here. Log-only, never stored.
   */
  clientLog?: (message: string) => void;
  /**
   * Fetch a team-logo image for the same-origin proxy (#242). Injected so tests never hit the
   * network; `null` for anything that isn't a usable image (bad status, wrong content type, too
   * big, timeout). Omitted ⇒ the logo route 404s and clients fall back to hue balls.
   */
  fetchLogo?: (url: string) => Promise<{ contentType: string; body: Buffer } | null>;
  /**
   * Bot-pushed logo bytes (#249), keyed by teamId. The bot fetches with the league's ESPN
   * cookies and rasterizes SVG — neither of which this process can or should do — then POSTs the
   * result to `/api/lottery/logo-cache`. Each entry records the source `url` it was fetched
   * from, so the GET can refuse to serve art that no longer matches the stamped row.
   */
  logoStore?: {
    put(entry: { teamId: string; url: string; contentType: string; body: Buffer }): void;
    get(teamId: string): { url: string; contentType: string; body: Buffer } | undefined;
  };
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

/** Max decoded logo the push cache accepts — mirrors the anonymous fetcher's cap (#242). */
const LOGO_PUSH_MAX_BYTES = 512 * 1024;

type ParsedLogoCache =
  { value: { teamId: string; url: string; contentType: string; body: Buffer } } | { error: string };

/**
 * Guard for `POST /api/lottery/logo-cache` (#249). Bot-authored (behind `x-stage-key`), but the
 * bytes end up served from this origin, so the gate re-checks everything the bot promised:
 * raster image/* only (never SVG), bounded size, and a real http(s) source URL — the GET refuses
 * to serve an entry whose `url` no longer matches the stamped row, which is what keeps a
 * re-imported team from wearing stale art.
 */
function parseLogoCache(body: string): ParsedLogoCache {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { error: 'logo-cache needs a JSON body' };
  }
  if (!raw || typeof raw !== 'object') return { error: 'logo-cache needs a JSON object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.teamId !== 'string' || !r.teamId) return { error: 'logo-cache needs a teamId' };
  if (typeof r.url !== 'string' || !/^https?:\/\//i.test(r.url)) {
    return { error: 'logo-cache needs the http(s) source url' };
  }
  // Lowercased before the gate: `image/SVG+xml` must not sneak past a case-sensitive check.
  const contentType = (typeof r.contentType === 'string' ? r.contentType : '').toLowerCase();
  if (!contentType.startsWith('image/') || contentType.includes('svg')) {
    return { error: 'logo-cache accepts raster image/* only' };
  }
  if (typeof r.data !== 'string' || !r.data) return { error: 'logo-cache needs base64 data' };
  const bytes = Buffer.from(r.data, 'base64');
  if (bytes.byteLength === 0) return { error: 'logo-cache data decoded empty' };
  if (bytes.byteLength > LOGO_PUSH_MAX_BYTES) {
    return { error: 'logo-cache data exceeds the 512KB cap' };
  }
  return { value: { teamId: r.teamId, url: r.url, contentType, body: bytes } };
}

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
    // A Discord Activity iframe always opens at the root URL mapping — it cannot ask for
    // `/lottery`. So the root is mode-switched: while a lottery ceremony occupies the stage
    // (any non-idle phase, including a finished run so late clickers get the finale + verify
    // panel), serve the machine; otherwise the draft dashboard. The stage is in-memory, so a
    // stale finished run stops shadowing the dashboard on the next api restart, and `/lottery`
    // below always reaches the machine directly (dev).
    const lotteryLive = deps.lottery.snapshot().phase !== 'idle';
    return {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: lotteryLive ? lotteryHtml(deps.clientId) : boardHtml(deps.clientId),
    };
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
    return await lotteryRoute(method, path, body, deps, headers, url.split('?')[1]);
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
 *   GET  /api/lottery/me      → is the bearer's Discord user the lobby's commissioner? (#210)
 *   POST /api/lottery/adjust  → nudge a team's balls in the armed lobby (#210, commissioner only)
 *   POST /api/lottery/rename  → fix a team's display name (#219, commissioner only)
 *   POST /api/lottery/reimport→ ask the bot to refetch the league from ESPN (#219, commissioner only)
 *   POST /api/lottery/begin   → ask the bot to seal the bag and start the draw (#233, commissioner only)
 *   POST /api/lottery/lobby   → arm the pre-commitment lobby from setup onward (#198, bot only)
 *   POST /api/lottery/clear   → disarm that lobby, back to idle (#198, bot only)
 *   POST /api/lottery/start   → open the stage (bot only)
 *   POST /api/lottery/beat    → drum-roll for the next pick (bot only)
 *   POST /api/lottery/reveal  → the ball drop (bot only)
 *   POST /api/lottery/finish  → final order + seed-reveal verify info (bot only)
 *   POST /api/lottery/abort   → the ceremony aborted (bot only)
 *
 * **Two auth paths, deliberately disjoint** (ADR 0007). Bot-only routes require `x-stage-key`, a
 * server-side secret that must never reach the public Activity client. `/api/lottery/me` and
 * `/api/lottery/adjust` instead take the Activity's own Discord access token as a bearer, which
 * the backend resolves to a user id via Discord (`deps.identify`) before checking it against the
 * commissioner list the bot stamped onto the lobby. A stage key is never accepted for `adjust`
 * and a bearer is never accepted for a bot route.
 */
async function lotteryRoute(
  method: string,
  path: string,
  body: string,
  deps: RouteDeps,
  headers: Record<string, string | string[] | undefined>,
  /** Raw query string (normalizePath strips it from `path`); only `/diag` reads it (#231). */
  query?: string,
): Promise<HttpReply> {
  if (method === 'GET' && path === '/api/lottery/state') {
    return json(200, deps.lottery.snapshot());
  }
  if (method === 'GET' && path === '/api/lottery/diag') {
    // Client-side failure beacon (#231): a GET with a query param is the one request shape proven
    // to traverse every layer between the iframe and this process (Discord proxy, tunnel), so the
    // handshake reports its own death here. Unauthenticated by design — it fires exactly when
    // auth is broken — and bounded: truncated, log-only, nothing stored or echoed back.
    const message = new URLSearchParams(query ?? '').get('msg') ?? '';
    deps.clientLog?.(message.slice(0, 300));
    return { status: 204, contentType: 'text/plain', body: '' };
  }
  if (method === 'GET' && path === '/api/lottery/logo') {
    // Same-origin image proxy (#242): the Activity CSP forbids loading ESPN's CDN directly, so
    // the client asks us by teamId and we serve EXACTLY what the bot vouched for — never a
    // caller-supplied URL, so this can't be turned into an open proxy.
    // Unauthenticated like `/api/lottery/state`: the URL itself is already public on the wire.
    const teamId = new URLSearchParams(query ?? '').get('team') ?? '';
    const snapshot = deps.lottery.snapshot();
    const rows = snapshot.lobby?.rows ?? snapshot.start?.rows ?? [];
    const url = teamId ? rows.find((row) => row.teamId === teamId)?.logo : undefined;
    // Belt over the bot-side filter: only http(s) is servable, whatever rode the wire.
    if (!url || !/^https?:\/\//i.test(url)) {
      return json(404, { error: 'no logo for that team' });
    }
    const serve = (image: { contentType: string; body: Buffer }): HttpReply => ({
      status: 200,
      contentType: image.contentType,
      body: '',
      bodyBytes: image.body,
      // Stable for the ceremony's lifetime, and the odds table repaints per broadcast — without
      // this every repaint would refetch every avatar through the Discord proxy.
      cacheControl: 'public, max-age=3600',
    });
    // Bot-pushed bytes first (#249): ESPN-hosted art needs the league's cookies and stock logos
    // arrive as SVG — only the bot can fetch and rasterize those, so it pushes the result here.
    // The entry must vouch for the CURRENT row URL, or a re-imported team could keep stale art.
    const pushed = deps.logoStore?.get(teamId);
    if (pushed && pushed.url === url) return serve(pushed);
    // Anonymous raster fetch is still the fallback — public hosts (imgur) need no bot help.
    if (!deps.fetchLogo) return json(404, { error: 'no logo for that team' });
    const image = await deps.fetchLogo(url);
    if (!image) return json(404, { error: 'logo unavailable' });
    return serve(image);
  }
  if (method === 'GET' && path === '/api/lottery/me') {
    const caller = await identifyCaller(deps, headers);
    if ('reply' in caller) return caller.reply;
    return json(200, {
      userId: caller.user.id,
      commissioner: deps.lottery.isCommissioner(caller.user.id),
    });
  }
  if (method !== 'POST') return json(404, { error: 'not found' });

  // The setup doorbell (#253) is bearer-identified but NOT commissioner-gated — at a dead-idle
  // stage there is no lobby and therefore no commissioner list. Authority is the BOT's to check
  // (Manage Server in the named guild); this route records verified identity + intent only.
  if (path === '/api/lottery/setup-request') {
    // Cheap local rejection first, same rationale as the commissioner routes: junk bearers must
    // not turn into Discord round-trips, and the phase is already public via /state.
    if (deps.lottery.snapshot().phase !== 'idle') {
      return json(409, { error: 'a ceremony is already on the stage' });
    }
    const caller = await identifyCaller(deps, headers);
    if ('reply' in caller) return caller.reply;
    const parsed = parseLotterySetupRequest(body);
    if ('error' in parsed) return json(400, { error: parsed.error });
    try {
      deps.lottery.requestSetup({ ...parsed.value, requestedBy: caller.user.id });
    } catch (error) {
      // A press already pending — the loser of a button race backs off cleanly.
      if (error instanceof StageNotEditableError) {
        return json(409, { error: 'a setup request is already pending' });
      }
      throw error;
    }
    return json(200, { ok: true });
  }

  // The commissioner's edits (#210 balls, #219 rename/re-import, #233 begin) are the POSTs that
  // are *not* bot-only, so they resolve their own identity and return before the `x-stage-key`
  // gate below.
  if (
    path === '/api/lottery/adjust' ||
    path === '/api/lottery/adjust-all' ||
    path === '/api/lottery/audit-mode' ||
    path === '/api/lottery/rename' ||
    path === '/api/lottery/reimport' ||
    path === '/api/lottery/begin'
  ) {
    return await commissionerRoute(path, body, deps, headers);
  }

  if (deps.stageKey) {
    const sent = headers['x-stage-key'];
    if (typeof sent !== 'string' || sent !== deps.stageKey) {
      return json(401, { error: 'missing or bad x-stage-key' });
    }
  }

  switch (path) {
    case '/api/lottery/setup-release': {
      // Bot-keyed refusal of a setup press (#253): frees every idle screen's button and carries
      // the reason once, so a denied presser is never left staring at silence.
      const parsed = parseLotterySetupRelease(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      deps.lottery.releaseSetup(parsed.value);
      return json(200, { ok: true });
    }
    case '/api/lottery/reimport-release': {
      // Bot-keyed refusal of a re-import press (#250): same shape and same reason — a button
      // whose request the bot dropped must not stay disabled until the next setup.
      const parsed = parseLotterySetupRelease(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      deps.lottery.releaseReimport(parsed.value);
      return json(200, { ok: true });
    }
    case '/api/lottery/logo-cache': {
      // Bot-pushed logo bytes (#249). Raster only — the bot rasterizes SVG before pushing, and
      // this gate makes sure nothing scriptable can be laundered into the same-origin cache.
      const parsed = parseLogoCache(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      if (!deps.logoStore) return json(503, { error: 'no logo store wired' });
      deps.logoStore.put(parsed.value);
      return json(200, { ok: true });
    }
    case '/api/lottery/lobby': {
      const parsed = parseLotteryLobby(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      try {
        deps.lottery.lobby(parsed.value);
      } catch (error) {
        if (error instanceof StageBusyError) return json(409, { error: error.message });
        throw error;
      }
      return json(200, { ok: true });
    }
    case '/api/lottery/clear': {
      const parsed = parseLotteryClear(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      // Idempotent no-op unless an armed lobby matches — never rejects, so the bot's cleanup
      // paths can fire it blindly.
      deps.lottery.clear(parsed.value);
      return json(200, { ok: true });
    }
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

/**
 * Resolve `Authorization: Bearer …` to a Discord user, or the {@link HttpReply} to send instead.
 * 401 covers both "no bearer" and "Discord rejected it" — from the client's side those are the
 * same condition (re-run the handshake), and distinguishing them would leak token validity to
 * anyone who can reach the endpoint.
 */
async function identifyCaller(
  deps: RouteDeps,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ user: DiscordUser } | { reply: HttpReply }> {
  const token = parseBearerToken(headers);
  if (!token) {
    return { reply: json(401, { error: 'missing Authorization: Bearer <discord access token>' }) };
  }
  try {
    return { user: await deps.identify(token) };
  } catch {
    return { reply: json(401, { error: 'could not identify the caller with Discord' }) };
  }
}

/**
 * The commissioner-authenticated writes: `adjust` (#210), `rename` and `reimport` (#219),
 * `begin` (#233). Guarded in order: phase (cheap, local) → identity (server-side, via Discord) →
 * commissioner → payload. The 403 is deliberately indistinguishable for "not a commissioner" and
 * "no lobby armed", since `isCommissioner` is false in both cases and neither is something a
 * caller can act on.
 */
async function commissionerRoute(
  path: string,
  body: string,
  deps: RouteDeps,
  headers: Record<string, string | string[] | undefined>,
): Promise<HttpReply> {
  // Cheap local rejection first. Identifying a caller costs a round-trip to Discord against *our*
  // rate limit, and this route is reachable by anyone who can load the Activity host — so an
  // unauthenticated spammer must not be able to turn junk bearers into Discord traffic. Whether a
  // lobby is armed is already public via `/api/lottery/state`, so this leaks nothing.
  if (deps.lottery.snapshot().phase !== 'lobby') {
    return json(409, { error: 'no pre-commitment lobby is armed' });
  }
  const caller = await identifyCaller(deps, headers);
  if ('reply' in caller) return caller.reply;
  if (!deps.lottery.isCommissioner(caller.user.id)) {
    return json(403, { error: 'only the commissioner who ran setup can adjust this lobby' });
  }
  try {
    if (path === '/api/lottery/reimport') {
      // No payload: the api cannot reach ESPN, so this only raises a flag the bot honours.
      deps.lottery.requestReimport();
    } else if (path === '/api/lottery/begin') {
      const parsed = parseLotteryBegin(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      // `requestedBy` comes from the verified bearer, never the body — the audit line the bot
      // posts names whoever actually pressed the button, and a client cannot forge it.
      deps.lottery.requestBegin({ ...parsed.value, requestedBy: caller.user.id });
    } else if (path === '/api/lottery/rename') {
      const parsed = parseLotteryRename(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      deps.lottery.rename(parsed.value);
    } else if (path === '/api/lottery/adjust-all') {
      // Bulk level-all (#252): one stage op so the field recomputes once and the bot posts one
      // audit line — twelve stepper taps' worth of intent in a single authorized write.
      const parsed = parseLotteryAdjustAll(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      deps.lottery.adjustAll(parsed.value.balls);
    } else if (path === '/api/lottery/audit-mode') {
      const parsed = parseLotteryAuditMode(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      deps.lottery.setAuditMode(parsed.value.mode);
    } else {
      const parsed = parseLotteryAdjust(body);
      if ('error' in parsed) return json(400, { error: parsed.error });
      deps.lottery.adjust(parsed.value);
    }
  } catch (error) {
    // A committed/finished run, or a lobby whose rows can't carry exact odds — either way the
    // edit is refused outright rather than retried.
    if (error instanceof StageNotEditableError) return json(409, { error: error.message });
    if (error instanceof UnknownTeamError) return json(404, { error: error.message });
    // A name the commissioner can fix by choosing a different one.
    if (error instanceof DuplicateTeamNameError) return json(409, { error: error.message });
    throw error;
  }
  return json(200, { ok: true, snapshot: deps.lottery.snapshot() });
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
