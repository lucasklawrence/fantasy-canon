import type { BotContext } from '../../config.js';

/** Minimal snapshot record shape the lib helpers read/write. */
export interface MockSnapshot {
  leagueId: string;
  season: number;
  view: string;
  fetchedAt: Date;
  payload: unknown;
}

export interface MockContextOptions {
  /** Snapshots already in the store (a cache hit for matching league/season/view). */
  snapshots?: MockSnapshot[];
  /** view → payload that `espnClient.fetchLeague` returns on a cache miss. */
  fetchPayloads?: Record<string, unknown>;
  /** Views for which `fetchLeague` should reject (simulate an ESPN failure). */
  fetchThrows?: string[];
}

export interface MockContextHandle {
  context: BotContext;
  /** Every `fetchLeague` call, in order. */
  fetchCalls: Array<{ view: string; scoringPeriodId?: number }>;
  /** Snapshots persisted via `snapshotsRepo.save`. */
  saved: MockSnapshot[];
  /** Each `teamNameCache.set` (leagueId/season + how many choices). */
  cacheSets: Array<{ leagueId: string; season: number; count: number }>;
}

/**
 * Build a `BotContext` whose `snapshotsRepo`, `espnClient`, and `teamNameCache` are
 * in-memory fakes — enough to exercise the cache-then-fetch lib helpers without touching
 * ESPN, a database, or discord. Only the surface the helpers actually use is implemented;
 * the rest is intentionally absent (cast through `unknown`).
 */
export function createMockContext(opts: MockContextOptions = {}): MockContextHandle {
  const seeded = opts.snapshots ?? [];
  const saved: MockSnapshot[] = [];
  const fetchCalls: Array<{ view: string; scoringPeriodId?: number }> = [];
  const cacheSets: Array<{ leagueId: string; season: number; count: number }> = [];

  const context = {
    snapshotsRepo: {
      listBySeason: (leagueId: string, season: number): Promise<MockSnapshot[]> =>
        Promise.resolve(
          [...seeded, ...saved].filter((s) => s.leagueId === leagueId && s.season === season),
        ),
      save: (snap: MockSnapshot): Promise<void> => {
        saved.push(snap);
        return Promise.resolve();
      },
    },
    espnClient: {
      fetchLeague: (params: {
        view: string;
        scoringPeriodId?: number;
      }): Promise<{ url: string; status: number; payload: unknown }> => {
        fetchCalls.push({ view: params.view, scoringPeriodId: params.scoringPeriodId });
        if (opts.fetchThrows?.includes(params.view)) {
          return Promise.reject(new Error(`mock fetch failure for ${params.view}`));
        }
        return Promise.resolve({
          url: 'mock://league',
          status: 200,
          payload: opts.fetchPayloads?.[params.view] ?? {},
        });
      },
    },
    teamNameCache: {
      set: (leagueId: string, season: number, choices: unknown[]): void => {
        cacheSets.push({ leagueId, season, count: choices.length });
      },
    },
  } as unknown as BotContext;

  return { context, fetchCalls, saved, cacheSets };
}
