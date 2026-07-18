/**
 * Exact per-pick odds for the lottery: the probability of each team landing each draft slot
 * given the ball counts.
 *
 * The draw is weighted sampling without replacement over teams (drawing any of a team's balls
 * assigns the pick and removes the rest). Odds are computed exactly by dynamic programming over
 * subsets of already-drawn teams: `reached[S]` is the probability that the first `|S|` picks
 * went to exactly the teams in `S`, built up by drawing each remaining team with probability
 * `weight / remainingWeight`. O(2^n · n²) — about 590k operations for a 12-team league, so no
 * Monte Carlo fallback is needed at our scale.
 *
 * The odds model the ideal weighted draw. The engine's modulo bias (~2^-27, see `rng.ts`) is
 * orders of magnitude below anything visible in a rendered odds table and is ignored here.
 */
import { ballCountForTeam } from './engine.js';
import type { DraftOrderTeamInput } from './types.js';

/** Per-team odds row: `probabilities[k]` is the chance of landing pick `k + 1`. */
export interface TeamPickOdds {
  teamId: string;
  /** One entry per draft slot; each row sums to 1 (every team gets exactly one pick). */
  probabilities: number[];
}

/** Subset DP is O(2^n) — cap where it stays instant. Our league is 12 teams. */
const MAX_EXACT_TEAMS = 20;

/**
 * Exact odds of every team landing every pick, in the input team order. Weights come from
 * {@link ballCountForTeam}, so odds always agree with what {@link buildBallBag} puts in the bag.
 */
export function computePickOdds(teams: DraftOrderTeamInput[], baseBallCount = 1): TeamPickOdds[] {
  const n = teams.length;
  if (n === 0) {
    throw new Error('At least one team is required to compute odds');
  }
  if (n > MAX_EXACT_TEAMS) {
    throw new Error(`Exact odds are limited to ${MAX_EXACT_TEAMS} teams (got ${n})`);
  }
  const seen = new Set<string>();
  for (const team of teams) {
    if (seen.has(team.teamId)) {
      throw new Error(`Duplicate teamId detected: ${team.teamId}`);
    }
    seen.add(team.teamId);
  }

  const weights = teams.map((team) => ballCountForTeam(team, baseBallCount));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

  const size = 1 << n;
  // reached[mask] = probability the first popcount(mask) picks went to exactly these teams.
  const reached = new Float64Array(size);
  reached[0] = 1;
  const odds = teams.map(() => new Float64Array(n));

  // Ascending mask order is a valid topological order: mask | bit > mask.
  for (let mask = 0; mask < size; mask += 1) {
    const probability = reached[mask];
    if (probability === 0) {
      continue;
    }

    let drawnWeight = 0;
    let pickIndex = 0;
    for (let team = 0; team < n; team += 1) {
      if (mask & (1 << team)) {
        drawnWeight += weights[team];
        pickIndex += 1;
      }
    }
    if (pickIndex === n) {
      continue;
    }

    const remainingWeight = totalWeight - drawnWeight;
    for (let team = 0; team < n; team += 1) {
      if (mask & (1 << team)) {
        continue;
      }
      const drawProbability = (probability * weights[team]) / remainingWeight;
      odds[team][pickIndex] += drawProbability;
      reached[mask | (1 << team)] += drawProbability;
    }
  }

  return teams.map((team, index) => ({
    teamId: team.teamId,
    probabilities: Array.from(odds[index]),
  }));
}
