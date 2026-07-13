import { createDraftSession, ManualDraftSource, type DraftConfig } from '@fantasy-canon/core';
import { pollOnce } from '../poller.js';
import { EspnSinkDraftSource } from '../espnSinkSource.js';

const CONFIG: DraftConfig = {
  leagueSize: 12,
  myTeamId: 7,
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, BENCH: 6 },
};

describe('pollOnce', () => {
  it('drains only fresh picks from a source into the session', async () => {
    const source = new ManualDraftSource();
    source.add('Bijan Robinson');
    source.add("Ja'Marr Chase");

    let session = createDraftSession(CONFIG);
    const picked: string[] = [];
    const callbacks = {
      getSession: () => session,
      setSession: (next: typeof session) => {
        session = next;
      },
      onPick: (pick: { playerName: string }) => picked.push(pick.playerName),
    };

    const first = await pollOnce(source, callbacks);
    expect(first.map((p) => p.playerName)).toEqual(['Bijan Robinson', "Ja'Marr Chase"]);
    expect(session.picks).toHaveLength(2);

    // Nothing new on the next poll.
    expect(await pollOnce(source, callbacks)).toEqual([]);

    source.add('Saquon Barkley');
    const third = await pollOnce(source, callbacks);
    expect(third.map((p) => p.playerName)).toEqual(['Saquon Barkley']);
    expect(picked).toEqual(['Bijan Robinson', "Ja'Marr Chase", 'Saquon Barkley']);
  });

  it('works the same over the ESPN sink source', async () => {
    const sink = new EspnSinkDraftSource();
    sink.ingest({ rows: [{ overall: 1, playerName: 'Bijan Robinson' }] });

    let session = createDraftSession(CONFIG);
    const callbacks = {
      getSession: () => session,
      setSession: (next: typeof session) => {
        session = next;
      },
    };

    await pollOnce(sink, callbacks);
    expect(session.picks.map((p) => p.playerName)).toEqual(['Bijan Robinson']);

    sink.ingest({ rows: [{ overall: 2, playerName: "Ja'Marr Chase" }] });
    await pollOnce(sink, callbacks);
    expect(session.picks).toHaveLength(2);
  });
});
