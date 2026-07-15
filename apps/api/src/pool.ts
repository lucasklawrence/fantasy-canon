/**
 * ADP-only draft pool for the Activity backend.
 *
 * The bot loads research boards from disk + FFC ADP (`apps/bot/src/lib/draftPool.ts`); this backend
 * is a separate deploy that won't ship the `research/` archive, so it runs off the free
 * FantasyFootballCalculator ADP feed alone — the same ADP-only path the local advisor proved builds
 * a full-depth board with zero prep. The pure join (`mergeAdpIntoPool`) lives in `core`; the pure
 * normalize step ({@link ffcToRows}) is exported and unit-tested against a fixture with no network.
 *
 * Deliberately a thin, uncached fetch to keep the scaffold focused. TODO (ADR 0004/0005): lift the
 * bot's cached FFC client (`apps/bot/src/lib/ffcAdp.ts`) into a shared package so both surfaces share
 * one loader instead of this trimmed copy.
 */

import {
  mergeAdpIntoPool,
  type AdpProvenance,
  type AdpRow,
  type PlayerTier,
  type Position,
} from '@fantasy-canon/core';

/** Positions we draft for. FFC also returns `DEF`/`PK`, which we drop. */
const TRACKED_POSITIONS: Record<string, Position> = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE' };
const BASE_URL = 'https://fantasyfootballcalculator.com/api/v1/adp';
const DEFAULT_TIMEOUT_MS = 8000;

/** One player row as FFC returns it (fields we read); untrusted, guarded in {@link ffcToRows}. */
interface FfcPlayer {
  name?: string;
  position?: string;
  team?: string;
  adp?: number | null;
}

interface FfcResponse {
  meta?: { teams?: number; total_drafts?: number; end_date?: string };
  players?: FfcPlayer[];
}

export interface LoadedPool {
  players: PlayerTier[];
  adp?: AdpProvenance;
}

export interface LoadAdpPoolOptions {
  season?: number;
  teams?: number;
  timeoutMs?: number;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** NFL season for the ADP feed — the current calendar year, overridable via `FANTASY_SEASON`. */
export function resolveSeason(): number {
  const override = Number(process.env.FANTASY_SEASON);
  if (Number.isInteger(override) && override > 2000) return override;
  return new Date().getFullYear();
}

/**
 * Pure: turn a raw FFC ADP response into `core` ADP rows, keeping only RB/WR/TE/QB rows that carry a
 * finite ADP and a name. Everything downstream is fed from these.
 */
export function ffcToRows(response: FfcResponse): AdpRow[] {
  const players = Array.isArray(response.players) ? response.players : [];
  const rows: AdpRow[] = [];
  for (const p of players) {
    const position = TRACKED_POSITIONS[(p.position ?? '').toUpperCase()];
    if (!position) continue;
    if (typeof p.adp !== 'number' || !Number.isFinite(p.adp)) continue;
    if (!p.name) continue;
    rows.push({ name: p.name, position, team: p.team || undefined, adp: p.adp });
  }
  return rows;
}

/**
 * Fetch full-PPR ADP from FantasyFootballCalculator and build an ADP-only pool. Throws on a non-OK
 * response or a network/timeout error — the caller decides how to degrade (the entrypoint starts
 * with an empty pool and logs).
 */
export async function loadAdpPool(options: LoadAdpPoolOptions = {}): Promise<LoadedPool> {
  const season = options.season ?? resolveSeason();
  const teams = options.teams ?? 12;
  const doFetch = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  let response: Response;
  try {
    response = await doFetch(`${BASE_URL}/ppr?teams=${teams}&year=${season}`, {
      headers: { 'User-Agent': 'fantasy-canon/0.1', Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`FantasyFootballCalculator ADP responded ${response.status}`);
  }

  const json = (await response.json()) as FfcResponse;
  const rows = ffcToRows(json);
  const players = mergeAdpIntoPool([], rows);
  const adp: AdpProvenance | undefined =
    rows.length > 0
      ? {
          asOf: json.meta?.end_date ?? '',
          sampleSize: json.meta?.total_drafts ?? rows.length,
          added: players.length,
        }
      : undefined;
  return { players, adp };
}
