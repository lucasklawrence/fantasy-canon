import { describe, expect, it } from 'vitest';
import {
  adjustmentLine,
  BASE_BACKOFF_MS,
  createStageWatcher,
  MAX_BACKOFF_MS,
  stageWsUrl,
  type StageSocket,
} from '../lotteryStageWatcher.js';

/** A fake socket that lets a test drive open/message/close by hand — no real WebSocket. */
function fakeSocket(): {
  socket: StageSocket;
  open: () => void;
  send: (payload: unknown) => void;
  drop: () => void;
  closed: () => boolean;
} {
  const listeners: Record<string, ((event?: unknown) => void)[]> = {};
  let closed = false;
  const socket: StageSocket = {
    addEventListener: (type: string, listener: (event?: never) => void): void => {
      (listeners[type] ??= []).push(listener as (event?: unknown) => void);
    },
    close: (): void => {
      closed = true;
    },
  } as StageSocket;
  const fire = (type: string, event?: unknown): void => {
    for (const listener of listeners[type] ?? []) listener(event);
  };
  return {
    socket,
    open: () => fire('open'),
    // The real WebSocket hands us strings; frames arrive as `{ data }`.
    send: (payload) => fire('message', { data: JSON.stringify(payload) }),
    drop: () => fire('close'),
    closed: () => closed,
  };
}

/** Harness: records posts, captures scheduled reconnects so a test can run them deterministically. */
function harness() {
  const posts: { guildId: string | undefined; content: string }[] = [];
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const scheduled: { fn: () => void; ms: number }[] = [];
  const watcher = createStageWatcher({
    baseUrl: 'http://stage.test',
    post: (guildId, content) => {
      posts.push({ guildId, content });
      return Promise.resolve(true);
    },
    socketFactory: () => {
      const next = fakeSocket();
      sockets.push(next);
      return next.socket;
    },
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms });
      return scheduled.length;
    },
    cancel: () => {},
  });
  return {
    watcher,
    posts,
    sockets,
    scheduled,
    latest: () => sockets[sockets.length - 1],
    contents: () => posts.map((p) => p.content),
    runReconnect: () => scheduled.pop()?.fn(),
  };
}

const EDIT = (over: Record<string, unknown> = {}) => ({
  type: 'lottery-lobby',
  lobby: { title: 'L', teamCount: 2, totalBalls: 5, guildId: 'g1', rows: [] },
  adjusted: { teamId: 't1', team: 'Bravo Bears', from: 1, to: 4, guildId: 'g1', ...over },
});

describe('stageWsUrl', () => {
  it('derives the ws endpoint from the http base, trailing slashes and all', () => {
    expect(stageWsUrl('http://127.0.0.1:4610')).toBe('ws://127.0.0.1:4610/api/lottery/ws');
    expect(stageWsUrl('https://stage.example.com/')).toBe('wss://stage.example.com/api/lottery/ws');
  });
});

describe('adjustmentLine', () => {
  it('names the team, the new count, and the previous one', () => {
    expect(adjustmentLine({ teamId: 't1', team: 'Bravo Bears', from: 1, to: 4 })).toBe(
      '🛠 Commissioner set **Bravo Bears** to 4 balls in the Lottery Machine (was 1 ball).',
    );
  });

  it('omits "was" when the previous count is unknown rather than inventing one', () => {
    // The reconcile path reads a snapshot, which only carries the current value.
    expect(adjustmentLine({ teamId: 't1', team: 'Bravo Bears', to: 4 })).toBe(
      '🛠 Commissioner set **Bravo Bears** to 4 balls in the Lottery Machine.',
    );
  });
});

describe('createStageWatcher (#220)', () => {
  it('posts one line per commissioner edit, routed by guild', () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();

    h.latest().send(EDIT());
    h.latest().send(EDIT({ teamId: 't2', team: 'Alpha Antlers', from: 1, to: 2 }));

    expect(h.posts.map((p) => p.guildId)).toEqual(['g1', 'g1']);
    expect(h.contents()).toEqual([
      '🛠 Commissioner set **Bravo Bears** to 4 balls in the Lottery Machine (was 1 ball).',
      '🛠 Commissioner set **Alpha Antlers** to 2 balls in the Lottery Machine (was 1 ball).',
    ]);
  });

  it('ignores a bot-driven re-arm — only a human edit carries `adjusted`', () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();

    h.latest().send({
      type: 'lottery-lobby',
      lobby: { title: 'L', teamCount: 2, totalBalls: 5, guildId: 'g1', rows: [] },
    });

    expect(h.posts).toHaveLength(0);
  });

  it('never announces the same team landing on the same count twice', () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();

    h.latest().send(EDIT());
    h.latest().send(EDIT()); // duplicate broadcast
    expect(h.posts).toHaveLength(1);

    // A genuine follow-up edit to the same team is news again.
    h.latest().send(EDIT({ from: 4, to: 6 }));
    expect(h.contents()[1]).toContain('to 6 balls');
  });

  it('re-announces after a re-arm, because the bag it published is a different one', () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();

    h.latest().send(EDIT());
    h.latest().send({ type: 'lottery-lobby', lobby: { guildId: 'g1', rows: [] } }); // re-arm
    h.latest().send(EDIT());

    expect(h.posts).toHaveLength(2);
  });

  it('stays quiet on a reconnect that brings no news, and catches up on one that does', () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();
    h.latest().send(EDIT());
    expect(h.posts).toHaveLength(1);

    // Reconnect: the stage always opens with a full snapshot, whose `adjustments` are cumulative.
    const snapshot = (adjustments: { teamId: string; balls: number }[]) => ({
      type: 'lottery-state',
      snapshot: {
        phase: 'lobby',
        lobby: {
          guildId: 'g1',
          rows: [
            { teamId: 't1', team: 'Bravo Bears', balls: 4 },
            { teamId: 't2', team: 'Alpha Antlers', balls: 3 },
          ],
        },
        adjustments,
        reveals: [],
      },
    });
    h.latest().drop();
    h.runReconnect();
    h.latest().open();
    h.latest().send(snapshot([{ teamId: 't1', balls: 4 }]));
    expect(h.posts).toHaveLength(1); // already told them about t1 @ 4

    // An edit made while we were disconnected reaches the channel late rather than never — and
    // without a "was", since a snapshot can't say where it started.
    h.latest().send(
      snapshot([
        { teamId: 't1', balls: 4 },
        { teamId: 't2', balls: 3 },
      ]),
    );
    expect(h.posts).toHaveLength(2);
    expect(h.contents()[1]).toBe(
      '🛠 Commissioner set **Alpha Antlers** to 3 balls in the Lottery Machine.',
    );
  });

  it('forgets announced state once the lobby is gone, so the next ceremony starts clean', () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();
    h.latest().send(EDIT());

    // The bag got sealed; a later lobby is a different ceremony entirely.
    h.latest().send({ type: 'lottery-start', start: { commitment: 'hash' } });
    h.latest().send(EDIT());

    expect(h.posts).toHaveLength(2);
  });

  it('reconnects with exponential backoff, capped, and resets the delay after a good connect', () => {
    const h = harness();
    h.watcher.start();

    h.latest().drop();
    expect(h.scheduled[h.scheduled.length - 1].ms).toBe(BASE_BACKOFF_MS);
    h.runReconnect();
    h.latest().drop();
    expect(h.scheduled[h.scheduled.length - 1].ms).toBe(BASE_BACKOFF_MS * 2);
    h.runReconnect();
    h.latest().drop();
    expect(h.scheduled[h.scheduled.length - 1].ms).toBe(BASE_BACKOFF_MS * 4);

    // A successful open resets the ladder — the stage is idle for most of the year, so a long
    // outage must not leave the bot at the ceiling once it comes back.
    h.runReconnect();
    h.latest().open();
    h.latest().drop();
    expect(h.scheduled[h.scheduled.length - 1].ms).toBe(BASE_BACKOFF_MS);
  });

  it('caps the backoff rather than growing without bound', () => {
    const h = harness();
    h.watcher.start();
    for (let i = 0; i < 12; i += 1) {
      h.latest().drop();
      h.runReconnect();
    }
    h.latest().drop();
    expect(h.scheduled[h.scheduled.length - 1].ms).toBe(MAX_BACKOFF_MS);
  });

  it('start is idempotent, and stop closes the socket and halts reconnecting', () => {
    const h = harness();
    h.watcher.start();
    h.watcher.start();
    expect(h.sockets).toHaveLength(1);

    const live = h.latest();
    h.watcher.stop();
    expect(live.closed()).toBe(true);

    // A close event after stop must not resurrect the watcher.
    live.drop();
    expect(h.scheduled).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
  });

  it('shrugs off a malformed frame instead of posting or throwing', () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();

    const fire = (data: unknown): void => {
      h.latest().send(data);
    };
    expect(() => fire({ type: 'lottery-lobby', adjusted: { teamId: 't1' } })).not.toThrow();
    expect(() => fire({ type: 'lottery-lobby', adjusted: 'nope' })).not.toThrow();
    expect(() => fire({ nothing: true })).not.toThrow();
    expect(h.posts).toHaveLength(0);
  });
});
