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

/**
 * The slice of the stage's `GET /api/lottery/state` snapshot the bot reads back: enough for the
 * boot reconciler (#205) to tell an armed lobby from a stranded committed run and scope the
 * cleanup, plus the pending in-Activity ball edits `begin` drains before it commits (#210).
 */
export interface StageStateSnapshot {
  phase: string;
  lobby?: { guildId?: string };
  start?: { commitment?: string; guildId?: string };
  /** Commissioner ball edits made in the Activity that this bot has not folded into its bag yet. */
  adjustments?: { teamId: string; balls: number }[];
  /** Commissioner display-name fixes, drained alongside the ball edits (#219). */
  renames?: { teamId: string; displayName: string }[];
  /** The commissioner asked for an ESPN refetch; only this bot can perform it (#219). */
  reimportRequested?: boolean;
}

/**
 * A {@link RevealStage} that can also be inspected. Only the HTTP client (and reconciler test
 * fakes) implement this — the ceremony's pacing seam stays write-only.
 */
export interface InspectableRevealStage extends RevealStage {
  /** Fetch the stage's current public snapshot (`GET /api/lottery/state`, no key required). */
  state(): Promise<StageStateSnapshot>;
}

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

export function createHttpRevealStage(options: HttpRevealStageOptions): InspectableRevealStage {
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

  async function state(): Promise<StageStateSnapshot> {
    const res = await fetchImpl(`${base}/api/lottery/state`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`stage GET /api/lottery/state failed (${res.status})`);
    }
    const raw = (await res.json()) as Record<string, unknown>;
    const sub = (v: unknown): Record<string, unknown> | undefined =>
      v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const lobby = sub(raw.lobby);
    const start = sub(raw.start);
    // Re-validated rather than trusted: these numbers become ball counts in a bag a commitment is
    // about to bind, and the stage accepts them from the public Activity client.
    const adjustments = Array.isArray(raw.adjustments)
      ? raw.adjustments.flatMap((entry) => {
          const row = sub(entry);
          const teamId = row ? str(row.teamId) : undefined;
          const balls = row && typeof row.balls === 'number' ? row.balls : undefined;
          return teamId && balls !== undefined && Number.isInteger(balls) && balls > 0
            ? [{ teamId, balls }]
            : [];
        })
      : [];
    // Same re-validation as the ball edits: these strings become team names on a rendered card
    // and in channel messages, and the stage accepts them from the public Activity client.
    const renames = Array.isArray(raw.renames)
      ? raw.renames.flatMap((entry) => {
          const row = sub(entry);
          const teamId = row ? str(row.teamId) : undefined;
          const displayName = row ? str(row.displayName) : undefined;
          return teamId && displayName ? [{ teamId, displayName }] : [];
        })
      : [];
    return {
      phase: str(raw.phase) ?? 'idle',
      ...(adjustments.length > 0 ? { adjustments } : {}),
      ...(renames.length > 0 ? { renames } : {}),
      ...(raw.reimportRequested === true ? { reimportRequested: true } : {}),
      ...(lobby
        ? { lobby: { ...(str(lobby.guildId) ? { guildId: lobby.guildId as string } : {}) } }
        : {}),
      ...(start
        ? {
            start: {
              ...(str(start.commitment) ? { commitment: start.commitment as string } : {}),
              ...(str(start.guildId) ? { guildId: start.guildId as string } : {}),
            },
          }
        : {}),
    };
  }

  return {
    state,
    lobby: (lobby) => post('/api/lottery/lobby', lobby),
    logo: (entry) => post('/api/lottery/logo-cache', entry),
    setupRelease: (release) => post('/api/lottery/setup-release', release),
    reimportRelease: (release) => post('/api/lottery/reimport-release', release),
    clear: (clear) => post('/api/lottery/clear', clear),
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
export function stageFromEnv(env: NodeJS.ProcessEnv = process.env): InspectableRevealStage {
  return createHttpRevealStage({
    baseUrl: env.FANTASY_STAGE_URL ?? DEFAULT_STAGE_URL,
    stageKey: env.FANTASY_STAGE_KEY ?? '',
  });
}
