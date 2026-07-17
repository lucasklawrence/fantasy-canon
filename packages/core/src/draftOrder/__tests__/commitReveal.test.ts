import { computeCommitment, verifyDraw } from '../commitReveal.js';
import { computeDraftOrder } from '../engine.js';
import {
  FIXTURE_BASE_BALL_COUNT,
  FIXTURE_EXPECTED_ORDER,
  FIXTURE_SEED,
  FIXTURE_TEAMS,
} from './fixtures.js';

describe('computeCommitment', () => {
  it('produces the pinned sha256 hex digest for the fixture seed', () => {
    expect(computeCommitment(FIXTURE_SEED)).toBe(
      'd9b38fba1fba82c31003d6f87ae1e1cf040e90b37cfbbd8767d4e018df63525e',
    );
  });

  it('is a 64-char lowercase hex string', () => {
    expect(computeCommitment('any-seed')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the seed changes', () => {
    expect(computeCommitment('seed-a')).not.toBe(computeCommitment('seed-b'));
  });
});

describe('verifyDraw', () => {
  it('round-trips: revealed seed + public config reproduce the announced order', () => {
    const config = { teams: FIXTURE_TEAMS, baseBallCount: FIXTURE_BASE_BALL_COUNT };
    const announced = computeDraftOrder({ seed: FIXTURE_SEED, ...config });

    const verification = verifyDraw(FIXTURE_SEED, config);

    expect(verification.draws).toEqual(announced);
    expect(verification.draws).toEqual(FIXTURE_EXPECTED_ORDER);
    expect(verification.commitment).toBe(computeCommitment(FIXTURE_SEED));
  });

  it('exposes a swapped seed: the commitment no longer matches the pre-draw post', () => {
    const config = { teams: FIXTURE_TEAMS, baseBallCount: FIXTURE_BASE_BALL_COUNT };
    const postedCommitment = computeCommitment(FIXTURE_SEED);

    const verification = verifyDraw('not-the-committed-seed', config);

    expect(verification.commitment).not.toBe(postedCommitment);
  });
});
