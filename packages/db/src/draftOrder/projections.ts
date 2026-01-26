import {
  BonusAward,
  DraftOrderTeamInput,
  ReactionAttempt,
  computeDraftOrder,
  scoreReactionGame
} from "@fantasy-canon/core";
import {
  DraftOrderDraw,
  DraftOrderGameAttempt,
  DraftOrderSession,
  DraftOrderTeam
} from "./types.js";

export interface DraftOrderProjectionTeam extends DraftOrderTeam {
  computedBonusBalls: number;
  totalBalls: number;
}

export interface DraftOrderProjection {
  session: DraftOrderSession;
  teams: DraftOrderProjectionTeam[];
  attempts: DraftOrderGameAttempt[];
  awards: BonusAward[];
  draws: DraftOrderDraw[];
}

export function buildDraftOrderProjection(params: {
  session: DraftOrderSession;
  teams: DraftOrderTeam[];
  attempts: DraftOrderGameAttempt[];
}): DraftOrderProjection {
  const { session, teams, attempts } = params;

  const reactionAttempts: ReactionAttempt[] = attempts.map((attempt) => ({
    teamId: attempt.teamId,
    reactionMs: attempt.reactionMs,
    status: attempt.status,
    attemptAt: attempt.attemptAt
  }));

  const reactionResult = scoreReactionGame(reactionAttempts);

  const teamsForLottery: DraftOrderTeamInput[] = teams.map((team) => ({
    teamId: team.teamId,
    baseBalls: team.baseBalls,
    bonusBalls: team.bonusBalls + (reactionResult.bonusByTeam[team.teamId] ?? 0),
    displayName: team.displayName,
    managerId: team.managerId
  }));

  const lotteryDraws = computeDraftOrder({
    seed: session.seed,
    baseBallCount: session.baseBallCount,
    teams: teamsForLottery
  }).map<DraftOrderDraw>((draw) => ({
    ballId: draw.ballId,
    teamId: draw.teamId,
    pick: draw.pick,
    drawIndex: draw.drawIndex
  }));

  const projectionTeams: DraftOrderProjectionTeam[] = teams.map((team) => ({
    ...team,
    computedBonusBalls: reactionResult.bonusByTeam[team.teamId] ?? 0,
    totalBalls: team.baseBalls + team.bonusBalls + (reactionResult.bonusByTeam[team.teamId] ?? 0)
  }));

  return {
    session,
    teams: projectionTeams,
    attempts,
    awards: reactionResult.awards,
    draws: lotteryDraws
  };
}
