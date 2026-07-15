/**
 * The side-effectful shell: a `node:http` server that applies the pure {@link routeRequest} replies,
 * plus a WebSocket server that pushes a fresh {@link Envelope} to every connected board whenever the
 * {@link DraftHub} moves. WebSocket is the push transport because it is the only one that survives the
 * Discord Activity proxy sandbox (see [[discord-surface-constraints]] / ADR 0005).
 *
 * Binds to 127.0.0.1 by default (the dev host); in production the Activity proxy maps a Discord URL
 * to this backend. `now` is injected so the server stamps deterministic timestamps in tests.
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import type { DraftHub } from './hub.js';
import { routeRequest, type Envelope } from './routes.js';

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

  const envelope = (): Envelope => ({ ...hub.snapshot(), updatedAt: now().toISOString() });

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
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          const reply = routeRequest(req.method ?? 'GET', req.url ?? '/', body, {
            getEnvelope: envelope,
            ingest: (picks) => hub.ingest(picks),
            nextOverall: () => hub.nextOverall(),
            reset: () => hub.reset(),
          });
          res.statusCode = reply.status;
          res.setHeader('Content-Type', reply.contentType);
          res.setHeader('Cache-Control', 'no-store');
          res.end(reply.body);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: message }));
        }
      });
    });

    const wss = new WebSocketServer({ server, path: '/api/ws' });
    wss.on('connection', (socket) => {
      // A socket-level 'error' with no listener throws and takes the process down; swallow it.
      socket.on('error', () => {});
      // Send the current state on connect so a late joiner paints immediately.
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
