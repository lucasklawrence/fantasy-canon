import { bestAvailable } from '../../rankings/bestAvailable.js';
import type { PlayerTier } from '../../rankings/parse.js';
import { CompletedDraftSource } from '../completedSource.js';
import { applyPick, createDraftSession, toDraftState, type DraftSession } from '../session.js';

function rb(name: string, adp: number): PlayerTier {
  return { name, position: 'RB', adp, source: 'test' };
}
function wr(name: string, adp: number): PlayerTier {
  return { name, position: 'WR', adp, source: 'test' };
}

describe('CompletedDraftSource', () => {
  it('exposes a finished, overall-sorted board flagged complete', () => {
    const source = new CompletedDraftSource([
      { overall: 3, teamId: 1, playerName: 'Third' },
      { overall: 1, teamId: 1, playerName: 'First' },
      { overall: 2, teamId: 2, playerName: 'Second' },
    ]);

    const snapshot = source.poll();
    expect(source.kind).toBe('completed');
    expect(source.size).toBe(3);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.picks.map((p) => p.playerName)).toEqual(['First', 'Second', 'Third']);
  });

  it('copies picks so callers can mutate the snapshot without corrupting the source', () => {
    const source = new CompletedDraftSource([{ overall: 1, teamId: 1, playerName: 'First' }]);
    const first = source.poll();
    first.picks[0].overall = 999;
    expect(source.poll().picks[0].overall).toBe(1);
  });

  it('replays a completed draft through a session into a sane best-available trajectory', () => {
    // Every drafted name is in the pool, so each pick must remove exactly one candidate.
    const pool = [
      rb('Bijan Robinson', 1),
      wr('Ja’Marr Chase', 1.5),
      rb('Saquon Barkley', 2),
      wr('Puka Nacua', 2.5),
    ];
    const source = new CompletedDraftSource([
      { overall: 3, teamId: 1, playerName: 'Saquon Barkley' },
      { overall: 1, teamId: 1, playerName: 'Bijan Robinson' },
      { overall: 2, teamId: 2, playerName: 'Ja’Marr Chase' },
    ]);

    let session: DraftSession = createDraftSession({
      leagueSize: 2,
      myTeamId: 1,
      rosterSlots: { RB: 1, WR: 1, BENCH: 2 },
    });

    // Start: whole pool is available.
    const sizes = [bestAvailable(pool, toDraftState(session)).length];

    // Replay the completed draft in board order; each pick should knock its player off the board.
    for (const pick of source.poll().picks) {
      session = applyPick(session, pick);
      const board = bestAvailable(pool, toDraftState(session));
      expect(board.some((c) => c.name === pick.playerName)).toBe(false);
      sizes.push(board.length);
    }

    // A sane trajectory: the board shrinks by exactly one per pick, ending with the lone survivor.
    expect(sizes).toEqual([4, 3, 2, 1]);
    expect(bestAvailable(pool, toDraftState(session)).map((c) => c.name)).toEqual(['Puka Nacua']);
  });
});
