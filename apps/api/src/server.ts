/**
 * The side-effectful shell: a `node:http` server that applies the pure {@link routeRequest} replies,
 * plus a WebSocket server that pushes a fresh {@link Envelope} to every connected board whenever the
 * {@link DraftHub} moves. WebSocket is the push transport because it is the only one that survives the
 * Discord Activity proxy sandbox (see [[discord-surface-constraints]] / ADR 0005).
 *
 * Binds to 127.0.0.1 by default (the dev host); in production the Activity proxy maps a Discord URL
 * to this backend. `now` is injected so the server stamps deterministic timestamps in tests. The
 * network I/O the routes need — reading the built client bundle from disk and calling Discord's OAuth
 * endpoint for the token exchange — is wired here (the shell), so the router stays pure.
 */

import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import type { DraftHub } from './hub.js';
import { createLotteryStage, type LotteryStage } from './lotteryStage.js';
import { normalizePath, routeRequest, type Envelope } from './routes.js';
import { exchangeCodeForToken, fetchDiscordUser, type DiscordUser } from './token.js';

/** Max request body we buffer — a draft board is tiny; this just bounds a hostile/runaway request. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * How long a verified `Bearer` → Discord user mapping is reused (#210). Every stepper tap is an
 * authorized write, and Discord rate-limits `/users/@me`; a minute is short enough that a revoked
 * token stops working promptly and long enough that a burst of edits costs one round-trip.
 */
const IDENTITY_TTL_MS = 60_000;

/** Bounds the cache so a token-spraying client can't grow it without limit. */
const IDENTITY_CACHE_MAX = 500;

export interface ApiServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface ApiServerOptions {
  port?: number;
  host?: string;
  /** Discord application (client) id, injected into the page for the SDK. Empty ⇒ dev/standalone. */
  clientId?: string;
  /** Discord `client_secret` for the OAuth token exchange; server-side only, never sent to the browser. */
  clientSecret?: string;
  /** Path to the esbuild client bundle; defaults to `dist/client/activity.js` under the cwd. */
  clientScriptPath?: string;
  /** Path to the lottery client bundle; defaults to `dist/client/lottery.js` under the cwd. */
  lotteryScriptPath?: string;
  /** The lottery reveal stage (#169); a fresh one is created when not injected (tests inject). */
  lottery?: LotteryStage;
  /** Shared secret required on `POST /api/lottery/*` (the bot's `x-stage-key`). Empty ⇒ open. */
  stageKey?: string;
  /** Injected for tests; defaults to `() => new Date()`. */
  now?: () => Date;
}

export function startApiServer(
  hub: DraftHub,
  opts: ApiServerOptions = {},
): Promise<ApiServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 4610;
  const now = opts.now ?? ((): Date => new Date());
  const clientId = opts.clientId ?? '';
  const clientSecret = opts.clientSecret ?? '';
  const clientScriptPath =
    opts.clientScriptPath ?? path.resolve(process.cwd(), 'dist/client/activity.js');
  const lotteryScriptPath =
    opts.lotteryScriptPath ?? path.resolve(process.cwd(), 'dist/client/lottery.js');
  const lottery = opts.lottery ?? createLotteryStage();
  const stageKey = opts.stageKey ?? '';

  const envelope = (): Envelope => ({ ...hub.snapshot(), updatedAt: now().toISOString() });

  // Read the bundles once and cache them; absent (before `build:client`) ⇒ the route serves a 503.
  const readScript = (file: string): string | undefined => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  };
  const cachedScript = readScript(clientScriptPath);
  const cachedLotteryScript = readScript(lotteryScriptPath);

  const exchangeToken = (code: string): Promise<{ accessToken: string }> => {
    if (!clientId || !clientSecret) {
      return Promise.reject(
        new Error('token exchange needs DISCORD_APP_ID and DISCORD_CLIENT_SECRET (server-side)'),
      );
    }
    return exchangeCodeForToken(code, { clientId, clientSecret, fetchImpl: fetch });
  };

  // The diag sink (#231) takes attacker-typeable text on an unauthenticated route, so it defends
  // the log rather than trusting the caller: control characters are stripped (a newline or ANSI
  // escape could forge log records / drive the terminal), and a coarse per-minute cap bounds
  // flooding — diagnostics are a courtesy, not a contract, so over-cap messages just drop.
  const CLIENT_LOG_MAX_PER_MINUTE = 10;
  let clientLogWindowStart = 0;
  let clientLogCount = 0;
  const clientLog = (message: string): void => {
    const t = now().getTime();
    if (t - clientLogWindowStart > 60_000) {
      clientLogWindowStart = t;
      clientLogCount = 0;
    }
    if (clientLogCount >= CLIENT_LOG_MAX_PER_MINUTE) return;
    clientLogCount += 1;
    // eslint-disable-next-line no-control-regex -- stripping control chars is the entire point
    console.log('[lottery-client]', message.replace(/[\u0000-\u001f\u007f]/g, ' '));
  };

  // Team-logo fetcher for the same-origin proxy (#242). The route only ever hands us URLs the
  // bot stamped on the current lobby/start rows, but this still fetches third-party bytes on
  // demand, so everything is bounded: 5s timeout, raster image/* only, 512KB cap, no private
  // hosts (checked again after redirects), and a small insertion-order cache (a ceremony has
  // ~12 logos; the odds table repaints per broadcast). Failures return null — the client falls
  // back to hue balls, never an error state.
  const logoCache = new Map<string, { contentType: string; body: Buffer }>();
  const LOGO_CACHE_MAX = 32;
  const LOGO_MAX_BYTES = 512 * 1024;
  // Loopback/link-local/RFC1918: a logo URL legitimately lives on a public CDN, so a private
  // target is only ever a mistake or a probe — refuse rather than let the proxy reach inward.
  // (Belt only: the write path is bot-authenticated; full multi-tenant hardening is #191.)
  const privateHost = (hostname: string): boolean => {
    const h = hostname.toLowerCase();
    return (
      h === 'localhost' ||
      h.endsWith('.local') ||
      h === '::1' ||
      h.startsWith('127.') ||
      h.startsWith('10.') ||
      h.startsWith('192.168.') ||
      h.startsWith('169.254.') ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    );
  };
  const fetchLogo = async (url: string): Promise<{ contentType: string; body: Buffer } | null> => {
    const cached = logoCache.get(url);
    if (cached) return cached;
    try {
      if (privateHost(new URL(url).hostname)) return null;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
      if (!res.ok) return null;
      // A redirect chain must not end somewhere the original URL couldn't have started.
      if (res.url && privateHost(new URL(res.url).hostname)) return null;
      const contentType = res.headers.get('content-type') ?? '';
      // Raster only: SVG is a script container, and these bytes are served from OUR origin.
      if (!contentType.startsWith('image/') || contentType.includes('svg')) return null;
      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > LOGO_MAX_BYTES) return null;
      const body = Buffer.from(await res.arrayBuffer());
      if (body.byteLength > LOGO_MAX_BYTES) return null;
      const entry = { contentType, body };
      if (logoCache.size >= LOGO_CACHE_MAX) {
        const oldest = logoCache.keys().next();
        if (!oldest.done) logoCache.delete(oldest.value);
      }
      logoCache.set(url, entry);
      return entry;
    } catch {
      return null;
    }
  };

  // Short-TTL identity cache (#210): the commissioner's steppers fire one authorized write per
  // tap, and re-asking Discord who they are on every tap would burn rate limit for no new
  // information. Only successful lookups are cached — a failure must be re-attempted, never
  // remembered as a denial.
  const identityCache = new Map<string, { user: DiscordUser; expiresAt: number }>();
  const identify = async (accessToken: string): Promise<DiscordUser> => {
    const cached = identityCache.get(accessToken);
    if (cached && cached.expiresAt > now().getTime()) return cached.user;
    identityCache.delete(accessToken);
    const user = await fetchDiscordUser(accessToken, { fetchImpl: fetch });
    // Cheap bound: drop the oldest insertion (Map preserves insertion order) rather than carry a
    // real LRU — entries expire in a minute anyway.
    if (identityCache.size >= IDENTITY_CACHE_MAX) {
      const oldest = identityCache.keys().next();
      if (!oldest.done) identityCache.delete(oldest.value);
    }
    identityCache.set(accessToken, { user, expiresAt: now().getTime() + IDENTITY_TTL_MS });
    return user;
  };

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        size += chunk.length;
        // A draft board is small; cap the body so a runaway/hostile request can't buffer unbounded.
        if (size > MAX_BODY_BYTES) {
          aborted = true;
          chunks.length = 0;
          res.statusCode = 413;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'request body too large' }));
          // Drain (don't destroy) the rest of the upload so the 413 flushes cleanly instead of the
          // client seeing an ECONNRESET.
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on('error', () => {
        res.statusCode = 400;
        res.end();
      });
      req.on('end', () => {
        if (aborted) return;
        // Never let a bad request take the process down mid-draft — any throw becomes a 500 and the
        // board keeps polling.
        const body = Buffer.concat(chunks).toString('utf8');
        routeRequest(
          req.method ?? 'GET',
          req.url ?? '/',
          body,
          {
            getEnvelope: envelope,
            ingest: (picks) => hub.ingest(picks),
            nextOverall: () => hub.nextOverall(),
            reset: () => hub.reset(),
            clientId,
            clientLog,
            clientScript: () => cachedScript,
            exchangeToken,
            fetchLogo,
            identify,
            lottery,
            lotteryScript: () => cachedLotteryScript,
            stageKey,
          },
          req.headers,
        )
          .then((reply) => {
            res.statusCode = reply.status;
            res.setHeader('Content-Type', reply.contentType);
            // State must never go stale, so `no-store` is the default; the logo proxy (#242)
            // opts into caching because avatars repaint on every broadcast.
            res.setHeader('Cache-Control', reply.cacheControl ?? 'no-store');
            res.end(reply.bodyBytes ?? reply.body);
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: message }));
          });
      });
    });

    // Two WS feeds share the server: `/api/ws` (draft dashboard) and `/api/lottery/ws` (the
    // lottery-machine stage, #169), each accepted with or without the Activity's `/.proxy`
    // prefix; any other upgrade path is rejected so a stray socket can't linger. Sockets are
    // tagged by path at connection so each fan-out reaches only its own audience.
    const wss = new WebSocketServer({ server });
    const boardSockets = new Set<import('ws').WebSocket>();
    const lotterySockets = new Set<import('ws').WebSocket>();
    wss.on('connection', (socket, req) => {
      socket.on('error', () => {});
      const wsPath = normalizePath(req.url ?? '');
      const pool =
        wsPath === '/api/ws' ? boardSockets : wsPath === '/api/lottery/ws' ? lotterySockets : null;
      if (!pool) {
        socket.close(1008, 'unknown path');
        return;
      }
      pool.add(socket);
      socket.on('close', () => pool.delete(socket));
      // Send the current state on connect so a late joiner paints immediately.
      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify(
            pool === boardSockets
              ? envelope()
              : { type: 'lottery-state', snapshot: lottery.snapshot() },
          ),
        );
      }
    });
    const fanOut = (pool: Set<import('ws').WebSocket>, msg: string): void => {
      for (const client of pool) {
        if (client.readyState === client.OPEN) client.send(msg);
      }
    };
    const unsubscribe = hub.subscribe((snap) => {
      fanOut(boardSockets, JSON.stringify({ ...snap, updatedAt: now().toISOString() }));
    });
    const unsubscribeLottery = lottery.subscribe((event) => {
      fanOut(lotterySockets, JSON.stringify(event));
    });

    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = address && typeof address === 'object' ? address.port : port;
      resolve({
        url: `http://${host}:${boundPort}/`,
        port: boundPort,
        close: () =>
          new Promise<void>((res) => {
            unsubscribe();
            unsubscribeLottery();
            wss.close();
            server.close(() => res());
          }),
      });
    });
  });
}
