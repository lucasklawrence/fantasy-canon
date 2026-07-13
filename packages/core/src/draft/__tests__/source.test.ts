import { applyPicks, createDraftSession, type DraftConfig } from '../session.js';
import { ManualDraftSource } from '../manualSource.js';
import { diffNewPicks } from '../source.js';
import type { DraftPick } from '../../rankings/bestAvailable.js';

const CONFIG: DraftConfig = {
  leagueSize: 12,
  myTeamId: 7,
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, BENCH: 6 },
};

function pick(overall: number, playerName: string): DraftPick {
  return { overall, teamId: 0, playerName };
}

describe('ManualDraftSource', () => {
  it('auto-numbers picks in entry order and polls a snapshot copy', () => {
    const source = new ManualDraftSource();
    source.add('Bijan Robinson');
    source.add("Ja'Marr Chase");
    expect(source.size).toBe(2);

    const snap = source.poll();
    expect(snap.picks).toEqual([pick(1, 'Bijan Robinson'), pick(2, "Ja'Marr Chase")]);
    // Snapshot is a copy — mutating it doesn't corrupt the source.
    snap.picks.push(pick(99, 'Nobody'));
    expect(source.poll().picks).toHaveLength(2);
  });
});

describe('diffNewPicks', () => {
  it('returns only picks not already known, ascending by overall', () => {
    const session = applyPicks(createDraftSession(CONFIG), [pick(1, 'Bijan Robinson')]);
    const snapshot = [
      pick(2, "Ja'Marr Chase"),
      pick(1, 'Bijan Robinson'), // already known
      pick(3, 'Saquon Barkley'),
    ];
    const fresh = diffNewPicks(session.draftedKeys, snapshot);
    expect(fresh.map((p) => p.playerName)).toEqual(["Ja'Marr Chase", 'Saquon Barkley']);
  });

  it('collapses duplicates within a single snapshot', () => {
    const fresh = diffNewPicks(new Set(), [pick(1, 'Bijan Robinson'), pick(1, 'Bijan Robinson')]);
    expect(fresh).toHaveLength(1);
  });

  it('is stable across polls — a re-reported board yields nothing new once applied', () => {
    const source = new ManualDraftSource();
    source.add('Bijan Robinson');
    source.add("Ja'Marr Chase");

    let session = createDraftSession(CONFIG);
    session = applyPicks(session, diffNewPicks(session.draftedKeys, source.poll().picks));
    // Poll again without new picks: the diff is empty.
    expect(diffNewPicks(session.draftedKeys, source.poll().picks)).toEqual([]);

    source.add('Saquon Barkley');
    const next = diffNewPicks(session.draftedKeys, source.poll().picks);
    expect(next.map((p) => p.playerName)).toEqual(['Saquon Barkley']);
  });
});
