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
import { normalizePath, routeRequest, type Envelope } from './routes.js';
import { exchangeCodeForToken } from './token.js';

/** Max request body we buffer — a draft board is tiny; this just bounds a hostile/runaway request. */
const MAX_BODY_BYTES = 1_000_000;

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

  const envelope = (): Envelope => ({ ...hub.snapshot(), updatedAt: now().toISOString() });

  // Read the bundle once and cache it; absent (before `build:client`) ⇒ the route serves a 503.
  let cachedScript: string | undefined;
  try {
    cachedScript = readFileSync(clientScriptPath, 'utf8');
  } catch {
    cachedScript = undefined;
  }

  const exchangeToken = (code: string): Promise<{ accessToken: string }> => {
    if (!clientId || !clientSecret) {
      return Promise.reject(
        new Error('token exchange needs DISCORD_APP_ID and DISCORD_CLIENT_SECRET (server-side)'),
      );
    }
    return exchangeCodeForToken(code, { clientId, clientSecret, fetchImpl: fetch });
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
        routeRequest(req.method ?? 'GET', req.url ?? '/', body, {
          getEnvelope: envelope,
          ingest: (picks) => hub.ingest(picks),
          nextOverall: () => hub.nextOverall(),
          reset: () => hub.reset(),
          clientId,
          clientScript: () => cachedScript,
          exchangeToken,
        })
          .then((reply) => {
            res.statusCode = reply.status;
            res.setHeader('Content-Type', reply.contentType);
            res.setHeader('Cache-Control', 'no-store');
            res.end(reply.body);
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: message }));
          });
      });
    });

    // Accept the state feed at `/api/ws`, with or without the Activity's `/.proxy` prefix; reject
    // any other upgrade path so a stray socket can't linger.
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket, req) => {
      socket.on('error', () => {});
      if (normalizePath(req.url ?? '') !== '/api/ws') {
        socket.close(1008, 'unknown path');
        return;
      }
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(envelope()));
    });
    const unsubscribe = hub.subscribe((snap) => {
      const msg = JSON.stringify({ ...snap, updatedAt: now().toISOString() });
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(msg);
      }
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
            wss.close();
            server.close(() => res());
          }),
      });
    });
  });
}
