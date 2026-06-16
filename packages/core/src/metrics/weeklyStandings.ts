/**
 * Weekly standings: each team's cumulative league-table rank after every week of the
 * regular season. This is the data behind a season-long bump chart (rank on an inverted
 * axis over time) — the classic "where did each team sit in the table each week" view
 * (docs/14-data-surfacing-research.md §3).
 *
 * Pure and deterministic: no I/O. The caller supplies each team's per-week outcome and
 * points (derived from mScoreboard); ranking and accumulation happen here.
 */

export type Outcome = 'W' | 'L' | 'T';

export interface WeeklyResult {
  week: number;
  teamId: number;
  outcome: Outcome;
  /** Points scored that week — the standings tiebreaker. */
  points: number;
}

export interface WeeklyStandingLine {
  teamId: number;
  /** rank after each week; ranks[i] corresponds to weeks[i]. 1-based, 1 = first place. */
  ranks: number[];
}

export interface WeeklyStandings {
  /** Distinct weeks present, ascending. */
  weeks: number[];
  lines: WeeklyStandingLine[];
}

interface Totals {
  teamId: number;
  wins: number;
  ties: number;
  pointsFor: number;
}

/**
 * Compute the standings rank of every team after each week.
 *
 * Teams are ranked by win equivalents (wins + 0.5·ties) descending, then total points
 * for descending, then teamId ascending for a stable order — the conventional ESPN-style
 * ordering. A team with no result in a given week keeps its prior totals (bye) but is
 * still ranked that week. Every team appears in every week's ranking once it is known.
 */
export function computeWeeklyStandings(results: WeeklyResult[]): WeeklyStandings {
  const weeks = Array.from(new Set(results.map((r) => r.week))).sort((a, b) => a - b);
  const teamIds = Array.from(new Set(results.map((r) => r.teamId))).sort((a, b) => a - b);

  const byWeek = new Map<number, WeeklyResult[]>();
  for (const r of results) {
    const bucket = byWeek.get(r.week);
    if (bucket) bucket.push(r);
    else byWeek.set(r.week, [r]);
  }

  const totals = new Map<number, Totals>(
    teamIds.map((teamId) => [teamId, { teamId, wins: 0, ties: 0, pointsFor: 0 }]),
  );
  const rankSeries = new Map<number, number[]>(teamIds.map((teamId) => [teamId, []]));

  for (const week of weeks) {
    for (const r of byWeek.get(week) ?? []) {
      const t = totals.get(r.teamId);
      if (!t) continue;
      if (r.outcome === 'W') t.wins += 1;
      else if (r.outcome === 'T') t.ties += 1;
      t.pointsFor += r.points;
    }

    const ordered = teamIds
      .map((id) => totals.get(id) as Totals)
      .sort(
        (a, b) =>
          b.wins + 0.5 * b.ties - (a.wins + 0.5 * a.ties) ||
          b.pointsFor - a.pointsFor ||
          a.teamId - b.teamId,
      );

    ordered.forEach((t, idx) => {
      rankSeries.get(t.teamId)?.push(idx + 1);
    });
  }

  return {
    weeks,
    lines: teamIds.map((teamId) => ({ teamId, ranks: rankSeries.get(teamId) ?? [] })),
  };
}
