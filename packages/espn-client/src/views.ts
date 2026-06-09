export const DEFAULT_VIEWS = [
  'mTeam',
  'mRoster',
  'mTransactions',
  'mTransactions2',
  'mDraftDetail',
] as const;

export type DefaultView = (typeof DEFAULT_VIEWS)[number];
