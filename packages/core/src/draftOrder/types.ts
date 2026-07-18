/** Lifecycle states for a draft-order lottery ceremony. See `state.ts` for allowed transitions. */
export type DraftOrderState =
  'CREATED' | 'GAME_OPEN' | 'LOTTERY_RUNNING' | 'FINALIZED' | 'CANCELLED' | 'EXPIRED';

/** One team entering the lottery, with its ball counts. */
export interface DraftOrderTeamInput {
  /**
   * Stable identifier used in ball ids (`teamId:ballNumber`) and draw results. Must not contain
   * `:` — it's the ball-id delimiter (see {@link encodeBallId} in `engine.ts`).
   */
  teamId: string;
  displayName?: string;
  managerId?: string;
  /** Overrides the lottery-wide base ball count for this team. */
  baseBalls?: number;
  /** Extra balls earned on top of the base (e.g. from the mini-game, #166). Defaults to 0. */
  bonusBalls?: number;
}

/** One completed draw: the ball pulled at `drawIndex` assigned `teamId` draft slot `pick`. */
export interface LotteryDraw {
  /** 1-based draft slot this draw assigns. */
  pick: number;
  /** 0-based index into the deterministic hash stream (`sha256(seed:drawIndex)`). */
  drawIndex: number;
  /** The drawn ball, encoded `teamId:ballNumber`. */
  ballId: string;
  teamId: string;
}

/** Full input to {@link computeDraftOrder}: the secret seed plus the public lottery config. */
export interface LotteryInput {
  seed: string;
  teams: DraftOrderTeamInput[];
  /** Balls every team gets before per-team `baseBalls` overrides and bonuses. Defaults to 1. */
  baseBallCount?: number;
}

/**
 * Outcome of one reaction-round attempt. `valid` competes for bonus balls; `early` is a false
 * start (clicked before GO — the attempt is spent and scores nothing); `invalid` is any other
 * discard (e.g. clicked after the window closed).
 */
export type DraftOrderAttemptStatus = 'valid' | 'early' | 'invalid';

/** One team's reaction-round attempt, as captured by the bot layer (#166). */
export interface ReactionAttempt {
  teamId: string;
  /** Milliseconds from GO to the click. Only meaningful when `status` is `valid`. */
  reactionMs?: number;
  status: DraftOrderAttemptStatus;
  /** When the attempt landed — dedupe keeps each team's earliest. */
  attemptAt: Date;
}

/** One ranked finisher of the reaction round and the bonus balls that rank earned. */
export interface BonusAward {
  teamId: string;
  /** Bonus balls earned: rank 1 → 2, rank 2 → 1, everyone else 0. */
  bonusBalls: number;
  /** 1-based finishing position among valid attempts. */
  rank: number;
  reactionMs: number;
}

/** Scored reaction round. See {@link scoreReactionGame} in `miniGame.ts`. */
export interface ReactionGameResult {
  /** Every valid attempt, fastest first — including rank ≥ 3 finishers with 0 bonus balls. */
  ranking: BonusAward[];
  /** Just the bonus-earning awards (the top two), fastest first. */
  awards: BonusAward[];
  /** teamId → bonus balls for the engine config; teams that earned nothing are absent. */
  bonusByTeam: Record<string, number>;
}
