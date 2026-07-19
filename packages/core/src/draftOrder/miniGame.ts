/**
 * The reaction-time mini-game (#166) — the one pre-ceremony act that earns bonus balls.
 * Ported from the retired `draftOrder` branch's MVP design: dedupe to each team's first
 * attempt, rank valid attempts by reaction time, award rank 1 → +2 balls and rank 2 → +1.
 *
 * Pure scoring only: the bot layer captures button timing and feeds `ReactionAttempt[]`;
 * the results here feed `DraftOrderTeamInput.bonusBalls` — and MUST be publicly posted
 * before the ceremony's commitment, so the commitment binds the final locked bag
 * (ADR 0006 fairness ordering).
 */
import type { BonusAward, ReactionAttempt, ReactionGameResult } from './types.js';

/** Bonus balls by 1-based finishing rank; ranks past the end earn 0. */
export const REACTION_RANK_BONUSES: readonly number[] = [2, 1];

/** Each team's earliest attempt, whatever its status — later clicks never override a spent one. */
function firstAttemptPerTeam(attempts: ReactionAttempt[]): ReactionAttempt[] {
  const byTeam = new Map<string, ReactionAttempt>();
  const sorted = [...attempts].sort((a, b) => a.attemptAt.getTime() - b.attemptAt.getTime());
  for (const attempt of sorted) {
    if (!byTeam.has(attempt.teamId)) {
      byTeam.set(attempt.teamId, attempt);
    }
  }
  return [...byTeam.values()];
}

/**
 * Score a reaction round: dedupe to first attempt per team, keep `valid` attempts with a
 * recorded time, rank fastest-first (ties broken by `teamId` so results are deterministic),
 * and award {@link REACTION_RANK_BONUSES}. A team whose first attempt was a false start
 * (`early`) has spent its attempt and cannot score.
 */
export function scoreReactionGame(attempts: ReactionAttempt[]): ReactionGameResult {
  const ranking: BonusAward[] = firstAttemptPerTeam(attempts)
    .filter(
      (attempt): attempt is ReactionAttempt & { reactionMs: number } =>
        attempt.status === 'valid' && typeof attempt.reactionMs === 'number',
    )
    .sort((a, b) => a.reactionMs - b.reactionMs || a.teamId.localeCompare(b.teamId))
    .map((attempt, index) => ({
      teamId: attempt.teamId,
      bonusBalls: REACTION_RANK_BONUSES[index] ?? 0,
      rank: index + 1,
      reactionMs: attempt.reactionMs,
    }));

  const awards = ranking.filter((award) => award.bonusBalls > 0);
  const bonusByTeam: Record<string, number> = {};
  for (const award of awards) {
    bonusByTeam[award.teamId] = award.bonusBalls;
  }
  return { ranking, awards, bonusByTeam };
}
