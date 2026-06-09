import { computeLuckIndex } from '../luckIndex.js';

describe('computeLuckIndex', () => {
  it('returns the difference between wins and expected wins', () => {
    expect(computeLuckIndex({ wins: 10, expectedWins: 8 })).toBe(2);
    expect(computeLuckIndex({ wins: 6, expectedWins: 7.5 })).toBeCloseTo(-1.5);
  });

  it('returns zero when wins equals expected wins', () => {
    expect(computeLuckIndex({ wins: 5, expectedWins: 5 })).toBe(0);
  });
});
