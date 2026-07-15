import { describe, expect, it } from 'vitest';
import { ffcToRows, loadAdpPool } from '../pool.js';

const FIXTURE = {
  meta: { teams: 12, total_drafts: 1600, end_date: '2026-07-13' },
  players: [
    { name: 'Ja’Marr Chase', position: 'WR', team: 'CIN', adp: 1.2 },
    { name: 'Bijan Robinson', position: 'RB', team: 'ATL', adp: 2.4 },
    { name: 'Brock Bowers', position: 'TE', team: 'LV', adp: 18.1 },
    { name: 'Josh Allen', position: 'QB', team: 'BUF', adp: 30.5 },
    { name: 'Justin Tucker', position: 'PK', team: 'BAL', adp: 150 }, // dropped (kicker)
    { name: 'Ravens D/ST', position: 'DEF', team: 'BAL', adp: 140 }, // dropped (defense)
    { name: 'No ADP Guy', position: 'RB', team: 'FA', adp: null }, // dropped (no adp)
  ],
};

describe('ffcToRows', () => {
  it('keeps only RB/WR/TE/QB rows with a finite ADP', () => {
    const rows = ffcToRows(FIXTURE);
    expect(rows.map((r) => r.name)).toEqual([
      'Ja’Marr Chase',
      'Bijan Robinson',
      'Brock Bowers',
      'Josh Allen',
    ]);
    expect(rows.every((r) => Number.isFinite(r.adp))).toBe(true);
  });

  it('tolerates a malformed response', () => {
    expect(ffcToRows({})).toEqual([]);
    expect(ffcToRows({ players: undefined })).toEqual([]);
  });
});

describe('loadAdpPool', () => {
  it('builds an ADP-only pool and surfaces provenance', async () => {
    const loaded = await loadAdpPool({
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(FIXTURE), { status: 200 })),
    });
    expect(loaded.players).toHaveLength(4);
    expect(loaded.players.every((p) => p.source === 'ffc-adp')).toBe(true);
    expect(loaded.adp).toEqual({ asOf: '2026-07-13', sampleSize: 1600, added: 4 });
  });

  it('throws on a non-OK response so the caller can degrade', async () => {
    await expect(
      loadAdpPool({ fetchImpl: () => Promise.resolve(new Response('', { status: 503 })) }),
    ).rejects.toThrow(/503/);
  });
});
