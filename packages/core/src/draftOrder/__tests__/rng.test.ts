import { deterministicIndex } from '../rng.js';

describe('deterministicIndex', () => {
  it('is stable for the same seed and draw index', () => {
    expect(deterministicIndex('seed-1', 0, 10)).toBe(deterministicIndex('seed-1', 0, 10));
  });

  it('always lands inside the bag', () => {
    for (let drawIndex = 0; drawIndex < 200; drawIndex += 1) {
      const idx = deterministicIndex('range-seed', drawIndex, 7);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(7);
    }
  });

  it('varies with seed and draw index', () => {
    const indices = new Set<number>();
    for (let drawIndex = 0; drawIndex < 50; drawIndex += 1) {
      indices.add(deterministicIndex('vary-seed', drawIndex, 1000));
    }
    expect(indices.size).toBeGreaterThan(40);
    expect(deterministicIndex('seed-a', 0, 1000)).not.toBe(deterministicIndex('seed-b', 0, 1000));
  });

  it('rejects an empty bag and negative draw indices', () => {
    expect(() => deterministicIndex('seed', 0, 0)).toThrow('bagSize');
    expect(() => deterministicIndex('seed', -1, 10)).toThrow('drawIndex');
  });
});
