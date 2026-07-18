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
