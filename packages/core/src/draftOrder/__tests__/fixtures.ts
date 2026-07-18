import type { DraftOrderTeamInput, LotteryDraw } from '../types.js';

/** Shared lottery fixture: a bonus-skewed six-team field with a fixed seed. */
export const FIXTURE_SEED = 'canon-2026-lottery';
export const FIXTURE_TEAMS: DraftOrderTeamInput[] = [
  { teamId: 'alpha', bonusBalls: 2 },
  { teamId: 'bravo', bonusBalls: 1 },
  { teamId: 'charlie' },
  { teamId: 'delta', bonusBalls: 3 },
  { teamId: 'echo' },
  { teamId: 'foxtrot', baseBalls: 3 },
];
export const FIXTURE_BASE_BALL_COUNT = 2;

/** The exact order the fixture must reproduce forever — pinned so replays stay auditable. */
export const FIXTURE_EXPECTED_ORDER: LotteryDraw[] = [
  { pick: 1, drawIndex: 0, ballId: 'alpha:2', teamId: 'alpha' },
  { pick: 2, drawIndex: 1, ballId: 'foxtrot:2', teamId: 'foxtrot' },
  { pick: 3, drawIndex: 2, ballId: 'delta:3', teamId: 'delta' },
  { pick: 4, drawIndex: 3, ballId: 'bravo:2', teamId: 'bravo' },
  { pick: 5, drawIndex: 4, ballId: 'charlie:1', teamId: 'charlie' },
  { pick: 6, drawIndex: 5, ballId: 'echo:1', teamId: 'echo' },
];
