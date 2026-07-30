import { describe, expect, it } from 'vitest';
import {
  createLotteryStage,
  parseLotteryBeat,
  parseLotteryFinish,
  parseLotteryLobby,
  parseLotteryReveal,
  parseLotteryStart,
  type LotteryEvent,
  type LotteryLobby,
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

  it('lobby() is blocked by a different guild mid-reveal, not by another lobby', () => {
    const stage = createLotteryStage();
    stage.start({ ...START, guildId: 'guild-a' });
    stage.beat({ pick: 3, remaining: ['A', 'B', 'C'] }); // now 'revealing'
    expect(() => stage.lobby({ ...LOBBY, guildId: 'guild-b' })).toThrow('another live ceremony');
    // Same guild is always allowed even mid-reveal.
    expect(() => stage.lobby({ ...LOBBY, guildId: 'guild-a' })).not.toThrow();
  });

  it('a lobby from a different guild may overwrite a stale lobby (pre-commitment)', () => {
    const stage = createLotteryStage();
    stage.lobby({ ...LOBBY, guildId: 'guild-a' });
    // Second guild arms a lobby while guild-a is still in lobby phase — lobby is safe to overwrite.
    expect(() => stage.lobby({ ...LOBBY, guildId: 'guild-b' })).not.toThrow();
    expect(stage.snapshot().lobby?.guildId).toBe('guild-b');
  });
});

describe('lottery payload guards', () => {
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
