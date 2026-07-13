import { mergeAdpIntoPool, type AdpRow } from '../adp.js';
import type { PlayerTier } from '../parse.js';

function player(
  name: string,
  position: PlayerTier['position'],
  extra: Partial<PlayerTier> = {},
): PlayerTier {
  return { name, position, source: 'research', ...extra };
}

function adp(
  name: string,
  position: AdpRow['position'],
  value: number,
  extra: Partial<AdpRow> = {},
): AdpRow {
  return { name, position, adp: value, ...extra };
}

describe('mergeAdpIntoPool', () => {
  it('joins market ADP onto a research player and keeps its tier/note', () => {
    const pool = [player('Bijan Robinson', 'RB', { tier: 1, note: 'elite' })];
    const merged = mergeAdpIntoPool(pool, [adp('Bijan Robinson', 'RB', 1.6, { team: 'ATL' })]);

    const bijan = merged.find((p) => p.name === 'Bijan Robinson');
    expect(bijan).toMatchObject({
      adp: 1.6,
      tier: 1,
      note: 'elite',
      team: 'ATL',
      source: 'research',
    });
    // No duplicate entry was added for the matched player.
    expect(merged.filter((p) => p.name === 'Bijan Robinson')).toHaveLength(1);
  });

  it('matches across generational suffixes and punctuation', () => {
    const pool = [player('James Cook III', 'RB', { tier: 2 })];
    const merged = mergeAdpIntoPool(pool, [adp('James Cook', 'RB', 13)]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ name: 'James Cook III', adp: 13, tier: 2 });
  });

  it('appends ADP-only players so the board runs deeper', () => {
    const pool = [player('Bijan Robinson', 'RB', { tier: 1 })];
    const merged = mergeAdpIntoPool(pool, [
      adp('Bijan Robinson', 'RB', 1.6),
      adp('Some Late Flyer', 'WR', 145, { team: 'NYJ', stdDev: 8 }),
    ]);

    const flyer = merged.find((p) => p.name === 'Some Late Flyer');
    expect(flyer).toMatchObject({
      name: 'Some Late Flyer',
      position: 'WR',
      adp: 145,
      team: 'NYJ',
      source: 'ffc-adp',
    });
    expect(merged).toHaveLength(2);
  });

  it('keeps a research player that has no ADP match, untouched', () => {
    const pool = [player('Deep Sleeper', 'TE', { tier: 8, adp: 200 })];
    const merged = mergeAdpIntoPool(pool, [adp('Unrelated Guy', 'RB', 5)]);

    const sleeper = merged.find((p) => p.name === 'Deep Sleeper');
    expect(sleeper).toMatchObject({ adp: 200, tier: 8 });
  });

  it('does not merge across differing positions (same name)', () => {
    const pool = [player('Taysom Hill', 'TE', { tier: 12 })];
    const merged = mergeAdpIntoPool(pool, [adp('Taysom Hill', 'QB', 180)]);

    // The research TE is untouched and the QB row is added separately — no wrong cross-position join.
    expect(merged).toHaveLength(2);
    expect(merged.find((p) => p.position === 'TE')?.adp).toBeUndefined();
    expect(merged.find((p) => p.position === 'QB')).toMatchObject({ adp: 180, source: 'ffc-adp' });
  });

  it('returns the pool essentially unchanged when there is no ADP', () => {
    const pool = [player('A', 'RB', { adp: 1 }), player('B', 'WR', { adp: 2 })];
    const merged = mergeAdpIntoPool(pool, []);
    expect(merged).toEqual(pool);
  });

  it('is pure — it does not mutate the input pool', () => {
    const pool = [player('Bijan Robinson', 'RB', { tier: 1 })];
    const snapshot = structuredClone(pool);
    mergeAdpIntoPool(pool, [adp('Bijan Robinson', 'RB', 1.6)]);
    expect(pool).toEqual(snapshot);
  });

  it('de-duplicates repeated ADP rows, first one wins', () => {
    const merged = mergeAdpIntoPool([], [adp('Dup', 'RB', 10), adp('Dup', 'RB', 99)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].adp).toBe(10);
  });
});
