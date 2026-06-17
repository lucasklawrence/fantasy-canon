/**
 * End-of-season awards: derive each award winner from per-team season summaries, mixing
 * serious honors with banter (docs/14-data-surfacing-research.md §5, Bucket B). Pure and
 * deterministic — the caller assembles each team's summary from the metrics already in
 * core (expected wins, all-play, lineup efficiency) plus mTeam/transactions, and this
 * module picks the winners. Feeds the awards recap card.
 *
 * Each award is emitted only when the data it needs is present, so partial inputs (e.g.
 * no draft projections) simply yield fewer awards rather than bogus ones.
 */

export interface SeasonTeamSummary {
  teamId: number;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  /** Per-week scores, for single-week extremes and consistency/volatility. */
  weeklyScores?: number[];
  /** Draft-day projected finish (1 = best), for riser/bust. */
  projectedRank?: number;
  /** Actual final finish (1 = best), for riser/bust. */
  finishRank?: number;
  /** Monte Carlo / all-play expected wins, for luck. */
  expectedWins?: number;
  /** All-play "Wins vs. All %" in [0,1], for true-skill. */
  allPlayWinPct?: number;
  /** Total roster moves (acquisitions/trades/etc.), for activity. */
  moves?: number;
}

export interface SeasonAward {
  /** Stable identifier. */
  key: string;
  label: string;
  emoji: string;
  teamId: number;
  /** Human-readable stat line for the card. */
  detail: string;
}

function record(t: SeasonTeamSummary): string {
  return t.ties > 0 ? `${t.wins}-${t.losses}-${t.ties}` : `${t.wins}-${t.losses}`;
}

function winEquivalents(t: SeasonTeamSummary): number {
  return t.wins + 0.5 * t.ties;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Pick the team maximizing `score`. Ties broken by teamId ascending (deterministic).
 * Returns undefined if no team is eligible (predicate filters out ineligible teams).
 */
function pick(
  teams: SeasonTeamSummary[],
  score: (t: SeasonTeamSummary) => number,
  eligible: (t: SeasonTeamSummary) => boolean = () => true,
): SeasonTeamSummary | undefined {
  let best: SeasonTeamSummary | undefined;
  let bestScore = -Infinity;
  for (const t of teams) {
    if (!eligible(t)) continue;
    const s = score(t);
    if (s > bestScore || (s === bestScore && best !== undefined && t.teamId < best.teamId)) {
      best = t;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Compute the season award winners from per-team summaries. Order is stable; awards whose
 * required inputs are missing across all teams are omitted.
 */
export function computeSeasonAwards(teams: SeasonTeamSummary[]): SeasonAward[] {
  if (teams.length === 0) return [];

  const awards: SeasonAward[] = [];
  const add = (
    key: string,
    label: string,
    emoji: string,
    winner: SeasonTeamSummary | undefined,
    detail: (t: SeasonTeamSummary) => string,
  ): void => {
    if (winner) awards.push({ key, label, emoji, teamId: winner.teamId, detail: detail(winner) });
  };

  // League MVP — best regular-season record (win equivalents, then points for).
  add(
    'mvp',
    'League MVP',
    '🏆',
    pick(teams, (t) => winEquivalents(t) * 1e6 + t.pointsFor),
    (t) => `${record(t)} • ${t.pointsFor.toFixed(1)} pts`,
  );

  // Points Champion — most total points for.
  add(
    'points-champ',
    'Points Champion',
    '📈',
    pick(teams, (t) => t.pointsFor),
    (t) => `${t.pointsFor.toFixed(1)} pts`,
  );

  // Toilet Bowl — worst record (fewest win equivalents, then fewest points).
  add(
    'toilet-bowl',
    'Toilet Bowl',
    '🚽',
    pick(teams, (t) => -(winEquivalents(t) * 1e6 + t.pointsFor)),
    (t) => `${record(t)} • ${t.pointsFor.toFixed(1)} pts`,
  );

  // Luckiest / Unluckiest — actual wins vs expected (needs expectedWins).
  const hasExpected = (t: SeasonTeamSummary): boolean => typeof t.expectedWins === 'number';
  add(
    'luckiest',
    'Luckiest',
    '🍀',
    pick(teams, (t) => t.wins - (t.expectedWins as number), hasExpected),
    (t) => `+${(t.wins - (t.expectedWins as number)).toFixed(1)} wins vs expected`,
  );
  add(
    'unluckiest',
    'Unluckiest',
    '😡',
    pick(teams, (t) => (t.expectedWins as number) - t.wins, hasExpected),
    (t) => `${(t.wins - (t.expectedWins as number)).toFixed(1)} wins vs expected`,
  );

  // True Skill — best all-play record (needs allPlayWinPct).
  add(
    'true-skill',
    'Best in the League (all-play)',
    '💪',
    pick(
      teams,
      (t) => t.allPlayWinPct as number,
      (t) => typeof t.allPlayWinPct === 'number',
    ),
    (t) => `${((t.allPlayWinPct as number) * 100).toFixed(1)}% vs all`,
  );

  // Biggest Riser / Bust — final vs draft projection (needs both ranks).
  const hasRanks = (t: SeasonTeamSummary): boolean =>
    typeof t.projectedRank === 'number' && typeof t.finishRank === 'number';
  add(
    'riser',
    'Biggest Riser',
    '🚀',
    pick(teams, (t) => (t.projectedRank as number) - (t.finishRank as number), hasRanks),
    (t) => `projected #${t.projectedRank} → finished #${t.finishRank}`,
  );
  add(
    'bust',
    'Bust of the Year',
    '📉',
    pick(teams, (t) => (t.finishRank as number) - (t.projectedRank as number), hasRanks),
    (t) => `projected #${t.projectedRank} → finished #${t.finishRank}`,
  );

  // Single-week extremes + consistency (need weeklyScores).
  const hasWeekly = (t: SeasonTeamSummary): boolean =>
    Array.isArray(t.weeklyScores) && t.weeklyScores.length > 0;
  add(
    'high-week',
    'Highest Single Week',
    '🔥',
    pick(teams, (t) => Math.max(...(t.weeklyScores as number[])), hasWeekly),
    (t) => `${Math.max(...(t.weeklyScores as number[])).toFixed(1)} pts`,
  );
  add(
    'low-week',
    'Lowest Single Week',
    '🥶',
    pick(teams, (t) => -Math.min(...(t.weeklyScores as number[])), hasWeekly),
    (t) => `${Math.min(...(t.weeklyScores as number[])).toFixed(1)} pts`,
  );
  const hasMultiWeek = (t: SeasonTeamSummary): boolean =>
    Array.isArray(t.weeklyScores) && t.weeklyScores.length >= 2;
  add(
    'volatile',
    'Most Volatile',
    '🎢',
    pick(teams, (t) => stdev(t.weeklyScores as number[]), hasMultiWeek),
    (t) => `±${stdev(t.weeklyScores as number[]).toFixed(1)} pts/week`,
  );
  add(
    'consistent',
    'Most Consistent',
    '🧊',
    pick(teams, (t) => -stdev(t.weeklyScores as number[]), hasMultiWeek),
    (t) => `±${stdev(t.weeklyScores as number[]).toFixed(1)} pts/week`,
  );

  // Wire Addict — most roster moves (needs moves).
  add(
    'wire-addict',
    'Wire Addict',
    '🔁',
    pick(
      teams,
      (t) => t.moves as number,
      (t) => typeof t.moves === 'number',
    ),
    (t) => `${t.moves} moves`,
  );

  return awards;
}
