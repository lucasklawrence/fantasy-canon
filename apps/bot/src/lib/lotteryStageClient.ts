/**
 * HTTP adapter for the Activity reveal stage (#169): implements the ceremony's {@link RevealStage}
 * seam by POSTing each beat to the `apps/api` backend (`/api/lottery/*`), which fans it out to
 * every connected lottery-machine client over its WebSocket. The bot stays the single pacer; this
 * is fire-per-beat plumbing.
 *
 * `fetchImpl` is injected so tests never open a socket. `stageKey` (shared secret, `x-stage-key`)
 * must match the backend's `FANTASY_STAGE_KEY` — required in production where the mapped host is
 * publicly reachable; optional against the loopback dev bind.
 */

import type { RevealStage } from './draftOrderCeremony.js';

export interface HttpRevealStageOptions {
  /** The Activity backend base URL, e.g. `http://127.0.0.1:4610`. */
  baseUrl: string;
  /** Shared secret sent as `x-stage-key`; empty ⇒ header omitted (loopback dev). */
  stageKey?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout — a hung stage must never stall the authoritative ceremony. */
  timeoutMs?: number;
}

/** Default per-POST timeout: generous for a beat, tiny next to the reveal pacing. */
export const DEFAULT_STAGE_TIMEOUT_MS = 5000;

export function createHttpRevealStage(options: HttpRevealStageOptions): RevealStage {
  const {
    baseUrl,
    stageKey = '',
    fetchImpl = fetch,
    timeoutMs = DEFAULT_STAGE_TIMEOUT_MS,
  } = options;
  const base = baseUrl.replace(/\/+$/, '');

  async function post(route: string, payload: unknown): Promise<void> {
    const res = await fetchImpl(`${base}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(stageKey ? { 'x-stage-key': stageKey } : {}),
      },
      body: JSON.stringify(payload),
      // Bounded: if the stage accepts the connection but hangs, the ceremony's safeStage wrapper
      // gets a rejection to skip past instead of `runCeremony` stalling on presentation.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`stage POST ${route} failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
  }

  return {
    lobby: (lobby) => post('/api/lottery/lobby', lobby),
    start: (start) => post('/api/lottery/start', start),
    beat: (beat) => post('/api/lottery/beat', beat),
    reveal: (reveal) => post('/api/lottery/reveal', reveal),
    finish: (finish) => post('/api/lottery/finish', finish),
    abort: (abort) => post('/api/lottery/abort', abort),
  };
}

/** Default stage URL — the `apps/api` dev bind (`pnpm -C apps/api run dev`). */
export const DEFAULT_STAGE_URL = 'http://127.0.0.1:4610';

/** The stage client configured from env (`FANTASY_STAGE_URL`/`FANTASY_STAGE_KEY`), dev default. */
export function stageFromEnv(env: NodeJS.ProcessEnv = process.env): RevealStage {
  return createHttpRevealStage({
    baseUrl: env.FANTASY_STAGE_URL ?? DEFAULT_STAGE_URL,
    stageKey: env.FANTASY_STAGE_KEY ?? '',
  });
}
