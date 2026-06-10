/**
 * Expected Wins via Monte Carlo simulation.
 *
 * A team's *actual* record depends on the schedule — who you happened to play
 * each week. "Expected wins" strips the schedule out: across many randomized
 * schedules (each week's teams re-paired at random), how many head-to-head wins
 * would this team average given only its weekly scores? A large gap between
 * actual and expected wins is the precise, defensible version of "lucky" or
 * "unlucky" — the schedule, not the scoring, drove the record.
 *
 * Pure and deterministic given a seed: no I/O, RNG is the seedable mulberry32
 * generator below so unit tests are reproducible. See
 * docs/14-data-surfacing-research.md §3 (FF Wrapped's 10,000-sim method).
 */

import type { WeeklyScore } from './allPlay.js';

export interface ExpectedWinsOptions {
  /** Number of randomized seasons to simulate. Default 10,000 (FF Wrapped's). */
  iterations?: number;
  /** Seed for the RNG. Same seed + same input → identical output. Default 1. */
  seed?: number;
}

export interface ExpectedWinsRecord {
  teamId: number;
  /** Mean head-to-head wins across all simulated random schedules. */
  expectedWins: number;
  /** Number of weeks the team appears in (its simulated games per season). */
  games: number;
}

/**
 * mulberry32 — a tiny, fast, seedable PRNG. Deterministic and platform-
 * independent (32-bit integer math + a single float division), so a given seed
 * yields the same stream everywhere. Not cryptographic; perfectly adequate for
 * shuffling matchups.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher–Yates shuffle using the supplied RNG. */
function shuffle<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

/**
 * Compute each team's expected wins from a flat list of weekly scores.
 *
 * Each iteration simulates one full random schedule: within every week the
 * teams present are shuffled and paired (1-2, 3-4, …); the higher score wins
 * (ties award half a win to each side). With an odd number of teams in a week,
 * the leftover team gets a bye (no game that week, that iteration). Expected
 * wins is the per-team mean across all iterations.
 *
 * The result is sorted by expectedWins descending, then teamId ascending. A
 * team's mean converges to its all-play win rate × games as iterations grow,
 * which the unit test relies on.
 */
export function computeExpectedWins(
  scores: WeeklyScore[],
  options: ExpectedWinsOptions = {},
): ExpectedWinsRecord[] {
  const iterations = Math.max(1, Math.floor(options.iterations ?? 10000));
  const rng = mulberry32(options.seed ?? 1);

  const byWeek = new Map<number, WeeklyScore[]>();
  const games = new Map<number, number>();
  for (const s of scores) {
    const bucket = byWeek.get(s.week);
    if (bucket) bucket.push(s);
    else byWeek.set(s.week, [s]);
    games.set(s.teamId, (games.get(s.teamId) ?? 0) + 1);
  }

  const totalWins = new Map<number, number>();
  const weeks = Array.from(byWeek.values());

  for (let iter = 0; iter < iterations; iter += 1) {
    for (const week of weeks) {
      if (week.length < 2) continue;
      const order = week.slice();
      shuffle(order, rng);
      // Pair adjacent entries; a trailing odd team byes (loop stops before it).
      for (let i = 0; i + 1 < order.length; i += 2) {
        const a = order[i];
        const b = order[i + 1];
        if (a.score > b.score) {
          totalWins.set(a.teamId, (totalWins.get(a.teamId) ?? 0) + 1);
        } else if (b.score > a.score) {
          totalWins.set(b.teamId, (totalWins.get(b.teamId) ?? 0) + 1);
        } else {
          totalWins.set(a.teamId, (totalWins.get(a.teamId) ?? 0) + 0.5);
          totalWins.set(b.teamId, (totalWins.get(b.teamId) ?? 0) + 0.5);
        }
      }
    }
  }

  const result: ExpectedWinsRecord[] = Array.from(games.keys()).map((teamId) => ({
    teamId,
    expectedWins: (totalWins.get(teamId) ?? 0) / iterations,
    games: games.get(teamId) ?? 0,
  }));

  result.sort((a, b) => b.expectedWins - a.expectedWins || a.teamId - b.teamId);
  return result;
}
