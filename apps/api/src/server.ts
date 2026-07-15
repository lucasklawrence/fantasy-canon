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
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('error', () => {
        res.statusCode = 400;
        res.end();
      });
      req.on('end', () => {
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
      // Send the current state on connect so a late joiner paints immediately.
      socket.send(JSON.stringify(envelope()));
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
