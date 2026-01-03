export const DEFAULT_VIEWS = ["mTeam", "mRoster", "mTransactions", "mDraftDetail"] as const;

export type DefaultView = (typeof DEFAULT_VIEWS)[number];
