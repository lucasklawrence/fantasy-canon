import type { WeeklyScore } from '@fantasy-canon/core';

function ensureNumber(val: unknown): number | undefined {
  const num = Number(val);
  return Number.isFinite(num) ? num : undefined;
}

/**
 * Flatten an mScoreboard payload into per-team weekly scores. Handles both the
 * `home`/`away` matchup shape and the `teams[]` shape, mirroring rivalries.ts.
 * The week is taken from matchupPeriodId (falling back to scoringPeriodId); a
 * missing/invalid score is treated as 0 so the team still counts that week.
 *
 * Shared by /canon allplay, the luck command, and the luck graph — anything
 * that needs schedule-independent weekly scores.
 */
export function extractWeeklyScores(payload: unknown): WeeklyScore[] {
  const out: WeeklyScore[] = [];
  if (!payload || typeof payload !== 'object') return out;
  const maybeSchedule = (payload as { schedule?: unknown }).schedule;
  const maybeMatchups = (payload as { matchups?: unknown }).matchups;
  const source = Array.isArray(maybeSchedule)
    ? maybeSchedule
    : Array.isArray(maybeMatchups)
      ? maybeMatchups
      : [];

  for (const m of source) {
    if (!m || typeof m !== 'object') continue;
    const week =
      ensureNumber((m as { matchupPeriodId?: unknown }).matchupPeriodId) ??
      ensureNumber((m as { scoringPeriodId?: unknown }).scoringPeriodId);
    if (week === undefined) continue;

    const home = (m as { home?: unknown }).home;
    const away = (m as { away?: unknown }).away;
    if (home && typeof home === 'object' && away && typeof away === 'object') {
      pushSide(out, week, home);
      pushSide(out, week, away);
      continue;
    }
    const teams = (m as { teams?: unknown }).teams;
    if (Array.isArray(teams)) {
      for (const t of teams as unknown[]) {
        if (t && typeof t === 'object') pushSide(out, week, t);
      }
    }
  }
  return out;
}

function pushSide(out: WeeklyScore[], week: number, side: object): void {
  const teamId = ensureNumber((side as { teamId?: unknown }).teamId);
  if (teamId === undefined) return;
  const score = ensureNumber((side as { totalPoints?: unknown }).totalPoints) ?? 0;
  out.push({ week, teamId, score });
}
