/**
 * All-play record ("Wins vs. All %"): for each scoring week, compare every team's
 * score against every *other* team's score that same week. A team's all-play record
 * is its aggregate W-L-T across those pairwise comparisons over the whole season.
 *
 * Unlike a head-to-head record (which depends on the schedule), the all-play record
 * reveals true strength independent of who you happened to play — the team with the
 * highest "Wins vs. All %" is the one that scored well most consistently.
 *
 * Pure and deterministic: no I/O, no RNG. See docs/14-data-surfacing-research.md §3.
 */

export interface WeeklyScore {
  /** Scoring period (week) the score belongs to. */
  week: number;
  teamId: number;
  /** Points the team scored that week. */
  score: number;
}

export interface AllPlayRecord {
  teamId: number;
  /** Pairwise comparisons won (scored higher than another team that week). */
  wins: number;
  /** Pairwise comparisons lost (scored lower). */
  losses: number;
  /** Pairwise comparisons tied (equal score). */
  ties: number;
  /**
   * Wins vs. All %: wins / (wins + losses + ties), in [0, 1]. Ties count as
   * neither a win nor a loss but are included in the denominator, matching the
   * convention that an all-play "game" was still played. 0 when no comparisons.
   */
  winPct: number;
}

/**
 * Compute each team's all-play record from a flat list of weekly scores.
 *
 * Scores are grouped by week internally; within a week each team is compared to
 * every other team present that week. Weeks with fewer than two teams contribute
 * no comparisons. The result is sorted by winPct descending, then wins descending,
 * then teamId ascending for a stable order.
 */
export function computeAllPlayRecord(scores: WeeklyScore[]): AllPlayRecord[] {
  const byWeek = new Map<number, WeeklyScore[]>();
  for (const s of scores) {
    const bucket = byWeek.get(s.week);
    if (bucket) bucket.push(s);
    else byWeek.set(s.week, [s]);
  }

  const records = new Map<number, AllPlayRecord>();
  const ensure = (teamId: number): AllPlayRecord => {
    let rec = records.get(teamId);
    if (!rec) {
      rec = { teamId, wins: 0, losses: 0, ties: 0, winPct: 0 };
      records.set(teamId, rec);
    }
    return rec;
  };

  for (const week of byWeek.values()) {
    for (let i = 0; i < week.length; i += 1) {
      // Every team that appears gets a record even if it has no opponents that week.
      const a = ensure(week[i].teamId);
      for (let j = 0; j < week.length; j += 1) {
        if (i === j) continue;
        const other = week[j];
        if (week[i].score > other.score) a.wins += 1;
        else if (week[i].score < other.score) a.losses += 1;
        else a.ties += 1;
      }
    }
  }

  const result = Array.from(records.values());
  for (const rec of result) {
    const total = rec.wins + rec.losses + rec.ties;
    rec.winPct = total === 0 ? 0 : rec.wins / total;
  }

  result.sort((a, b) => b.winPct - a.winPct || b.wins - a.wins || a.teamId - b.teamId);
  return result;
}
