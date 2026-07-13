import {
  applyPick,
  applyPicks,
  createDraftSession,
  currentOverall,
  draftOrder,
  myUpcomingOveralls,
  slotOnClock,
  toDraftState,
  type DraftConfig,
} from '../session.js';
import type { DraftPick } from '../../rankings/bestAvailable.js';

const CONFIG: DraftConfig = {
  leagueSize: 12,
  myTeamId: 7,
  rosterSlots: { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DST: 1, BENCH: 6 },
};

function pick(overall: number, playerName: string): DraftPick {
  return { overall, teamId: 0, playerName };
}

describe('draftOrder', () => {
  it('snakes: slot 7 of 12 picks 7, 18, 31, 42, …', () => {
    expect(draftOrder(7, 12, 4)).toEqual([7, 18, 31, 42]);
  });

  it('slot 1 of 12 turns at the wrap (1, 24, 25, 48)', () => {
    expect(draftOrder(1, 12, 4)).toEqual([1, 24, 25, 48]);
  });

  it('linear order repeats the same slot each round', () => {
    expect(draftOrder(3, 12, 3, 'linear')).toEqual([3, 15, 27]);
  });
});

describe('slotOnClock', () => {
  it('is the inverse of draftOrder for a snake draft', () => {
    for (const overall of [1, 7, 12, 13, 18, 24, 25, 31]) {
      const slot = slotOnClock(overall, 12);
      expect(draftOrder(slot, 12, 3)).toContain(overall);
    }
  });
});

describe('createDraftSession', () => {
  it('defaults rounds to the roster size', () => {
    const session = createDraftSession(CONFIG);
    expect(session.config.rounds).toBe(15); // 1+2+2+1+1+1+1+6
    expect(session.config.order).toBe('snake');
    expect(session.picks).toEqual([]);
  });

  it('rejects an out-of-range slot', () => {
    expect(() => createDraftSession({ ...CONFIG, myTeamId: 13 })).toThrow(/slot/);
    expect(() => createDraftSession({ ...CONFIG, leagueSize: 1 })).toThrow(/leagueSize/);
  });
});

describe('applyPick', () => {
  it('is immutable — returns a new session and leaves the old one untouched', () => {
    const s0 = createDraftSession(CONFIG);
    const s1 = applyPick(s0, pick(1, 'Bijan Robinson'));
    expect(s0.picks).toHaveLength(0);
    expect(s1.picks).toHaveLength(1);
    expect(s1).not.toBe(s0);
  });

  it('keeps picks sorted by overall regardless of insertion order', () => {
    const session = applyPicks(createDraftSession(CONFIG), [
      pick(3, 'Saquon Barkley'),
      pick(1, 'Bijan Robinson'),
      pick(2, "Ja'Marr Chase"),
    ]);
    expect(session.picks.map((p) => p.overall)).toEqual([1, 2, 3]);
  });

  it('is idempotent — re-adding a drafted player (any suffix) is a no-op', () => {
    let session = applyPick(createDraftSession(CONFIG), pick(13, 'James Cook'));
    session = applyPick(session, pick(13, 'James Cook III')); // same player, later report
    expect(session.picks).toHaveLength(1);
  });
});

describe('toDraftState', () => {
  it('projects into the engine state with my remaining picks and who is on the clock', () => {
    const session = applyPicks(createDraftSession(CONFIG), [
      pick(1, 'Bijan Robinson'),
      pick(2, "Ja'Marr Chase"),
    ]);
    const state = toDraftState(session);

    expect(currentOverall(session)).toBe(3);
    expect(state.picks).toHaveLength(2);
    expect(state.onTheClock).toBe(slotOnClock(3, 12)); // pick 3 → slot 3
    // My (slot-7) picks 7 and 18 are still ahead; 7 comes before 18.
    expect(state.myUpcomingOveralls.slice(0, 2)).toEqual([7, 18]);
  });

  it('drops my picks that have already passed', () => {
    // Fast-forward 20 picks so my slot-7 first pick (overall 7) is behind us.
    const many = Array.from({ length: 20 }, (_, i) => pick(i + 1, `Player ${i + 1}`));
    const session = applyPicks(createDraftSession(CONFIG), many);
    expect(myUpcomingOveralls(session)[0]).toBe(31); // 7 and 18 are gone; 31 is next
  });
});
