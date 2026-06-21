import { InMemoryCanonEventsRepo, type CanonEventCreate } from '@fantasy-canon/db';
import type { BotContext } from '../../config.js';
import { TeamNameCache } from '../teamNameCache.js';

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
  /** `env.defaultLeagueId` — the league a command falls back to when none is configured. */
  defaultLeagueId?: string;
  /** guildId → stored guild config, resolved by `leagueConfigRepo.getByGuildId`. */
  guildConfigs?: Record<string, { leagueId?: string }>;
  /** Canon events already in the store (the timeline reads these via `canonEventsRepo.list`). */
  canonEvents?: CanonEventCreate[];
}

export interface MockContextHandle {
  context: BotContext;
  /** Every `fetchLeague` call, in order. */
  fetchCalls: Array<{ view: string; scoringPeriodId?: number }>;
  /** Snapshots persisted via `snapshotsRepo.save`. */
  saved: MockSnapshot[];
  /** Each `teamNameCache.set` (leagueId/season + how many choices). */
  cacheSets: Array<{ leagueId: string; season: number; count: number }>;
  /** The real in-memory canon-events repo — assert against it after `champ`/seed via options. */
  canonEventsRepo: InMemoryCanonEventsRepo;
  /** The real autocomplete name cache — `scout` warms it; the autocomplete reads it back. */
  teamNameCache: TeamNameCache;
}

/**
 * Build a `BotContext` whose `snapshotsRepo`, `espnClient`, and `leagueConfigRepo` are
 * in-memory fakes — enough to exercise the cache-then-fetch lib helpers and the `/canon`
 * command handlers without touching ESPN, a database, or discord. `canonEventsRepo` and
 * `teamNameCache` are the *real* in-memory implementations so the champ/timeline event flow
 * and the scout autocomplete name cache round-trip exactly as they do in production. Only the
 * surface the code actually uses is implemented; the rest is intentionally absent (cast
 * through `unknown`).
 */
export function createMockContext(opts: MockContextOptions = {}): MockContextHandle {
  const seeded = opts.snapshots ?? [];
  const saved: MockSnapshot[] = [];
  const fetchCalls: Array<{ view: string; scoringPeriodId?: number }> = [];
  const cacheSets: Array<{ leagueId: string; season: number; count: number }> = [];

  const canonEventsRepo = new InMemoryCanonEventsRepo();
  // `add` pushes synchronously before resolving, so fire-and-forget seeding is deterministic.
  for (const event of opts.canonEvents ?? []) {
    void canonEventsRepo.add(event);
  }

  // A real cache, but `set` is wrapped so tests can still assert on cache-warming calls.
  const teamNameCache = new TeamNameCache();
  const realSet = teamNameCache.set.bind(teamNameCache);
  teamNameCache.set = (leagueId, season, choices): void => {
    cacheSets.push({ leagueId, season, count: choices.length });
    realSet(leagueId, season, choices);
  };

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
    teamNameCache,
    leagueConfigRepo: {
      getByGuildId: (guildId: string): Promise<{ leagueId?: string } | undefined> =>
        Promise.resolve(opts.guildConfigs?.[guildId]),
    },
    canonEventsRepo,
    env: { defaultLeagueId: opts.defaultLeagueId },
  } as unknown as BotContext;

  return { context, fetchCalls, saved, cacheSets, canonEventsRepo, teamNameCache };
}
