import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchFfcAdp, ffcAdpUrl, normalizeFfcAdp } from '../ffcAdp.js';

const FIXTURE = {
  meta: {
    type: 'PPR',
    teams: 12,
    total_drafts: 1619,
    start_date: '2026-07-05',
    end_date: '2026-07-12',
  },
  players: [
    { name: 'Bijan Robinson', position: 'RB', team: 'ATL', adp: 1.6, stdev: 0.7, high: 1, low: 4 },
    { name: "Ja'Marr Chase", position: 'WR', team: 'CIN', adp: 2.4, stdev: 0.9, high: 1, low: 5 },
    { name: 'Baltimore', position: 'DEF', team: 'BAL', adp: 130, stdev: 10, high: 110, low: 160 },
    { name: 'Justin Tucker', position: 'PK', team: 'BAL', adp: 150, stdev: 9, high: 130, low: 170 },
    { name: 'No ADP Guy', position: 'WR', team: 'FA', adp: null },
  ],
};

describe('normalizeFfcAdp', () => {
  it('keeps only RB/WR/TE/QB and drops DEF/PK and rows without a finite ADP', () => {
    const feed = normalizeFfcAdp(FIXTURE, { season: 2026, teams: 12, scoring: 'ppr' });
    expect(feed.rows.map((r) => r.name)).toEqual(['Bijan Robinson', "Ja'Marr Chase"]);
    expect(feed.rows.every((r) => ['QB', 'RB', 'WR', 'TE'].includes(r.position))).toBe(true);
  });

  it('maps fields and surfaces the as-of date and sample size from meta', () => {
    const feed = normalizeFfcAdp(FIXTURE, { season: 2026, teams: 12, scoring: 'ppr' });
    expect(feed.rows[0]).toMatchObject({
      name: 'Bijan Robinson',
      position: 'RB',
      team: 'ATL',
      adp: 1.6,
      stdDev: 0.7,
      high: 1,
      low: 4,
    });
    expect(feed).toMatchObject({
      asOf: '2026-07-12',
      sampleSize: 1619,
      teams: 12,
      scoring: 'ppr',
      season: 2026,
    });
  });

  it('tolerates a missing players array', () => {
    expect(normalizeFfcAdp({}, { season: 2026, teams: 12, scoring: 'ppr' }).rows).toEqual([]);
  });
});

describe('ffcAdpUrl', () => {
  it('builds the FFC ADP endpoint for a format/size/season', () => {
    expect(ffcAdpUrl('ppr', 12, 2026)).toBe(
      'https://fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=2026',
    );
  });
});

describe('fetchFfcAdp', () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(path.join(tmpdir(), 'ffc-adp-test-'));
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('fetches, normalizes, and then serves the cache without re-fetching same day', async () => {
    let calls = 0;
    const fetchImpl = ((url: string) => {
      calls += 1;
      expect(url).toContain('/adp/ppr?teams=12&year=2026');
      return Promise.resolve(new Response(JSON.stringify(FIXTURE), { status: 200 }));
    }) as unknown as typeof fetch;

    const opts = { season: 2026, cacheDir, fetchImpl, now: () => new Date('2026-07-12T09:00:00Z') };

    const first = await fetchFfcAdp(opts);
    expect(first.rows).toHaveLength(2);
    expect(first.asOf).toBe('2026-07-12');

    const second = await fetchFfcAdp(opts);
    expect(second.rows).toHaveLength(2);
    expect(calls).toBe(1); // second call hit the daily cache
  });

  it('throws on a non-OK response', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('nope', { status: 503 }))) as unknown as typeof fetch;
    await expect(
      fetchFfcAdp({
        season: 2026,
        cacheDir,
        fetchImpl,
        now: () => new Date('2026-07-12T09:00:00Z'),
      }),
    ).rejects.toThrow(/503/);
  });
});
