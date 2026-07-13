/**
 * FantasyFootballCalculator ADP feed for the draft engine. FFC exposes free ADP broken out by
 * scoring + league size from thousands of real mock drafts — exactly our 12-team full-PPR format
 * (`https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=<season>`).
 *
 * This is the side-effectful edge (network + a small on-disk cache), so it lives in the app layer,
 * not `core`. The pure join lives in `core` as `mergeAdpIntoPool`; the pure normalize step below
 * ({@link normalizeFfcAdp}) is exported and unit-tested against a fixture with no network.
 *
 * ADP moves at most daily, so we cache one normalized response per (scoring, teams, season,
 * calendar-day) in a temp dir — cheap, and it keeps a live draft from hammering FFC each pick.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AdpRow, Position } from '@fantasy-canon/core';

/** Positions we draft for. FFC also returns `DEF`/`PK`, which we drop. */
const TRACKED_POSITIONS: Record<string, Position> = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE' };

const BASE_URL = 'https://fantasyfootballcalculator.com/api/v1/adp';
const DEFAULT_TIMEOUT_MS = 8000;

export type FfcScoring = 'ppr' | 'half-ppr' | 'standard';

/**
 * One player row as FFC's ADP API returns it (fields we read; the API sends more). Typed loosely
 * because it's untrusted external JSON — {@link normalizeFfcAdp} guards every field at runtime.
 */
interface FfcPlayer {
  name?: string;
  position?: string;
  team?: string;
  adp?: number | null;
  stdev?: number | null;
  high?: number | null;
  low?: number | null;
}

interface FfcResponse {
  meta?: {
    type?: string;
    teams?: number;
    total_drafts?: number;
    start_date?: string;
    end_date?: string;
  };
  players?: FfcPlayer[];
}

/** Normalized ADP feed plus the provenance we surface so stale data is detectable. */
export interface FfcAdp {
  rows: AdpRow[];
  /** End of FFC's sampling window — the ADP "as-of" date, e.g. "2026-07-12". */
  asOf: string;
  /** Number of mock drafts the ADP aggregates. */
  sampleSize: number;
  teams: number;
  scoring: string;
  season: number;
}

export interface FetchFfcAdpOptions {
  /** NFL season year, e.g. 2026. */
  season: number;
  teams?: number;
  scoring?: FfcScoring;
  /** Directory for the daily cache file; defaults to `$FANTASY_CACHE_DIR` or a temp dir. */
  cacheDir?: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; defaults to `() => new Date()`. Only its calendar day is used. */
  now?: () => Date;
  /** Abort the request after this many ms (default 8000). */
  timeoutMs?: number;
}

/** Build the FFC ADP API URL for a scoring/size/season. */
export function ffcAdpUrl(scoring: string, teams: number, season: number): string {
  return `${BASE_URL}/${scoring}?teams=${teams}&year=${season}`;
}

/**
 * Pure: turn a raw FFC ADP response into our normalized shape, keeping only RB/WR/TE/QB and
 * rows that carry a finite ADP. Surfaces the sampling window's end date as {@link FfcAdp.asOf}.
 */
export function normalizeFfcAdp(
  response: FfcResponse,
  context: { season: number; teams: number; scoring: string },
): FfcAdp {
  const players = Array.isArray(response.players) ? response.players : [];
  const rows: AdpRow[] = [];
  for (const p of players) {
    const position = TRACKED_POSITIONS[(p.position ?? '').toUpperCase()];
    if (!position) continue;
    if (typeof p.adp !== 'number' || !Number.isFinite(p.adp)) continue;
    if (!p.name) continue;
    rows.push({
      name: p.name,
      position,
      team: p.team || undefined,
      adp: p.adp,
      stdDev: finiteOr(p.stdev),
      high: finiteOr(p.high),
      low: finiteOr(p.low),
    });
  }
  return {
    rows,
    asOf: response.meta?.end_date ?? '',
    sampleSize: response.meta?.total_drafts ?? rows.length,
    teams: response.meta?.teams ?? context.teams,
    scoring: context.scoring,
    season: context.season,
  };
}

function finiteOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Fetch full-PPR ADP from FantasyFootballCalculator, normalized and cached for the calendar day.
 * Throws on a non-OK response or a network/timeout error — the caller decides how to degrade
 * (the cheat-sheet command falls back to its research-only board).
 */
export async function fetchFfcAdp(options: FetchFfcAdpOptions): Promise<FfcAdp> {
  const teams = options.teams ?? 12;
  const scoring = options.scoring ?? 'ppr';
  const { season } = options;
  const day = (options.now ?? (() => new Date()))().toISOString().slice(0, 10);

  const cacheDir =
    options.cacheDir ?? process.env.FANTASY_CACHE_DIR ?? path.join(tmpdir(), 'fantasy-canon-cache');
  const cacheFile = path.join(cacheDir, `ffc-adp-${scoring}-${teams}t-${season}-${day}.json`);

  const cached = readCache(cacheFile);
  if (cached) return cached;

  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();

  let response: Response;
  try {
    response = await doFetch(ffcAdpUrl(scoring, teams, season), {
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
  const normalized = normalizeFfcAdp(json, { season, teams, scoring });
  writeCache(cacheDir, cacheFile, normalized);
  return normalized;
}

function readCache(file: string): FfcAdp | undefined {
  try {
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, 'utf8')) as FfcAdp;
  } catch {
    return undefined;
  }
}

function writeCache(dir: string, file: string, data: FfcAdp): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  } catch {
    // Best-effort cache; a write failure must never break the fetch.
  }
}
