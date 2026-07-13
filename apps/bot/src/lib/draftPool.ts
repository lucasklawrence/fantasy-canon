/**
 * Shared draft-pool loader for the `/canon draft …` commands. Parses every archived research
 * report that carries a board, merges them, then overlays live market ADP
 * (FantasyFootballCalculator) so the pool is market-priced and runs the full draft deep. The ADP
 * fetch is best-effort — on any failure we fall back to the research-only board rather than fail.
 *
 * Both `cheatsheet` (one-shot board) and the live `start|pick|best` session read from here, so they
 * rank against an identical pool.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mergeAdpIntoPool,
  mergeRankings,
  parseRankingsReport,
  type FadeEntry,
  type PlayerTier,
} from '@fantasy-canon/core';
import { fetchFfcAdp } from './ffcAdp.js';

/** Starting lineup + bench for our standing 12-team league. Drives replacement baselines. */
export const ROSTER_SLOTS: Record<string, number> = {
  QB: 1,
  RB: 2,
  WR: 2,
  TE: 1,
  FLEX: 1,
  K: 1,
  DST: 1,
  BENCH: 6,
};
export const ROSTER_SIZE = Object.values(ROSTER_SLOTS).reduce((a, b) => a + b, 0);

/** Provenance for the live ADP overlay, surfaced to callers so stale data is detectable. */
export interface AdpProvenance {
  asOf: string;
  sampleSize: number;
  /** How many ADP-only players deepened the research board. */
  added: number;
}

export interface LoadedRankings {
  players: PlayerTier[];
  fades: FadeEntry[];
  latestDate: string;
  adp?: AdpProvenance;
}

/**
 * Build the draft pool: research boards merged, then live ADP overlaid (best-effort). Returns an
 * empty pool (never throws) when no research board is present.
 */
export async function loadRankings(): Promise<LoadedRankings> {
  const dir = resolveResearchDir();
  if (!dir) return { players: [], fades: [], latestDate: '' };

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'TEMPLATE.md' && f !== 'INDEX.md')
    .sort();

  const parsed = files.map((file) =>
    parseRankingsReport(readFileSync(path.join(dir, file), 'utf8'), file),
  );
  const withBoards = parsed.filter((p) => p.players.length > 0);
  const merged = mergeRankings(withBoards);
  const latestDate =
    withBoards
      .map((p) => p.meta.date)
      .filter(Boolean)
      .sort()
      .at(-1) ?? '';

  let players = merged.players;
  let adp: AdpProvenance | undefined;
  try {
    const feed = await fetchFfcAdp({ season: resolveSeason() });
    if (feed.rows.length > 0) {
      const researchCount = players.length;
      players = mergeAdpIntoPool(players, feed.rows);
      adp = { asOf: feed.asOf, sampleSize: feed.sampleSize, added: players.length - researchCount };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[draft] live ADP unavailable, using research board only: ${message}`);
  }

  return { players, fades: merged.fades, latestDate, adp };
}

/** NFL season for the ADP feed — the current calendar year, overridable via `FANTASY_SEASON`. */
export function resolveSeason(): number {
  const override = Number(process.env.FANTASY_SEASON);
  if (Number.isInteger(override) && override > 2000) return override;
  return new Date().getFullYear();
}

/** Locate the repo-root `research/` directory, tolerant of where the bot process was started. */
export function resolveResearchDir(): string | undefined {
  const candidates: string[] = [];
  if (process.env.FANTASY_RESEARCH_DIR) candidates.push(process.env.FANTASY_RESEARCH_DIR);

  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    candidates.push(path.join(dir, 'research'));
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  candidates.push(path.join(process.cwd(), 'research'));

  return candidates.find((c) => existsSync(c));
}
