/**
 * Power ranking from a transparent, published formula — so the ranking reads as
 * objective and debate-worthy rather than a black box, and so managers argue about
 * the *gap* between teams rather than the absolute number (see
 * docs/14-data-surfacing-research.md §2-3).
 *
 * Formula (Fantasy Football Wrapped's published composite):
 *
 *   score = ((avgWeeklyScore * 6) + ((highScore + lowScore) * 2) + (winPct * 400)) / 10
 *
 * It blends scoring volume (average), scoring ceiling/floor (best + worst week), and
 * win rate. Pure and deterministic: no I/O. The caller supplies each team's
 * regular-season weekly scores and record; everything else is derived here.
 */

export interface PowerRankingInput {
  teamId: number;
  /** Regular-season weekly scores. */
  weeklyScores: number[];
  wins: number;
  losses: number;
  ties?: number;
}

export interface PowerRankingEntry {
  teamId: number;
  /** Composite power-ranking score (higher is better). */
  score: number;
  /** 1-based rank after sorting by score descending. */
  rank: number;
  /** Score gap to the team ranked immediately above (0 for #1). */
  gap: number;
  /** Components, exposed so the ranking can be explained rather than asserted. */
  avgScore: number;
  highScore: number;
  lowScore: number;
  winPct: number;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Rank teams by the composite power-ranking score, highest first. Ties in score are
 * broken by teamId ascending for a stable order; tied teams still receive distinct
 * sequential ranks (no shared ranks), and `gap` is the difference to the line above.
 */
export function computePowerRanking(teams: PowerRankingInput[]): PowerRankingEntry[] {
  const scored = teams.map((t) => {
    const avgScore = mean(t.weeklyScores);
    const highScore = t.weeklyScores.length ? Math.max(...t.weeklyScores) : 0;
    const lowScore = t.weeklyScores.length ? Math.min(...t.weeklyScores) : 0;
    const games = t.wins + t.losses + (t.ties ?? 0);
    const winPct = games > 0 ? (t.wins + (t.ties ?? 0) * 0.5) / games : 0;
    const score = (avgScore * 6 + (highScore + lowScore) * 2 + winPct * 400) / 10;
    return { teamId: t.teamId, score, avgScore, highScore, lowScore, winPct };
  });

  scored.sort((a, b) => b.score - a.score || a.teamId - b.teamId);

  return scored.map((s, idx) => ({
    ...s,
    rank: idx + 1,
    gap: idx === 0 ? 0 : scored[idx - 1].score - s.score,
  }));
}
