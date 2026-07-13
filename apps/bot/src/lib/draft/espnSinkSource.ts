/**
 * The ESPN capture {@link DraftSource}: a tiny localhost HTTP sink that a browser userscript POSTs
 * scraped picks to. This is the browser→bot bridge that makes "picks flow in without re-typing them"
 * real — the userscript (see `apps/bot/assets/espn-draft-capture.user.js`) reads the ESPN draft
 * room's pick-history DOM and pushes a JSON board here; the bot buffers it and the poller drains it
 * into the live session.
 *
 * Read-only and local by construction: it binds to 127.0.0.1 only (never the network), only ingests
 * public draft picks, and never submits anything back to ESPN. Pick parsing is delegated to core's
 * pure {@link espnRowsToPicks}, so the transport here stays dumb.
 */

import http from 'node:http';
import {
  espnRowsToPicks,
  type DraftPick,
  type DraftSnapshot,
  type DraftSource,
  type EspnRawPick,
} from '@fantasy-canon/core';

/** Body the userscript POSTs: the current scraped board plus optional draft pointers. */
export interface SinkPayload {
  rows?: EspnRawPick[];
  onTheClock?: number;
  complete?: boolean;
}

const MAX_BODY_BYTES = 1_000_000;

export class EspnSinkDraftSource implements DraftSource {
  readonly kind = 'espn-sink';
  private readonly picks = new Map<number, DraftPick>();
  private onTheClock?: number;
  private complete = false;
  private server?: http.Server;

  /** `onIngest` fires with the newly-seen picks whenever a POST adds anything. */
  constructor(private readonly onIngest?: (added: DraftPick[]) => void) {}

  /** Merge a scraped board in (idempotent, keyed by overall). Returns picks not seen before. */
  ingest(payload: SinkPayload): DraftPick[] {
    if (typeof payload.onTheClock === 'number') this.onTheClock = payload.onTheClock;
    if (payload.complete) this.complete = true;

    const added: DraftPick[] = [];
    for (const pick of espnRowsToPicks(payload.rows ?? [])) {
      if (this.picks.has(pick.overall)) continue;
      this.picks.set(pick.overall, pick);
      added.push(pick);
    }
    if (added.length && this.onIngest) this.onIngest(added);
    return added;
  }

  poll(): DraftSnapshot {
    return {
      picks: [...this.picks.values()].sort((a, b) => a.overall - b.overall),
      onTheClock: this.onTheClock,
      complete: this.complete || undefined,
    };
  }

  /** The bound port once {@link listen} has resolved, else undefined. */
  get port(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : undefined;
  }

  /** Start the capture endpoint on localhost. Resolves with the bound port (0 ⇒ ephemeral). */
  listen(port = 0, host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.once('error', reject);
      server.listen(port, host, () => {
        this.server = server;
        resolve(this.port ?? port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = undefined;
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    // The userscript runs on https://fantasy.espn.com, so allow the cross-origin POST.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }

    let body = '';
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > MAX_BODY_BYTES) {
        aborted = true;
        res.statusCode = 413;
        res.end();
        req.destroy();
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const payload = JSON.parse(body || '{}') as SinkPayload;
        const added = this.ingest(payload);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, added: added.length, known: this.picks.size }));
      } catch {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
      }
    });
  }
}
