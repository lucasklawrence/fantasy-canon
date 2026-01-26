export type DraftOrderSessionState = "CREATED" | "GAME_OPEN" | "LOTTERY_RUNNING" | "FINALIZED" | "CANCELLED" | "EXPIRED";

export interface DraftOrderSession {
  id: string;
  guildId: string;
  channelId?: string;
  leagueId?: string;
  seed: string;
  state: DraftOrderSessionState;
  baseBallCount: number;
  rerollOf?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  finalizedAt?: Date;
  cancelledAt?: Date;
  expiresAt?: Date;
}

export interface DraftOrderTeam {
  id: string;
  sessionId: string;
  teamId: string;
  displayName?: string;
  managerId?: string;
  baseBalls: number;
  bonusBalls: number;
  pickNumber?: number;
  createdAt: Date;
}

export type DraftOrderEventType =
  | "session_created"
  | "session_updated"
  | "team_registered"
  | "game_opened"
  | "mini_game_attempted"
  | "lottery_started"
  | "ball_drawn"
  | "finalized"
  | "cancelled"
  | "expired"
  | "rerolled";

export interface DraftOrderEvent<TPayload = unknown> {
  id: string;
  sessionId: string;
  seq: number;
  type: DraftOrderEventType;
  payload: TPayload;
  createdBy?: string;
  createdAt: Date;
}

export type DraftOrderAttemptStatus = "valid" | "early" | "invalid";

export interface DraftOrderGameAttempt {
  id: string;
  sessionId: string;
  teamId: string;
  status: DraftOrderAttemptStatus;
  reactionMs?: number;
  rawInput?: unknown;
  attemptAt: Date;
}

export interface DraftOrderDraw {
  ballId: string;
  teamId: string;
  pick: number;
  drawIndex?: number;
}
