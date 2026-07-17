import { buildBallBag, computeDraftOrder, encodeBallId } from '../engine.js';
import {
  FIXTURE_BASE_BALL_COUNT,
  FIXTURE_EXPECTED_ORDER,
  FIXTURE_SEED,
  FIXTURE_TEAMS,
} from './fixtures.js';

describe('buildBallBag', () => {
  it('gives each team base + bonus balls with stable ids', () => {
    const bag = buildBallBag([{ teamId: 'a', bonusBalls: 1 }, { teamId: 'b' }], 2);
    expect(bag).toEqual(['a:1', 'a:2', 'a:3', 'b:1', 'b:2']);
  });

  it('lets baseBalls override the lottery-wide base count', () => {
    const bag = buildBallBag([{ teamId: 'a', baseBalls: 1 }, { teamId: 'b' }], 3);
    expect(bag).toEqual(['a:1', 'b:1', 'b:2', 'b:3']);
  });

  it('rejects duplicate team ids', () => {
    expect(() => buildBallBag([{ teamId: 'a' }, { teamId: 'a' }])).toThrow('Duplicate teamId');
  });

  it('rejects team ids that would break ball-id encoding', () => {
    expect(() => buildBallBag([{ teamId: 'a:b' }])).toThrow('must not contain ":"');
    expect(() => buildBallBag([{ teamId: '' }])).toThrow('non-empty');
  });

  it('rejects teams with no balls', () => {
    expect(() => buildBallBag([{ teamId: 'a', baseBalls: 0 }])).toThrow('at least one ball');
  });
});

describe('computeDraftOrder', () => {
  it('reproduces the exact pinned order for the fixture seed and config', () => {
    const draws = computeDraftOrder({
      seed: FIXTURE_SEED,
      teams: FIXTURE_TEAMS,
      baseBallCount: FIXTURE_BASE_BALL_COUNT,
    });
    expect(draws).toEqual(FIXTURE_EXPECTED_ORDER);
  });

  it('draws each team exactly once using the seeded ball bag', () => {
    const draws = computeDraftOrder({
      seed: 'order-seed',
      teams: [{ teamId: 'a' }, { teamId: 'b' }, { teamId: 'c' }],
      baseBallCount: 1,
    });

    expect(draws).toHaveLength(3);
    expect(new Set(draws.map((d) => d.teamId)).size).toBe(3);
    expect(draws.map((d) => d.pick)).toEqual([1, 2, 3]);
  });

  it('is deterministic for the same input', () => {
    const input = {
      seed: 'fixed-seed',
      teams: [{ teamId: 'a' }, { teamId: 'b' }, { teamId: 'c' }],
      baseBallCount: 1,
    };
    expect(computeDraftOrder(input)).toEqual(computeDraftOrder(input));
  });

  it('changes the order when the seed changes', () => {
    const teams = [{ teamId: 'a' }, { teamId: 'b' }, { teamId: 'c' }, { teamId: 'd' }];
    const orders = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const draws = computeDraftOrder({ seed: `seed-${i}`, teams });
      orders.add(draws.map((d) => d.teamId).join(','));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('requires at least one team', () => {
    expect(() => computeDraftOrder({ seed: 's', teams: [] })).toThrow('At least one team');
  });
});

describe('encodeBallId', () => {
  it('encodes teamId and 1-based ball number', () => {
    expect(encodeBallId('alpha', 3)).toBe('alpha:3');
  });
});
