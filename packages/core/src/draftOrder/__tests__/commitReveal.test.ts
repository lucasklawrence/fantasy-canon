import {
  commitmentPreimage,
  composeDrawSeed,
  computeCommitment,
  DRAW_ALGORITHM,
  verifyDraw,
  verifyHardenedDraw,
} from '../commitReveal.js';
import { computeDraftOrder } from '../engine.js';
import {
  FIXTURE_BASE_BALL_COUNT,
  FIXTURE_EXPECTED_ORDER,
  FIXTURE_SEED,
  FIXTURE_TEAMS,
} from './fixtures.js';

const FIXTURE_CONFIG = { teams: FIXTURE_TEAMS, baseBallCount: FIXTURE_BASE_BALL_COUNT };

describe('commitmentPreimage', () => {
  it('locks the algorithm version, seed, and resolved ball counts in draw order', () => {
    const preimage = JSON.parse(commitmentPreimage(FIXTURE_SEED, FIXTURE_CONFIG)) as {
      algorithm: string;
      seed: string;
      baseBallCount: number;
      teams: { teamId: string; balls: number }[];
    };

    expect(preimage.algorithm).toBe(DRAW_ALGORITHM);
    expect(preimage.seed).toBe(FIXTURE_SEED);
    expect(preimage.baseBallCount).toBe(FIXTURE_BASE_BALL_COUNT);
    expect(preimage.teams).toEqual([
      { teamId: 'alpha', balls: 4 },
      { teamId: 'bravo', balls: 3 },
      { teamId: 'charlie', balls: 2 },
      { teamId: 'delta', balls: 5 },
      { teamId: 'echo', balls: 2 },
      { teamId: 'foxtrot', balls: 3 },
    ]);
  });
});

describe('computeCommitment', () => {
  it('produces the pinned sha256 hex digest for the fixture seed and config', () => {
    expect(computeCommitment(FIXTURE_SEED, FIXTURE_CONFIG)).toBe(
      '30c210e0deb3739a730e9a2336ce3840b10cfc9c87135919d1b9e08f8ff24d81',
    );
  });

  it('is a 64-char lowercase hex string', () => {
    expect(computeCommitment('any-seed', { teams: [{ teamId: 'a' }] })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the seed changes', () => {
    const config = { teams: [{ teamId: 'a' }] };
    expect(computeCommitment('seed-a', config)).not.toBe(computeCommitment('seed-b', config));
  });

  it('refuses to commit to a config the engine would reject', () => {
    expect(() => computeCommitment('seed', { teams: [{ teamId: 'a' }, { teamId: 'a' }] })).toThrow(
      'Duplicate teamId',
    );
  });

  it('changes when the bag changes — the commitment binds the config, not just the seed', () => {
    const committed = computeCommitment(FIXTURE_SEED, FIXTURE_CONFIG);
    const tamperedTeams = FIXTURE_TEAMS.map((team) =>
      team.teamId === 'charlie' ? { ...team, bonusBalls: 5 } : team,
    );

    expect(
      computeCommitment(FIXTURE_SEED, {
        teams: tamperedTeams,
        baseBallCount: FIXTURE_BASE_BALL_COUNT,
      }),
    ).not.toBe(committed);
  });
});

describe('composeDrawSeed', () => {
  it('joins secret and salt deterministically', () => {
    expect(composeDrawSeed('secret', '123456789')).toBe('secret|123456789');
  });

  it('different salts change the draw a committed secret produces', () => {
    const orderA = computeDraftOrder({
      seed: composeDrawSeed(FIXTURE_SEED, 'salt-a'),
      ...FIXTURE_CONFIG,
    });
    const orderB = computeDraftOrder({
      seed: composeDrawSeed(FIXTURE_SEED, 'salt-b'),
      ...FIXTURE_CONFIG,
    });

    expect(orderA.map((d) => d.teamId)).not.toEqual(orderB.map((d) => d.teamId));
  });

  it('round-trips through verifyDraw: composed seed replays the announced order', () => {
    const drawSeed = composeDrawSeed(FIXTURE_SEED, 'commit-message-id');
    const announced = computeDraftOrder({ seed: drawSeed, ...FIXTURE_CONFIG });

    expect(verifyDraw(drawSeed, FIXTURE_CONFIG).draws).toEqual(announced);
  });

  it('rejects empty inputs', () => {
    expect(() => composeDrawSeed('', 'salt')).toThrow('secretSeed');
    expect(() => composeDrawSeed('secret', '')).toThrow('publicSalt');
  });
});

describe('verifyHardenedDraw', () => {
  it('binds the commitment to the secret while replaying from the composed seed', () => {
    const verification = verifyHardenedDraw(FIXTURE_SEED, 'commit-msg-id', FIXTURE_CONFIG);

    expect(verification.commitment).toBe(computeCommitment(FIXTURE_SEED, FIXTURE_CONFIG));
    expect(verification.drawSeed).toBe(composeDrawSeed(FIXTURE_SEED, 'commit-msg-id'));
    expect(verification.draws).toEqual(
      computeDraftOrder({ seed: verification.drawSeed, ...FIXTURE_CONFIG }),
    );
  });
});

describe('verifyDraw', () => {
  it('round-trips: revealed seed + public config reproduce the announced order', () => {
    const announced = computeDraftOrder({ seed: FIXTURE_SEED, ...FIXTURE_CONFIG });

    const verification = verifyDraw(FIXTURE_SEED, FIXTURE_CONFIG);

    expect(verification.draws).toEqual(announced);
    expect(verification.draws).toEqual(FIXTURE_EXPECTED_ORDER);
    expect(verification.commitment).toBe(computeCommitment(FIXTURE_SEED, FIXTURE_CONFIG));
  });

  it('exposes a swapped seed: the commitment no longer matches the pre-draw post', () => {
    const postedCommitment = computeCommitment(FIXTURE_SEED, FIXTURE_CONFIG);

    const verification = verifyDraw('not-the-committed-seed', FIXTURE_CONFIG);

    expect(verification.commitment).not.toBe(postedCommitment);
  });
});
