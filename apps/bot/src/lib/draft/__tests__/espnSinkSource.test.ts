import { EspnSinkDraftSource } from '../espnSinkSource.js';

describe('EspnSinkDraftSource.ingest', () => {
  it('parses rows into ordered picks and is idempotent by overall', () => {
    const sink = new EspnSinkDraftSource();
    const added = sink.ingest({
      rows: [
        { overall: 2, playerName: "Ja'Marr Chase" },
        { overall: 1, playerName: 'Bijan Robinson' },
      ],
      onTheClock: 3,
    });
    expect(added.map((p) => p.overall)).toEqual([1, 2]);

    const snap = sink.poll();
    expect(snap.picks.map((p) => p.playerName)).toEqual(['Bijan Robinson', "Ja'Marr Chase"]);
    expect(snap.onTheClock).toBe(3);

    // Re-ingesting a re-scraped board adds nothing new.
    expect(sink.ingest({ rows: [{ overall: 1, playerName: 'Bijan Robinson' }] })).toEqual([]);
    expect(sink.poll().picks).toHaveLength(2);
  });

  it('fires onIngest with only newly-seen picks', () => {
    const seen: string[] = [];
    const sink = new EspnSinkDraftSource((added) => seen.push(...added.map((p) => p.playerName)));
    sink.ingest({ rows: [{ overall: 1, playerName: 'Bijan Robinson' }] });
    sink.ingest({
      rows: [
        { overall: 1, playerName: 'Bijan Robinson' },
        { overall: 2, playerName: "Ja'Marr Chase" },
      ],
    });
    expect(seen).toEqual(['Bijan Robinson', "Ja'Marr Chase"]);
  });
});

describe('EspnSinkDraftSource over HTTP', () => {
  it('ingests a POSTed board on localhost and reflects it in poll()', async () => {
    const sink = new EspnSinkDraftSource();
    const port = await sink.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: [{ overall: 1, playerName: 'Bijan Robinson' }],
          onTheClock: 2,
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, added: 1, known: 1 });
      expect(sink.poll().picks[0]?.playerName).toBe('Bijan Robinson');
      expect(sink.poll().onTheClock).toBe(2);
    } finally {
      await sink.close();
    }
  });

  it('answers a CORS preflight and rejects invalid JSON with 400', async () => {
    const sink = new EspnSinkDraftSource();
    const port = await sink.listen(0);
    try {
      const preflight = await fetch(`http://127.0.0.1:${port}/`, { method: 'OPTIONS' });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*');

      const bad = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: 'not json' });
      expect(bad.status).toBe(400);
    } finally {
      await sink.close();
    }
  });
});
