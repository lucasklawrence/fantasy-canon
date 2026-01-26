export type DraftOrderState = "CREATED" | "GAME_OPEN" | "LOTTERY_RUNNING" | "FINALIZED" | "CANCELLED" | "EXPIRED";
export type DraftOrderAttemptStatus = "valid" | "early" | "invalid";
export interface DraftOrderTeamInput {
    teamId: string;
    displayName?: string;
    managerId?: string;
    baseBalls?: number;
    bonusBalls?: number;
}
export interface ReactionAttempt {
    teamId: string;
    reactionMs?: number;
    status: DraftOrderAttemptStatus;
    attemptAt: Date;
}
export interface BonusAward {
    teamId: string;
    bonusBalls: number;
    rank: number;
    reactionMs: number;
}
export interface ReactionGameResult {
    awards: BonusAward[];
    bonusByTeam: Record<string, number>;
    rankedTeams: BonusAward[];
}
export interface LotteryDraw {
    pick: number;
    drawIndex: number;
    ballId: string;
    teamId: string;
}
export interface LotteryInput {
    seed: string;
    teams: DraftOrderTeamInput[];
    baseBallCount?: number;
}
