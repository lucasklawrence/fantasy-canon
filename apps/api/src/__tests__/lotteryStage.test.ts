import { describe, expect, it } from 'vitest';
import {
  createLotteryStage,
  parseLotteryAbort,
  parseLotteryAdjust,
  parseLotteryBeat,
  parseLotteryClear,
  parseLotteryFinish,
  parseLotteryLobby,
  parseLotteryRename,
  parseLotteryReveal,
  parseLotteryStart,
  DuplicateTeamNameError,
  StageNotEditableError,
  UnknownTeamError,
  type LotteryEvent,
  type LotteryLobby,
  type LotteryLobbyRequest,
  type LotteryStart,
} from '../lotteryStage.js';

const LOBBY: LotteryLobby = {
  title: '2026 Draft Lottery',
  teamCount: 3,
  totalBalls: 6,
  rows: [
    { team: 'C', balls: 3, firstPct: 50, top3Pct: 100 },
    { team: 'B', balls: 2, firstPct: 33.3, top3Pct: 100 },
    { team: 'A', balls: 1, firstPct: 16.7, top3Pct: 100 },
  ],
};

/** An editable lobby (#210): stable team ids + the `setup` runner allowed to adjust it. */
const EDITABLE: LotteryLobbyRequest = {
  title: '2026 Draft Lottery',
  teamCount: 3,
  totalBalls: 6,
  commissionerIds: ['commish'],
  rows: [
    { teamId: 't-c', team: 'C', balls: 3, firstPct: 50, top3Pct: 100 },
    { teamId: 't-b', team: 'B', balls: 2, firstPct: 33.3, top3Pct: 100 },
    { teamId: 't-a', team: 'A', balls: 1, firstPct: 16.7, top3Pct: 100 },
  ],
};

const START: LotteryStart = {
  title: '2026 Draft Lottery',
  commitment: 'hash',
  teamCount: 3,
  totalBalls: 6,
  delayMs: 5000,
  rows: [
    { team: 'C', balls: 3, firstPct: 50, top3Pct: 100 },
    { team: 'B', balls: 2, firstPct: 33.3, top3Pct: 100 },
    { team: 'A', balls: 1, firstPct: 16.7, top3Pct: 100 },
  ],
};

describe('createLotteryStage', () => {
  it('walks waiting → revealing → finished, emitting each event once', () => {
    const stage = createLotteryStage();
    const events: LotteryEvent[] = [];
    stage.subscribe((e) => events.push(e));

    stage.start(START);
    stage.beat({ pick: 3, remaining: ['A', 'B', 'C'] });
    stage.reveal({ pick: 3, team: 'B', balls: 2, oddsPct: 33.3, remaining: ['A', 'C'] });
    stage.finish({
      order: [
        { pick: 1, team: 'C' },
        { pick: 2, team: 'A' },
        { pick: 3, team: 'B' },
      ],
      verify: { secretSeed: 's', salt: 'm1', drawSeed: 's|m1', commitment: 'hash' },
    });

    expect(events.map((e) => e.type)).toEqual([
      'lottery-start',
      'lottery-beat',
      'lottery-reveal',
      'lottery-finish',
    ]);
    const snap = stage.snapshot();
    expect(snap.phase).toBe('finished');
    expect(snap.reveals).toHaveLength(1);
    expect(snap.pendingBeat).toBeUndefined();
    expect(snap.finish?.verify.secretSeed).toBe('s');
  });

  it('keeps full reveal history for late joiners, including a pending drum-roll', () => {
    const stage = createLotteryStage();
    stage.start(START);
    stage.beat({ pick: 3, remaining: ['A', 'B', 'C'] });
    stage.reveal({ pick: 3, team: 'B', balls: 2, oddsPct: 33.3, remaining: ['A', 'C'] });
    stage.beat({ pick: 2, remaining: ['A', 'C'] });

    const snap = stage.snapshot();
    expect(snap.phase).toBe('revealing');
    expect(snap.reveals.map((r) => r.team)).toEqual(['B']);
    expect(snap.pendingBeat?.pick).toBe(2);
  });

  it('refuses a second guild while a run is armed or live, releases after finish/abort', () => {
    const stage = createLotteryStage();
    stage.start({ ...START, guildId: 'guild-a' });
    // Armed (waiting): another guild is refused; the same guild may restart.
    expect(() => stage.start({ ...START, guildId: 'guild-b' })).toThrow('another live ceremony');
    expect(() => stage.start({ ...START, guildId: 'guild-a' })).not.toThrow();

    stage.beat({ pick: 3, remaining: ['A', 'B', 'C'] });
    expect(() => stage.start({ ...START, guildId: 'guild-b' })).toThrow('another live ceremony');

    stage.abort({ reason: 'done' });
    expect(() => stage.start({ ...START, guildId: 'guild-b' })).not.toThrow();
    expect(stage.snapshot().start?.guildId).toBe('guild-b');
  });

  it('a new start clears the previous run entirely', () => {
    const stage = createLotteryStage();
    stage.start(START);
    stage.abort({ reason: 'commissioner aborted' });
    expect(stage.snapshot().phase).toBe('aborted');

    stage.start({ ...START, title: 'Re-run' });
    const snap = stage.snapshot();
    expect(snap.phase).toBe('waiting');
    expect(snap.abort).toBeUndefined();
    expect(snap.reveals).toEqual([]);
    expect(snap.start?.title).toBe('Re-run');
  });

  it('a conditional abort only fires while its committed run is still showing (#205)', () => {
    const stage = createLotteryStage();
    stage.start(START); // commitment 'hash'
    stage.beat({ pick: 3, remaining: ['A', 'B', 'C'] });

    // Mismatched commitment: the boot reconciler's snapshot went stale — no-op.
    stage.abort({ reason: 'stale', ifCommitment: 'some-other-hash' });
    expect(stage.snapshot().phase).toBe('revealing');

    // Match: aborts, and the broadcast payload carries only the public reason.
    const events: LotteryEvent[] = [];
    stage.subscribe((e) => events.push(e));
    stage.abort({ reason: 'reconciled', ifCommitment: 'hash' });
    expect(stage.snapshot().phase).toBe('aborted');
    expect(events).toEqual([{ type: 'lottery-abort', abort: { reason: 'reconciled' } }]);
    expect(stage.snapshot().abort).toEqual({ reason: 'reconciled' });

    // Terminal phases are equally protected: the run it targeted is no longer "showing".
    stage.abort({ reason: 'stale again', ifCommitment: 'hash' });
    expect(stage.snapshot().abort?.reason).toBe('reconciled');

    // Unconditional aborts (the ceremony's own) are unchanged.
    stage.start(START);
    stage.abort({ reason: 'commissioner aborted' });
    expect(stage.snapshot().phase).toBe('aborted');
  });
});

describe('lobby phase (#198)', () => {
  it('lobby() arms the stage in lobby phase and emits lottery-lobby', () => {
    const stage = createLotteryStage();
    const events: LotteryEvent[] = [];
    stage.subscribe((e) => events.push(e));

    stage.lobby(LOBBY);

    expect(stage.snapshot().phase).toBe('lobby');
    expect(stage.snapshot().lobby?.title).toBe(LOBBY.title);
    expect(stage.snapshot().start).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('lottery-lobby');
  });

  it('lobby → start transition: start clears lobby and moves to waiting', () => {
    const stage = createLotteryStage();
    stage.lobby(LOBBY);
    stage.start(START);

    const snap = stage.snapshot();
    expect(snap.phase).toBe('waiting');
    expect(snap.lobby).toBeUndefined();
    expect(snap.start?.title).toBe(START.title);
  });

  it('lobby() includes lobby in the snapshot for late joiners', () => {
    const stage = createLotteryStage();
    stage.lobby(LOBBY);
    const snap = stage.snapshot();
    expect(snap.lobby?.rows).toHaveLength(3);
    expect(snap.reveals).toEqual([]);
  });

  it('refuses to arm a lobby over a committed run — even for the same guild, even with no guildId', () => {
    // Regression: a raced/retried lobby POST must never blank a committed ceremony's `start`,
    // which would leave viewers on a board with no commitment line while beats keep arriving.
    for (const armed of [{ guildId: 'guild-a' }, { guildId: 'guild-b' }, {}]) {
      const waiting = createLotteryStage();
      waiting.start({ ...START, guildId: 'guild-a' });
      expect(() => waiting.lobby({ ...LOBBY, ...armed })).toThrow('another live ceremony');
      expect(waiting.snapshot().start?.commitment).toBe('hash');

      const revealing = createLotteryStage();
      revealing.start({ ...START, guildId: 'guild-a' });
      revealing.beat({ pick: 3, remaining: ['A', 'B', 'C'] });
      expect(() => revealing.lobby({ ...LOBBY, ...armed })).toThrow('another live ceremony');
      expect(revealing.snapshot().start?.commitment).toBe('hash');
    }
  });

  it('re-arms freely from idle, lobby, finished and aborted — nothing committed to protect', () => {
    const stage = createLotteryStage();
    expect(() => stage.lobby({ ...LOBBY, guildId: 'guild-a' })).not.toThrow(); // from idle
    expect(() => stage.lobby({ ...LOBBY, guildId: 'guild-b' })).not.toThrow(); // from lobby
    expect(stage.snapshot().lobby?.guildId).toBe('guild-b');

    const after = createLotteryStage();
    after.start(START);
    after.abort({ reason: 'done' });
    expect(() => after.lobby(LOBBY)).not.toThrow(); // from aborted
    expect(after.snapshot().phase).toBe('lobby');
    expect(after.snapshot().abort).toBeUndefined();
  });

  it('never leaves a stale lobby in the snapshot once a later phase takes over', () => {
    // `lobby` is documented as "set when phase is 'lobby'" — a snapshot carrying both a lobby and
    // a finished/aborted phase would paint the wrong screen for a late joiner.
    for (const advance of [
      (s: ReturnType<typeof createLotteryStage>) => s.beat({ pick: 3, remaining: ['A'] }),
      (s: ReturnType<typeof createLotteryStage>) =>
        s.reveal({ pick: 3, team: 'B', balls: 2, oddsPct: 33.3, remaining: [] }),
      (s: ReturnType<typeof createLotteryStage>) =>
        s.finish({
          order: [{ pick: 1, team: 'C' }],
          verify: { secretSeed: 's', salt: 'm', drawSeed: 's|m', commitment: 'hash' },
        }),
      (s: ReturnType<typeof createLotteryStage>) => s.abort({ reason: 'stop' }),
    ]) {
      const stage = createLotteryStage();
      stage.lobby(LOBBY);
      advance(stage);
      expect(stage.snapshot().phase).not.toBe('lobby');
      expect(stage.snapshot().lobby).toBeUndefined();
    }
  });
});

describe('clear() — disarming a lobby (#198)', () => {
  it('returns an armed lobby to idle and emits the fresh snapshot', () => {
    const stage = createLotteryStage();
    stage.lobby({ ...LOBBY, guildId: 'guild-a' });
    const events: LotteryEvent[] = [];
    stage.subscribe((e) => events.push(e));

    stage.clear({ guildId: 'guild-a' });

    const snap = stage.snapshot();
    expect(snap.phase).toBe('idle');
    expect(snap.lobby).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'lottery-state', snapshot: { phase: 'idle', reveals: [] } });
  });

  it('never tears down a committed run, whatever the phase or guild', () => {
    for (const phase of ['waiting', 'revealing', 'finished'] as const) {
      const stage = createLotteryStage();
      stage.start({ ...START, guildId: 'guild-a' });
      if (phase !== 'waiting') stage.beat({ pick: 3, remaining: ['A'] });
      if (phase === 'finished') {
        stage.finish({
          order: [{ pick: 1, team: 'C' }],
          verify: { secretSeed: 's', salt: 'm', drawSeed: 's|m', commitment: 'hash' },
        });
      }
      stage.clear({ guildId: 'guild-a' });
      stage.clear({});
      expect(stage.snapshot().phase).toBe(phase);
      expect(stage.snapshot().start?.commitment).toBe('hash');
    }
  });

  it('ignores a mismatched guild, so one league cannot disarm another', () => {
    const stage = createLotteryStage();
    stage.lobby({ ...LOBBY, guildId: 'guild-a' });
    stage.clear({ guildId: 'guild-b' });
    stage.clear({});
    expect(stage.snapshot().phase).toBe('lobby');
    expect(stage.snapshot().lobby?.guildId).toBe('guild-a');
  });

  it('is an idempotent no-op from idle', () => {
    const stage = createLotteryStage();
    const events: LotteryEvent[] = [];
    stage.subscribe((e) => events.push(e));
    stage.clear({});
    stage.clear({ guildId: 'guild-a' });
    expect(stage.snapshot().phase).toBe('idle');
    expect(events).toEqual([]);
  });
});

describe('adjust() — commissioner lobby edits (#210)', () => {
  it('recomputes the whole odds table and totals, keeping the armed row order', () => {
    const stage = createLotteryStage();
    stage.lobby(EDITABLE);
    const events: LotteryEvent[] = [];
    stage.subscribe((e) => events.push(e));

    stage.adjust({ teamId: 't-a', balls: 4 });

    const lobby = stage.snapshot().lobby as LotteryLobby;
    expect(lobby.rows.map((r) => r.teamId)).toEqual(['t-c', 't-b', 't-a']);
    expect(lobby.rows.map((r) => r.balls)).toEqual([3, 2, 4]);
    expect(lobby.totalBalls).toBe(9);
    // 3/2/4 of 9 balls — every row's odds move, not just the edited one.
    expect(lobby.rows[0].firstPct).toBeCloseTo((3 / 9) * 100, 5);
    expect(lobby.rows[2].firstPct).toBeCloseTo((4 / 9) * 100, 5);
    // Fanned out as the ordinary lobby event, so clients need no new branch; `adjusted` rides
    // along for the bot's audit line (#220) and is ignored by the browser.
    expect(events).toEqual([
      {
        type: 'lottery-lobby',
        lobby,
        // The cumulative pending set, so a subscriber dedupes on stage state rather than on the
        // events it happened to witness (#220).
        adjustments: [{ teamId: 't-a', balls: 4 }],
        adjusted: { teamId: 't-a', team: 'A', from: 1, to: 4 },
      },
    ]);
  });

  it('carries what changed on the broadcast, so the bot never has to diff two lobbies (#220)', () => {
    const stage = createLotteryStage();
    stage.lobby({ ...EDITABLE, guildId: 'g1' });
    const events: LotteryEvent[] = [];
    stage.subscribe((e) => events.push(e));

    stage.adjust({ teamId: 't-a', balls: 4 });

    const event = events[0] as { type: 'lottery-lobby'; adjusted?: unknown };
    expect(event.adjusted).toEqual({
      teamId: 't-a',
      team: 'A',
      from: 1, // the count *before* this edit, read off the row it replaced
      to: 4,
      guildId: 'g1',
    });

    // A second edit to the same team reports the previous edit's value as `from`, not the
    // original — the audit line has to read as a chain of changes.
    stage.adjust({ teamId: 't-a', balls: 6 });
    expect((events[1] as { adjusted?: { from: number } }).adjusted?.from).toBe(4);
  });

  it('leaves `adjusted` off a bot-driven re-arm — only a human edit sets it', () => {
    const stage = createLotteryStage();
    const events: LotteryEvent[] = [];
    stage.subscribe((e) => events.push(e));
    stage.lobby(EDITABLE);
    expect(events[0]).not.toHaveProperty('adjusted');
  });

  it('records edits as pending until the bot drains them, one entry per team', () => {
    const stage = createLotteryStage();
    stage.lobby(EDITABLE);
    stage.adjust({ teamId: 't-a', balls: 4 });
    stage.adjust({ teamId: 't-a', balls: 5 }); // re-tapping the same row replaces, never appends
    stage.adjust({ teamId: 't-b', balls: 1 });
    expect(stage.snapshot().adjustments).toEqual([
      { teamId: 't-a', balls: 5 },
      { teamId: 't-b', balls: 1 },
    ]);
  });

  it('refuses anything but an armed lobby, and an unknown team', () => {
    const stage = createLotteryStage();
    expect(() => stage.adjust({ teamId: 't-a', balls: 2 })).toThrow(StageNotEditableError);

    stage.lobby(EDITABLE);
    expect(() => stage.adjust({ teamId: 't-nope', balls: 2 })).toThrow(UnknownTeamError);

    // Once a commitment exists the bag is sealed — this is the ADR 0006 fairness boundary.
    stage.start(START);
    expect(() => stage.adjust({ teamId: 't-a', balls: 2 })).toThrow(StageNotEditableError);
  });

  it('refuses a lobby armed without team ids rather than guessing which row to edit', () => {
    const stage = createLotteryStage();
    stage.lobby({ ...LOBBY, commissionerIds: ['commish'] });
    expect(() => stage.adjust({ teamId: 't-a', balls: 2 })).toThrow(UnknownTeamError);
  });

  it('scopes commissioners to the armed lobby', () => {
    const stage = createLotteryStage();
    expect(stage.isCommissioner('commish')).toBe(false); // idle: nobody may edit

    stage.lobby(EDITABLE);
    expect(stage.isCommissioner('commish')).toBe(true);
    expect(stage.isCommissioner('someone-else')).toBe(false);

    // Committing closes the write path outright.
    stage.start(START);
    expect(stage.isCommissioner('commish')).toBe(false);

    // So does disarming, and so does a lobby armed by a bot that sends no commissioner list —
    // read-only is the safe default.
    const fresh = createLotteryStage();
    fresh.lobby(EDITABLE);
    fresh.clear({});
    expect(fresh.isCommissioner('commish')).toBe(false);
    fresh.lobby(LOBBY);
    expect(fresh.isCommissioner('commish')).toBe(false);
  });

  it('drops pending edits on a re-arm, and keeps + re-applies them with keepAdjustments', () => {
    const stage = createLotteryStage();
    stage.lobby(EDITABLE);
    stage.adjust({ teamId: 't-a', balls: 4 });

    // A plain re-arm is a fresh `setup`: a brand-new bag makes the old edit meaningless.
    stage.lobby(EDITABLE);
    expect(stage.snapshot().adjustments).toBeUndefined();
    expect(stage.snapshot().lobby?.totalBalls).toBe(6);

    // The mini-game re-arm derives rows from a session that has not absorbed the edit yet, so it
    // asks the stage to carry it — otherwise the odds would silently revert mid-lobby.
    stage.adjust({ teamId: 't-a', balls: 4 });
    stage.lobby({ ...EDITABLE, keepAdjustments: true });
    expect(stage.snapshot().adjustments).toEqual([{ teamId: 't-a', balls: 4 }]);
    expect(stage.snapshot().lobby?.rows.map((r) => r.balls)).toEqual([3, 2, 4]);
    expect(stage.snapshot().lobby?.totalBalls).toBe(9);
  });

  it('re-arms cleanly even when a pending edit cannot be re-applied to the new rows', () => {
    const stage = createLotteryStage();
    stage.lobby(EDITABLE);
    stage.adjust({ teamId: 't-a', balls: 4 });

    // The mini-game re-arm asks to keep edits, but this bot sent rows with no team ids — so the
    // edit can't be placed. Arming a lobby is the bot's authoritative act: it must still succeed,
    // dropping the un-appliable edit rather than throwing and stranding the stage on the old one.
    expect(() => stage.lobby({ ...LOBBY, keepAdjustments: true })).not.toThrow();
    const snapshot = stage.snapshot();
    expect(snapshot.phase).toBe('lobby');
    expect(snapshot.adjustments).toBeUndefined();
    expect(snapshot.lobby?.rows.map((r) => r.balls)).toEqual([3, 2, 1]);
    expect(snapshot.lobby?.totalBalls).toBe(6);
  });

  it('never broadcasts the commissioner list or leaves edits behind on a committed run', () => {
    const stage = createLotteryStage();
    const events: LotteryEvent[] = [];
    stage.subscribe((e) => events.push(e));
    stage.lobby(EDITABLE);
    stage.adjust({ teamId: 't-a', balls: 4 });

    const broadcast = events[0] as { type: 'lottery-lobby'; lobby: LotteryLobby };
    expect(broadcast.lobby).not.toHaveProperty('commissionerIds');
    expect(broadcast.lobby).not.toHaveProperty('keepAdjustments');

    // A late edit is discarded by the commitment rather than surviving to be applied to a sealed
    // bag — the bot drained before it called start().
    stage.start(START);
    expect(stage.snapshot().adjustments).toBeUndefined();
  });
});

describe('rename + re-import — the rest of the in-Activity field edits (#219)', () => {
  it('renames a row without touching a single ball or odds figure', () => {
    const stage = createLotteryStage();
    stage.lobby({ ...EDITABLE, guildId: 'g1' });
    const before = stage.snapshot().lobby as LotteryLobby;
    const events: LotteryEvent[] = [];
    stage.subscribe((e) => events.push(e));

    stage.rename({ teamId: 't-a', displayName: 'Alpha Antlers' });

    const after = stage.snapshot().lobby as LotteryLobby;
    expect(after.rows.map((r) => r.team)).toEqual(['C', 'B', 'Alpha Antlers']);
    // Display names are cosmetic — `commitmentPreimage` hashes teamId + balls only.
    expect(after.rows.map((r) => r.balls)).toEqual(before.rows.map((r) => r.balls));
    expect(after.rows.map((r) => r.firstPct)).toEqual(before.rows.map((r) => r.firstPct));
    expect(after.totalBalls).toBe(before.totalBalls);

    const event = events[0] as { renamed?: unknown; renames?: unknown };
    expect(event.renamed).toEqual({ teamId: 't-a', from: 'A', to: 'Alpha Antlers', guildId: 'g1' });
    expect(event.renames).toEqual([{ teamId: 't-a', displayName: 'Alpha Antlers' }]);
    expect(stage.snapshot().renames).toEqual([{ teamId: 't-a', displayName: 'Alpha Antlers' }]);
  });

  it('refuses a name another row already has, case-insensitively', () => {
    const stage = createLotteryStage();
    stage.lobby(EDITABLE);
    // `createCeremony` would reject this at drain time — refusing here means the league never
    // sees a name the ceremony is going to choke on.
    expect(() => stage.rename({ teamId: 't-a', displayName: 'b' })).toThrow(DuplicateTeamNameError);
    // Renaming a row to what it already is stays legal (idempotent retap).
    expect(() => stage.rename({ teamId: 't-a', displayName: 'A' })).not.toThrow();
    expect(stage.snapshot().lobby?.rows.map((r) => r.team)).toEqual(['C', 'B', 'A']);
  });

  it('refuses an unknown team and anything past the commitment', () => {
    const stage = createLotteryStage();
    expect(() => stage.rename({ teamId: 't-a', displayName: 'X' })).toThrow(StageNotEditableError);
    stage.lobby(EDITABLE);
    expect(() => stage.rename({ teamId: 'nope', displayName: 'X' })).toThrow(UnknownTeamError);
    stage.start(START);
    expect(() => stage.rename({ teamId: 't-a', displayName: 'X' })).toThrow(StageNotEditableError);
  });

  it('carries renames through a keepAdjustments re-arm and drops them on a fresh one', () => {
    const stage = createLotteryStage();
    stage.lobby(EDITABLE);
    stage.rename({ teamId: 't-a', displayName: 'Alpha Antlers' });

    stage.lobby({ ...EDITABLE, keepAdjustments: true });
    expect(stage.snapshot().lobby?.rows.map((r) => r.team)).toEqual(['C', 'B', 'Alpha Antlers']);
    expect(stage.snapshot().renames).toHaveLength(1);

    stage.lobby(EDITABLE);
    expect(stage.snapshot().lobby?.rows.map((r) => r.team)).toEqual(['C', 'B', 'A']);
    expect(stage.snapshot().renames).toBeUndefined();
  });

  it('flags a re-import request and clears it when the bot re-arms with fresh data', () => {
    const stage = createLotteryStage();
    stage.lobby(EDITABLE);
    const events: LotteryEvent[] = [];
    stage.subscribe((e) => events.push(e));

    stage.requestReimport();
    expect(stage.snapshot().reimportRequested).toBe(true);
    expect((events[0] as { reimportRequested?: boolean }).reimportRequested).toBe(true);

    // The api has no ESPN access, so the flag only survives until the bot answers it.
    stage.lobby(EDITABLE);
    expect(stage.snapshot().reimportRequested).toBeUndefined();
  });

  it('refuses a re-import request when nothing is armed', () => {
    const stage = createLotteryStage();
    expect(() => stage.requestReimport()).toThrow(StageNotEditableError);
    stage.lobby(EDITABLE);
    stage.start(START);
    expect(() => stage.requestReimport()).toThrow(StageNotEditableError);
  });

  it('drops renames and the re-import flag with the lobby they belonged to', () => {
    const stage = createLotteryStage();
    stage.lobby(EDITABLE);
    stage.rename({ teamId: 't-a', displayName: 'Alpha Antlers' });
    stage.requestReimport();

    stage.clear({});
    expect(stage.snapshot().renames).toBeUndefined();
    expect(stage.snapshot().reimportRequested).toBeUndefined();
  });
});

describe('lottery payload guards', () => {
  it('parseLotteryRename trims, caps, and rejects unusable names', () => {
    expect(parseLotteryRename(JSON.stringify({ teamId: 't1', displayName: '  Ducks  ' }))).toEqual({
      value: { teamId: 't1', displayName: 'Ducks' },
    });
    for (const displayName of ['', '   ', 'x'.repeat(41), 'a\nb', 'a\tb', 42, null]) {
      expect('error' in parseLotteryRename(JSON.stringify({ teamId: 't1', displayName }))).toBe(
        true,
      );
    }
    expect('error' in parseLotteryRename(JSON.stringify({ displayName: 'Ducks' }))).toBe(true);
    expect('error' in parseLotteryRename('{bad')).toBe(true);
    // Exactly at the cap is fine.
    expect(
      'value' in parseLotteryRename(JSON.stringify({ teamId: 't1', displayName: 'x'.repeat(40) })),
    ).toBe(true);
  });

  it('parseLotteryAdjust clamps to a sane, integral ball count', () => {
    const ok = parseLotteryAdjust(JSON.stringify({ teamId: 't-a', balls: 7 }));
    expect(ok).toEqual({ value: { teamId: 't-a', balls: 7 } });
    for (const balls of [0, -1, 1.5, 31, '3', null]) {
      expect('error' in parseLotteryAdjust(JSON.stringify({ teamId: 't-a', balls }))).toBe(true);
    }
    expect('error' in parseLotteryAdjust(JSON.stringify({ balls: 3 }))).toBe(true);
    expect('error' in parseLotteryAdjust('{bad')).toBe(true);
  });

  it('parseLotteryLobby reads the #210 steering fields and ignores junk ones', () => {
    const parsed = parseLotteryLobby(
      JSON.stringify({ ...EDITABLE, keepAdjustments: true, commissionerIds: ['a', 'b'] }),
    );
    expect('value' in parsed && parsed.value.commissionerIds).toEqual(['a', 'b']);
    expect('value' in parsed && parsed.value.keepAdjustments).toBe(true);

    const junk = parseLotteryLobby(
      JSON.stringify({ ...EDITABLE, commissionerIds: [1, 2], keepAdjustments: 'yes' }),
    );
    expect('value' in junk && junk.value.commissionerIds).toBeUndefined();
    expect('value' in junk && junk.value.keepAdjustments).toBeUndefined();
  });

  it('parseLotteryLobby rejects a row whose teamId is present but not a string', () => {
    // Stored as-is it would never match an `adjust` targeting it, leaving that row silently
    // un-editable for the lobby's whole life — better to fail the arm loudly.
    const rows = [{ ...EDITABLE.rows[0], teamId: 42 }, ...EDITABLE.rows.slice(1)];
    expect('error' in parseLotteryLobby(JSON.stringify({ ...EDITABLE, rows }))).toBe(true);
  });

  it('parseLotteryLobby accepts a full payload and rejects partial ones', () => {
    const ok = parseLotteryLobby(JSON.stringify(LOBBY));
    expect('value' in ok && ok.value.rows).toHaveLength(3);
    expect('error' in parseLotteryLobby('{bad')).toBe(true);
    expect('error' in parseLotteryLobby(JSON.stringify({ ...LOBBY, rows: [] }))).toBe(true);
    expect('error' in parseLotteryLobby(JSON.stringify({ ...LOBBY, title: '' }))).toBe(true);
    expect('error' in parseLotteryLobby(JSON.stringify({ ...LOBBY, rows: [{ team: 'X' }] }))).toBe(
      true,
    );
    // Unlike start, lobby has no commitment/delayMs — verify they're not required.
    expect('value' in parseLotteryLobby(JSON.stringify({ ...LOBBY, commitment: undefined }))).toBe(
      true,
    );
    // A stray commitment key must not survive onto the stage — the lobby is pre-commitment.
    const stray = parseLotteryLobby(JSON.stringify({ ...LOBBY, commitment: 'leaked' }));
    expect('value' in stray && 'commitment' in stray.value).toBe(false);
  });

  it('parseLotteryLobby requires positive integer counts that agree with the rows', () => {
    // A lobby is armed at setup and can sit on screen for days, so nonsense counts are visible
    // far longer than a bad start ever is.
    for (const bad of [
      { teamCount: 0 },
      { teamCount: -5 },
      { teamCount: 2.5 },
      { totalBalls: 0 },
      { totalBalls: -1 },
      { rows: [{ team: 'A', balls: -3, firstPct: 50, top3Pct: 100 }] },
      { rows: [{ team: 'A', balls: 1.5, firstPct: 50, top3Pct: 100 }] },
      { totalBalls: 999 }, // disagrees with sum(rows.balls) === 6
    ]) {
      expect('error' in parseLotteryLobby(JSON.stringify({ ...LOBBY, ...bad }))).toBe(true);
    }
  });

  it('parseLotteryAbort defaults the reason and passes ifCommitment through (#205)', () => {
    expect(parseLotteryAbort('{}')).toEqual({ value: { reason: 'The ceremony was aborted.' } });
    expect(parseLotteryAbort(JSON.stringify({ reason: 'r', ifCommitment: 'hash' }))).toEqual({
      value: { reason: 'r', ifCommitment: 'hash' },
    });
    // A non-string condition is dropped, leaving the abort unconditional.
    expect(parseLotteryAbort(JSON.stringify({ reason: 'r', ifCommitment: 7 }))).toEqual({
      value: { reason: 'r' },
    });
  });

  it('parseLotteryClear takes an optional guild scope and nothing else', () => {
    expect(parseLotteryClear('{}')).toEqual({ value: {} });
    expect(parseLotteryClear(JSON.stringify({ guildId: 'g1' }))).toEqual({
      value: { guildId: 'g1' },
    });
    // Junk fields are dropped rather than rejected — this is a fire-and-forget cleanup route.
    expect(parseLotteryClear(JSON.stringify({ guildId: 'g1', nope: 1 }))).toEqual({
      value: { guildId: 'g1' },
    });
    expect('error' in parseLotteryClear('{bad')).toBe(true);
  });

  it('parseLotteryStart accepts a full payload and rejects partial ones', () => {
    const ok = parseLotteryStart(JSON.stringify(START));
    expect('value' in ok && ok.value.rows).toHaveLength(3);
    expect('error' in parseLotteryStart('{bad')).toBe(true);
    expect('error' in parseLotteryStart(JSON.stringify({ ...START, rows: [] }))).toBe(true);
    expect('error' in parseLotteryStart(JSON.stringify({ ...START, title: '' }))).toBe(true);
    expect('error' in parseLotteryStart(JSON.stringify({ ...START, rows: [{ team: 'X' }] }))).toBe(
      true,
    );
  });

  it('parseLotteryBeat / parseLotteryReveal enforce their shapes', () => {
    expect('value' in parseLotteryBeat(JSON.stringify({ pick: 3, remaining: ['A'] }))).toBe(true);
    expect('error' in parseLotteryBeat(JSON.stringify({ pick: 'x', remaining: ['A'] }))).toBe(true);
    expect(
      'value' in
        parseLotteryReveal(
          JSON.stringify({ pick: 3, team: 'B', balls: 2, oddsPct: 33.3, remaining: [] }),
        ),
    ).toBe(true);
    expect('error' in parseLotteryReveal(JSON.stringify({ pick: 3, team: 'B' }))).toBe(true);
  });

  it('parseLotteryFinish requires the full order and verify block', () => {
    const good = {
      order: [{ pick: 1, team: 'C' }],
      verify: { secretSeed: 's', salt: 'm', drawSeed: 's|m', commitment: 'h' },
    };
    expect('value' in parseLotteryFinish(JSON.stringify(good))).toBe(true);
    expect('error' in parseLotteryFinish(JSON.stringify({ ...good, verify: {} }))).toBe(true);
    expect('error' in parseLotteryFinish(JSON.stringify({ ...good, order: [{ pick: 1 }] }))).toBe(
      true,
    );
  });
});
