import { describe, expect, it, vi } from 'vitest';
import {
  adjustmentLine,
  BASE_BACKOFF_MS,
  createStageWatcher,
  MAX_BACKOFF_MS,
  stageWsUrl,
  type StageBeginRequest,
  type StageSetupRequest,
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

/** Let the `post` promise chain settle — a line is only recorded as announced once it resolves. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Harness: records posts, captures scheduled reconnects so a test can run them deterministically. */
function harness(
  deliver: (attempt: number) => Promise<boolean> = () => Promise.resolve(true),
  reimport?: (guildId: string | undefined, stamp?: number) => Promise<boolean>,
  begin?: (guildId: string | undefined, request: StageBeginRequest) => Promise<boolean>,
  setup?: (request: StageSetupRequest) => Promise<boolean>,
) {
  const posts: { guildId: string | undefined; content: string }[] = [];
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const scheduled: { fn: () => void; ms: number }[] = [];
  let attempt = 0;
  const watcher = createStageWatcher({
    baseUrl: 'http://stage.test',
    post: (guildId, content) => {
      posts.push({ guildId, content });
      attempt += 1;
      return deliver(attempt);
    },
    socketFactory: () => {
      const next = fakeSocket();
      sockets.push(next);
      return next.socket;
    },
    ...(reimport ? { reimport } : {}),
    ...(begin ? { begin } : {}),
    ...(setup ? { setup } : {}),
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
    /** Deliver a frame and let any resulting post settle before the test asserts. */
    send: async (payload: unknown): Promise<void> => {
      sockets[sockets.length - 1].send(payload);
      await flush();
    },
    contents: () => posts.map((p) => p.content),
    runReconnect: () => scheduled.pop()?.fn(),
  };
}

/**
 * One commissioner edit as the stage broadcasts it: the recomputed lobby, the *cumulative*
 * pending set, and the detail describing what just changed.
 */
const EDIT = (
  over: { teamId?: string; team?: string; from?: number; to?: number } = {},
  pending?: { teamId: string; balls: number }[],
) => {
  const adjusted = { teamId: 't1', team: 'Bravo Bears', from: 1, to: 4, guildId: 'g1', ...over };
  return {
    type: 'lottery-lobby',
    lobby: { title: 'L', teamCount: 2, totalBalls: 5, guildId: 'g1', rows: [] },
    adjustments: pending ?? [{ teamId: adjusted.teamId, balls: adjusted.to }],
    adjusted,
  };
};

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
  it('posts one line per commissioner edit, routed by guild', async () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();

    await h.send(EDIT());
    await h.send(
      EDIT({ teamId: 't2', team: 'Alpha Antlers', from: 1, to: 2 }, [
        { teamId: 't1', balls: 4 },
        { teamId: 't2', balls: 2 },
      ]),
    );

    expect(h.posts.map((p) => p.guildId)).toEqual(['g1', 'g1']);
    expect(h.contents()).toEqual([
      '🛠 Commissioner set **Bravo Bears** to 4 balls in the Lottery Machine (was 1 ball).',
      '🛠 Commissioner set **Alpha Antlers** to 2 balls in the Lottery Machine (was 1 ball).',
    ]);
  });

  it('ignores a bot-driven re-arm — only a human edit carries `adjusted`', async () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();

    await h.send({
      type: 'lottery-lobby',
      lobby: { title: 'L', teamCount: 2, totalBalls: 5, guildId: 'g1', rows: [] },
    });

    expect(h.posts).toHaveLength(0);
  });

  it('never announces the same team landing on the same count twice', async () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();

    await h.send(EDIT());
    await h.send(EDIT()); // duplicate broadcast
    expect(h.posts).toHaveLength(1);

    // A genuine follow-up edit to the same team is news again.
    await h.send(EDIT({ from: 4, to: 6 }));
    expect(h.contents()[1]).toContain('to 6 balls');
    expect(h.contents()[1]).toContain('(was 4 balls)');
  });

  it('re-announces after a fresh setup, whose re-arm drops every pending edit', async () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();

    await h.send(EDIT());
    // A `setup` re-arm carries no pending set — a brand-new bag makes old edits meaningless.
    await h.send({ type: 'lottery-lobby', lobby: { guildId: 'g1', rows: [] } });
    await h.send(EDIT());

    expect(h.posts).toHaveLength(2);
  });

  it('stays silent through a re-arm that keeps pending edits (the mini-game path)', async () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();
    await h.send(EDIT());
    expect(h.posts).toHaveLength(1);

    // `keepAdjustments: true` republishes the whole lobby *and* retains the edit. Dedupe is keyed
    // on the stage's pending set, not on the events witnessed, so this is not news…
    await h.send({
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [{ teamId: 't1', team: 'Bravo Bears', balls: 4 }] },
      adjustments: [{ teamId: 't1', balls: 4 }],
    });
    expect(h.posts).toHaveLength(1);

    // …and neither is the snapshot a later reconnect brings, which carries the same retained edit.
    h.latest().drop();
    h.runReconnect();
    h.latest().open();
    await h.send({
      type: 'lottery-state',
      snapshot: {
        phase: 'lobby',
        lobby: { guildId: 'g1', rows: [{ teamId: 't1', team: 'Bravo Bears', balls: 4 }] },
        adjustments: [{ teamId: 't1', balls: 4 }],
        reveals: [],
      },
    });
    expect(h.posts).toHaveLength(1);
  });

  it('stays quiet on a reconnect that brings no news, and catches up on one that does', async () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();
    await h.send(EDIT());
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
    await h.send(snapshot([{ teamId: 't1', balls: 4 }]));
    expect(h.posts).toHaveLength(1); // already told them about t1 @ 4

    // An edit made while we were disconnected reaches the channel late rather than never — and
    // without a "was", since a snapshot can't say where it started.
    await h.send(
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

  it('forgets announced state once the lobby is gone, so the next ceremony starts clean', async () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();
    await h.send(EDIT());

    // The bag got sealed; a later lobby is a different ceremony entirely.
    await h.send({ type: 'lottery-start', start: { commitment: 'hash' } });
    await h.send(EDIT());

    expect(h.posts).toHaveLength(2);
  });

  it('retries a line Discord refused, instead of recording it as delivered', async () => {
    // Committing the announced count before the send lands would make a transient failure
    // permanent — the reconcile below would treat the line as delivered and never retry it.
    const h = harness((attempt) =>
      attempt === 1 ? Promise.reject(new Error('discord 503')) : Promise.resolve(true),
    );
    h.watcher.start();
    h.latest().open();

    await h.send(EDIT());
    expect(h.posts).toHaveLength(1); // attempted, but not delivered

    // The next snapshot carrying the same pending edit tries again, and this time it lands.
    await h.send({
      type: 'lottery-state',
      snapshot: {
        phase: 'lobby',
        lobby: { guildId: 'g1', rows: [{ teamId: 't1', team: 'Bravo Bears', balls: 4 }] },
        adjustments: [{ teamId: 't1', balls: 4 }],
        reveals: [],
      },
    });
    expect(h.posts).toHaveLength(2);

    // …and once it has landed, it stops being retried.
    await h.send(EDIT());
    expect(h.posts).toHaveLength(2);
  });

  it('retries when there was nowhere to post yet (a `false` result is not a delivery)', async () => {
    const h = harness((attempt) => Promise.resolve(attempt !== 1));
    h.watcher.start();
    h.latest().open();

    await h.send(EDIT());
    await h.send(EDIT());
    expect(h.posts).toHaveLength(2);
  });

  it('ignores a stale socket after a stop/start cycle', async () => {
    const h = harness();
    h.watcher.start();
    const stale = h.latest();
    stale.open();

    h.watcher.stop();
    h.watcher.start();
    expect(h.sockets).toHaveLength(2);

    // The old socket is still alive long enough to deliver its own close and even a frame. Acting
    // on either would null out the *new* socket and schedule a reconnect on top of it.
    stale.drop();
    expect(h.scheduled).toHaveLength(0);
    expect(h.sockets).toHaveLength(2);
    stale.send(EDIT());
    await flush();
    expect(h.posts).toHaveLength(0);
  });

  it('says so in the log when the socket drops and when it comes back (#250)', () => {
    // The gap is invisible from Discord and from the Activity — a commissioner's press just sits
    // there. One line per drop and one on recovery is what made the live incident diagnosable.
    const warns: string[] = [];
    const logs: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.join(' '));
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
    try {
      const h = harness();
      h.watcher.start();
      h.latest().open();
      // A clean first connect is not news.
      expect(logs.filter((l) => l.includes('reconnected'))).toHaveLength(0);

      h.latest().drop();
      expect(warns.some((w) => w.includes('stage watcher offline'))).toBe(true);
      expect(warns.some((w) => w.includes('will not be heard'))).toBe(true);

      h.runReconnect();
      h.latest().open();
      expect(logs.some((l) => l.includes('stage watcher reconnected'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('posts a line for a rename, independently of the ball edits (#219)', async () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();

    await h.send({
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [{ teamId: 't1', team: 'Duck Dynasty', balls: 1 }] },
      renames: [{ teamId: 't1', displayName: 'Duck Dynasty' }],
      renamed: { teamId: 't1', from: 'Delta Ducks', to: 'Duck Dynasty', guildId: 'g1' },
    });
    expect(h.contents()).toEqual([
      '🛠 Commissioner renamed **Delta Ducks** to **Duck Dynasty** in the Lottery Machine.',
    ]);

    // A ball edit on the *same* team is separate news — the two pending sets don't shadow one
    // another. The stage always broadcasts both sets in full, so the rename rides along.
    await h.send({
      ...EDIT({ teamId: 't1', team: 'Duck Dynasty', from: 1, to: 4 }),
      renames: [{ teamId: 't1', displayName: 'Duck Dynasty' }],
    });
    expect(h.posts).toHaveLength(2);
    expect(h.contents()[1]).toContain('to 4 balls');

    // Re-broadcasting the same rename is not news.
    await h.send({
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [{ teamId: 't1', team: 'Duck Dynasty', balls: 4 }] },
      adjustments: [{ teamId: 't1', balls: 4 }],
      renames: [{ teamId: 't1', displayName: 'Duck Dynasty' }],
    });
    expect(h.posts).toHaveLength(2);
  });

  it('catches up on a rename made while disconnected, without inventing the old name', async () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();

    await h.send({
      type: 'lottery-state',
      snapshot: {
        phase: 'lobby',
        lobby: { guildId: 'g1', rows: [{ teamId: 't1', team: 'Duck Dynasty', balls: 1 }] },
        renames: [{ teamId: 't1', displayName: 'Duck Dynasty' }],
        reveals: [],
      },
    });
    expect(h.contents()).toEqual([
      '🛠 Commissioner renamed a team to **Duck Dynasty** in the Lottery Machine.',
    ]);
  });

  it('honours a re-import request exactly once while it is in flight (#219)', async () => {
    const calls: (string | undefined)[] = [];
    let release: (() => void) | undefined;
    const h = harness(undefined, (guildId) => {
      calls.push(guildId);
      return new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      });
    });
    h.watcher.start();
    h.latest().open();

    const flagged = {
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [] },
      reimportRequested: true,
    };
    await h.send(flagged);
    // A repeated broadcast (or a reconnect snapshot) must not launch a second ESPN refetch.
    await h.send(flagged);
    await h.send({
      type: 'lottery-state',
      snapshot: { phase: 'lobby', lobby: { guildId: 'g1' }, reimportRequested: true, reveals: [] },
    });
    expect(calls).toEqual(['g1']);

    // Once it settles, a *later* request is honoured again.
    release?.();
    await flush();
    await h.send(flagged);
    expect(calls).toEqual(['g1', 'g1']);
  });

  it('picks up a retry pressed while an import was already in flight (#250)', async () => {
    // The client hands the button back after a long silence, so a second press can land while
    // the first import is still running. The single-flight guard skips it, and the first
    // attempt's release is scoped to its own stamp — so without this hand-off nothing would
    // ever honour the retry, which is the same "accepted, then nothing happened" the issue is
    // about.
    const calls: (number | undefined)[] = [];
    const releases: (() => void)[] = [];
    const h = harness(undefined, (_guildId, stamp) => {
      calls.push(stamp);
      return new Promise<boolean>((resolve) => {
        releases.push(() => resolve(false));
      });
    });
    h.watcher.start();
    h.latest().open();

    const press = (at: number): unknown => ({
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [] },
      reimportRequested: true,
      reimportRequestedAt: at,
    });
    await h.send(press(100));
    expect(calls).toEqual([100]);

    // The retry, recorded while the first import is still grinding: skipped for now…
    await h.send(press(101));
    expect(calls).toEqual([100]);

    // …and picked up the moment the first flight settles, without a further broadcast.
    releases[0]();
    await flush();
    expect(calls).toEqual([100, 101]);

    // The second flight finishing with nothing newer queued must not loop.
    releases[1]();
    await flush();
    expect(calls).toEqual([100, 101]);
  });

  it('ignores a re-import request when no handler is wired', async () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();
    await h.send({
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [] },
      reimportRequested: true,
    });
    expect(h.posts).toHaveLength(0);
  });

  it('posts ONE line for a bulk level-all, and stays silent about its per-team entries (#252)', async () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();

    const bulkFrame = {
      type: 'lottery-lobby',
      lobby: {
        guildId: 'g1',
        rows: [
          { teamId: 't1', team: 'Alpha' },
          { teamId: 't2', team: 'Bravo' },
        ],
      },
      adjustments: [
        { teamId: 't1', balls: 5 },
        { teamId: 't2', balls: 5 },
      ],
      adjustedAll: { balls: 5, guildId: 'g1' },
    };
    await h.send(bulkFrame);
    expect(h.contents()).toEqual([
      '🛠 Commissioner set every team to 5 balls in the Lottery Machine.',
    ]);

    // A duplicate frame, and the reconnect snapshot carrying the same cumulative set, are old news.
    await h.send(bulkFrame);
    await h.send({
      type: 'lottery-state',
      snapshot: {
        phase: 'lobby',
        lobby: bulkFrame.lobby,
        adjustments: bulkFrame.adjustments,
        reveals: [],
      },
    });
    expect(h.posts).toHaveLength(1);

    // A later single-team edit on top of the leveled field speaks normally.
    await h.send({
      type: 'lottery-lobby',
      lobby: bulkFrame.lobby,
      adjustments: [
        { teamId: 't1', balls: 7 },
        { teamId: 't2', balls: 5 },
      ],
      adjusted: { teamId: 't1', team: 'Alpha', from: 5, to: 7, guildId: 'g1' },
    });
    expect(h.posts).toHaveLength(2);
    expect(h.contents()[1]).toContain('Alpha');
  });

  it('seal-only audit mode silences the play-by-play but never the action triggers (#252)', async () => {
    const reimports: (string | undefined)[] = [];
    const h = harness(undefined, (guildId) => {
      reimports.push(guildId);
      return Promise.resolve(true);
    });
    h.watcher.start();
    h.latest().open();

    await h.send({
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [{ teamId: 't1', team: 'Alpha' }] },
      adjustments: [{ teamId: 't1', balls: 4 }],
      renames: [{ teamId: 't1', displayName: 'Alpha Prime' }],
      adjusted: { teamId: 't1', team: 'Alpha', from: 1, to: 4, guildId: 'g1' },
      adjustedAll: { balls: 4, guildId: 'g1' },
      reimportRequested: true,
      auditMode: 'seal-only',
    });

    // No chatter of any kind…
    expect(h.posts).toHaveLength(0);
    // …but the re-import request was still honoured — quiet is not dead.
    expect(reimports).toEqual(['g1']);

    // Silence is a choice, not a deferral: flipping back to 'live' with the same pending set
    // must not replay the edits the commissioner deliberately kept quiet.
    await h.send({
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [{ teamId: 't1', team: 'Alpha' }] },
      adjustments: [{ teamId: 't1', balls: 4 }],
      renames: [{ teamId: 't1', displayName: 'Alpha Prime' }],
    });
    expect(h.posts).toHaveLength(0);
  });

  it('reserves bulk-covered teams while the bulk line is in flight (#252)', async () => {
    let release: ((delivered: boolean) => void) | undefined;
    const h = harness(() => new Promise<boolean>((resolve) => (release = resolve)));
    h.watcher.start();
    h.latest().open();

    const pending = [
      { teamId: 't1', balls: 5 },
      { teamId: 't2', balls: 5 },
    ];
    await h.send({
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [] },
      adjustments: pending,
      adjustedAll: { balls: 5, guildId: 'g1' },
    });
    expect(h.posts).toHaveLength(1); // the bulk line, delivery still pending

    // A frame that lands mid-delivery WITHOUT the bulk detail (a rename broadcast, say) must not
    // spray the same act as per-team lines — the covered teams are reserved until it settles.
    await h.send({
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [] },
      adjustments: pending,
    });
    expect(h.posts).toHaveLength(1);

    release?.(true);
    await flush();
    await h.send({
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [] },
      adjustments: pending,
    });
    expect(h.posts).toHaveLength(1); // now recorded as seen — still one line total
  });

  it('routes the bulk line by the frame guild, not the detail (#252)', async () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();
    await h.send({
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [] },
      adjustments: [{ teamId: 't1', balls: 3 }],
      adjustedAll: { balls: 3 }, // no guildId on the detail
    });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0].guildId).toBe('g1');
  });

  it('honours a setup press from an idle snapshot exactly once while it is in flight (#253)', async () => {
    const calls: { guildId: string; requestedBy: string; season: number }[] = [];
    let release: (() => void) | undefined;
    const h = harness(undefined, undefined, undefined, (request) => {
      calls.push(request);
      return new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      });
    });
    h.watcher.start();
    h.latest().open();

    const idle = {
      type: 'lottery-state',
      snapshot: {
        phase: 'idle',
        reveals: [],
        setupRequested: { guildId: 'g1', requestedBy: 'presser', season: 2026 },
      },
    };
    await h.send(idle);
    await h.send(idle); // a reconnect snapshot must not double the ESPN import
    expect(calls).toEqual([{ guildId: 'g1', requestedBy: 'presser', season: 2026 }]);

    release?.();
    await flush();
    await h.send(idle);
    expect(calls).toHaveLength(2); // settled ⇒ a later (still-pending) press is honoured again

    // Junk frames never reach the callback, and non-idle phases don't carry the doorbell.
    await h.send({
      type: 'lottery-state',
      snapshot: { phase: 'idle', reveals: [], setupRequested: { guildId: 'g1', season: 'x' } },
    });
    expect(calls).toHaveLength(2);
  });

  it('honours a begin request exactly once while it is in flight (#233)', async () => {
    const calls: { guildId: string | undefined; request: StageBeginRequest }[] = [];
    let release: (() => void) | undefined;
    const h = harness(undefined, undefined, (guildId, request) => {
      calls.push({ guildId, request });
      return new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      });
    });
    h.watcher.start();
    h.latest().open();

    const flagged = {
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [] },
      beginRequested: { delaySeconds: 10, direction: 'first-to-last', requestedBy: 'commish' },
    };
    await h.send(flagged);
    // A repeated broadcast (or a reconnect snapshot) must not seal the bag twice.
    await h.send(flagged);
    await h.send({
      type: 'lottery-state',
      snapshot: {
        phase: 'lobby',
        lobby: { guildId: 'g1' },
        beginRequested: { delaySeconds: 10, direction: 'first-to-last' },
        reveals: [],
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      guildId: 'g1',
      request: { delaySeconds: 10, direction: 'first-to-last', requestedBy: 'commish' },
    });

    // Once it settles, a later request is honoured again (the bot-side state guard is what
    // refuses a stale one — the watcher only guarantees single-flight).
    release?.();
    await flush();
    await h.send(flagged);
    expect(calls).toHaveLength(2);
  });

  it('lets a pending re-import suppress a begin — the import re-arm voids the press (#233)', async () => {
    const begins: (string | undefined)[] = [];
    const h = harness(
      undefined,
      () => Promise.resolve(true),
      (guildId) => {
        begins.push(guildId);
        return Promise.resolve(true);
      },
    );
    h.watcher.start();
    h.latest().open();

    await h.send({
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [] },
      reimportRequested: true,
      beginRequested: { delaySeconds: 20, direction: 'worst-to-first' },
    });
    // Sealing now would commit a bag the refetch is about to replace.
    expect(begins).toHaveLength(0);
  });

  it('drops a begin request whose frame fails the vocabulary guard (#233)', async () => {
    const begins: StageBeginRequest[] = [];
    const h = harness(undefined, undefined, (_guildId, request) => {
      begins.push(request);
      return Promise.resolve(true);
    });
    h.watcher.start();
    h.latest().open();

    for (const beginRequested of [
      { delaySeconds: 0, direction: 'worst-to-first' }, // instant pacing — refused, not honoured
      { delaySeconds: 20, direction: 'sideways' },
      { delaySeconds: 'twenty', direction: 'worst-to-first' },
      { delaySeconds: 20, direction: 'worst-to-first', visual: 'zoetrope' }, // junk visual (#235)
      'begin!',
    ]) {
      await h.send({ type: 'lottery-lobby', lobby: { guildId: 'g1', rows: [] }, beginRequested });
    }
    expect(begins).toHaveLength(0);
  });

  it('carries the race visual through the begin request; absent means an older api (#235)', async () => {
    const begins: StageBeginRequest[] = [];
    const h = harness(undefined, undefined, (_guildId, request) => {
      begins.push(request);
      return Promise.resolve(true);
    });
    h.watcher.start();
    h.latest().open();

    await h.send({
      type: 'lottery-lobby',
      lobby: { guildId: 'g1', rows: [] },
      beginRequested: { delaySeconds: 10, direction: 'worst-to-first', visual: 'race' },
    });
    expect(begins).toHaveLength(1);
    expect(begins[0].visual).toBe('race');

    // An api that predates the field still begins fine — the visual just defaults downstream.
    await h.send({
      type: 'lottery-lobby',
      lobby: { guildId: 'g2', rows: [] },
      beginRequested: { delaySeconds: 10, direction: 'worst-to-first' },
    });
    expect(begins).toHaveLength(2);
    expect(begins[1].visual).toBeUndefined();
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

  it('shrugs off a malformed frame instead of posting or throwing', async () => {
    const h = harness();
    h.watcher.start();
    h.latest().open();

    // A frame whose `adjusted` is unusable must not throw — and must not post, since without a
    // pending set there is nothing to reconcile against.
    await h.send({ type: 'lottery-lobby', adjusted: { teamId: 't1' } });
    await h.send({ type: 'lottery-lobby', adjusted: 'nope' });
    await h.send({ nothing: true });
    await h.send('{not json');
    expect(h.posts).toHaveLength(0);
  });
});
