import { BonusAward, ReactionAttempt, ReactionGameResult } from "./types.js";

function dedupeAttempts(attempts: ReactionAttempt[]): ReactionAttempt[] {
  const byTeam = new Map<string, ReactionAttempt>();

  const sorted = [...attempts].sort((a, b) => a.attemptAt.getTime() - b.attemptAt.getTime());
  for (const attempt of sorted) {
    if (!byTeam.has(attempt.teamId)) {
      byTeam.set(attempt.teamId, attempt);
    }
  }

  return Array.from(byTeam.values());
}

export function scoreReactionGame(attempts: ReactionAttempt[]): ReactionGameResult {
  const firstAttempts = dedupeAttempts(attempts);
  const valid = firstAttempts.filter((attempt) => attempt.status === "valid" && typeof attempt.reactionMs === "number");

  const ranked = valid
    .slice()
    .sort((a, b) => {
      if (a.reactionMs === b.reactionMs) {
        return a.teamId.localeCompare(b.teamId);
      }
      // Type guard above ensures numbers
      return (a.reactionMs as number) - (b.reactionMs as number);
    })
    .map<BonusAward>((attempt, index) => ({
      teamId: attempt.teamId,
      bonusBalls: index === 0 ? 2 : index === 1 ? 1 : 0,
      rank: index + 1,
      reactionMs: attempt.reactionMs as number
    }))
    .filter((award) => award.bonusBalls > 0);

  const bonusByTeam = ranked.reduce<Record<string, number>>((acc, award) => {
    acc[award.teamId] = award.bonusBalls;
    return acc;
  }, {});

  return { awards: ranked, bonusByTeam, rankedTeams: ranked };
}
