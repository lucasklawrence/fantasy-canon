import { afterEach, describe, expect, it } from 'vitest';
import { composeDrawSeed, computeCommitment, verifyHardenedDraw } from '@fantasy-canon/core';
import {
  buildPreviewPost,
  CeremonyAborted,
  CeremonyIo,
  CeremonyPost,
  clearCeremony,
  createCeremony,
  getCeremony,
  interruptedDisclosureContent,
  markPreviewPosted,
  oddsRows,
  requestAbort,
  resetCeremoniesForTests,
  runCeremony,
  setCeremony,
  type RevealStage,
} from '../draftOrderCeremony.js';
import { createMemoryCeremonyStore, type PersistedCeremony } from '../ceremonyStore.js';

/** Records every stage call as `[method, payload]`, optionally failing selected methods. */
function collectorStage(failing: { start?: boolean } = {}): {
  stage: RevealStage;
  calls: [string, unknown][];
} {
  const calls: [string, unknown][] = [];
  const record =
    (method: string, fail = false) =>
    (payload: unknown): Promise<void> => {
      calls.push([method, payload]);
      return fail ? Promise.reject(new Error(`${method} down`)) : Promise.resolve();
    };
  return {
    calls,
    stage: {
      start: record('start', failing.start),
      beat: record('beat'),
      reveal: record('reveal'),
      finish: record('finish'),
      abort: record('abort'),
    },
  };
}

/** 12 fixture teams — last season's basement dwellers hold extra balls. */
const TEAMS = Array.from({ length: 12 }, (_, i) => ({
  teamId: `t${i + 1}`,
  displayName: `Team ${i + 1}`,
  bonusBalls: i >= 9 ? 2 : 0,
}));
const NAMES = new Map(TEAMS.map((t) => [t.teamId, t.displayName]));
const CONFIG = { teams: TEAMS, baseBallCount: 1 };

function makeSession() {
  const session = createCeremony('guild-1', '2026 Draft Lottery', CONFIG, NAMES);
  markPreviewPosted(session);
  return session;
}

/** Collects every post; message ids are deterministic (`msg-1`, `msg-2`, …). */
function collectorIo(): { io: CeremonyIo; posts: CeremonyPost[] } {
  const posts: CeremonyPost[] = [];
  return {
    posts,
    io: {
      post(post) {
        posts.push(post);
        return Promise.resolve({ id: `msg-${posts.length}` });
      },
    },
  };
}

const instantSleep = () => Promise.resolve();

afterEach(() => resetCeremoniesForTests());

describe('runCeremony', () => {
  it('posts the commitment before any draw output, in every code path', async () => {
    const session = makeSession();
    const { io, posts } = collectorIo();

    await runCeremony(session, io, { delayMs: 0, sleep: instantSleep, seedSource: () => 'seed' });

    expect(posts[0]?.kind).toBe('commitment');
    const kinds = posts.map((p) => p.kind);
    expect(kinds.indexOf('commitment')).toBeLessThan(kinds.indexOf('beat'));
    expect(kinds.indexOf('commitment')).toBeLessThan(kinds.indexOf('reveal'));
  });

  it('reveals worst to first with a beat before every reveal, then board + seed reveal', async () => {
    const session = makeSession();
    const { io, posts } = collectorIo();

    await runCeremony(session, io, { delayMs: 0, sleep: instantSleep, seedSource: () => 'seed' });

    const kinds = posts.map((p) => p.kind);
    // commitment + 12×(beat, reveal) + board + seed-reveal
    expect(kinds).toEqual([
      'commitment',
      ...Array.from({ length: 12 }, () => ['beat', 'reveal']).flat(),
      'board',
      'seed-reveal',
    ]);
    const beatPicks = posts
      .filter((p) => p.kind === 'beat')
      .map((p) => Number(/#(\d+)/.exec(p.content ?? '')?.[1]));
    expect(beatPicks).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('announced order equals verifyDraw for the committed configuration (draw seed = secret|commitMessageId)', async () => {
    const session = makeSession();
    const { io } = collectorIo();

    const draws = await runCeremony(session, io, {
      delayMs: 0,
      sleep: instantSleep,
      seedSource: () => 'fixture-secret',
    });

    // The commitment was the first post, so its id is msg-1.
    expect(session.commitMessageId).toBe('msg-1');
    expect(session.drawSeed).toBe(composeDrawSeed('fixture-secret', 'msg-1'));
    const verification = verifyHardenedDraw('fixture-secret', 'msg-1', CONFIG);
    expect(verification.drawSeed).toBe(session.drawSeed);
    expect(verification.draws).toEqual(draws);
    expect(verification.commitment).toBe(computeCommitment('fixture-secret', CONFIG));
    expect(session.commitment).toBe(verification.commitment);
    expect(session.state).toBe('FINALIZED');
  });

  it('the seed-reveal post carries the secret, the salt, and the composed draw seed', async () => {
    const session = makeSession();
    const { io, posts } = collectorIo();

    await runCeremony(session, io, {
      delayMs: 0,
      sleep: instantSleep,
      seedSource: () => 'fixture-secret',
    });

    const reveal = posts.find((p) => p.kind === 'seed-reveal');
    expect(reveal?.content).toContain('fixture-secret');
    expect(reveal?.content).toContain('msg-1');
    expect(reveal?.content).toContain(composeDrawSeed('fixture-secret', 'msg-1'));
  });

  it('abort mid-reveal posts the disclosure (secret revealed) and stops revealing', async () => {
    const session = makeSession();
    const { io, posts } = collectorIo();
    let sleeps = 0;
    const abortingSleep = () => {
      sleeps += 1;
      if (sleeps === 3) requestAbort(session);
      return Promise.resolve();
    };

    await expect(
      runCeremony(session, io, { delayMs: 0, sleep: abortingSleep, seedSource: () => 'secret' }),
    ).rejects.toThrow(CeremonyAborted);

    expect(session.state).toBe('CANCELLED');
    const last = posts[posts.length - 1];
    expect(last?.kind).toBe('abort');
    expect(last?.content).toContain('secret');
    expect(last?.content).toContain('would have been');
    // Reveals stop where the abort landed — picks 12 and 11 only.
    expect(posts.filter((p) => p.kind === 'reveal')).toHaveLength(2);
    expect(posts.some((p) => p.kind === 'board')).toBe(false);
  });

  it('a post failure after the commitment still discloses the seed (crash = abort policy)', async () => {
    const session = makeSession();
    const posts: CeremonyPost[] = [];
    const io: CeremonyIo = {
      post(post) {
        if (post.kind === 'beat' && posts.filter((p) => p.kind === 'beat').length === 1) {
          return Promise.reject(new Error('channel send failed'));
        }
        posts.push(post);
        return Promise.resolve({ id: `msg-${posts.length}` });
      },
    };

    await expect(
      runCeremony(session, io, { delayMs: 0, sleep: instantSleep, seedSource: () => 'secret' }),
    ).rejects.toThrow('channel send failed');

    expect(session.state).toBe('CANCELLED');
    expect(posts[posts.length - 1]?.kind).toBe('abort');
    expect(posts[posts.length - 1]?.content).toContain('secret');
  });

  it('refuses to run twice — a committed seed is never reused', async () => {
    const session = makeSession();
    const { io } = collectorIo();
    await runCeremony(session, io, { delayMs: 0, sleep: instantSleep, seedSource: () => 's' });

    await expect(
      runCeremony(session, io, { delayMs: 0, sleep: instantSleep, seedSource: () => 's' }),
    ).rejects.toThrow('Invalid state transition');
  });
});

describe('setup surfaces', () => {
  it('odds rows agree with the bag: bonus-ball teams lead and rows cover every team', () => {
    const session = createCeremony('guild-1', 'Lottery', CONFIG, NAMES);
    const rows = oddsRows(session);
    expect(rows).toHaveLength(12);
    expect(rows[0].balls).toBe(3);
    expect(rows[0].firstPct).toBeGreaterThan(rows[11].firstPct);
    const totalFirst = rows.reduce((sum, row) => sum + row.firstPct, 0);
    expect(totalFirst).toBeCloseTo(100, 6);
  });

  it('preview post renders the odds card and freezes the bag message', async () => {
    const session = createCeremony('guild-1', 'Lottery', CONFIG, NAMES);
    const preview = await buildPreviewPost(session);
    expect(preview.kind).toBe('preview');
    expect(preview.image?.data.length).toBeGreaterThan(0);
    expect(preview.content).toContain('frozen');
  });

  it('the registry stores and isolates sessions per guild', () => {
    const a = makeSession();
    setCeremony(a);
    const b = createCeremony('guild-2', 'Other Lottery', CONFIG, NAMES);
    setCeremony(b);
    expect(getCeremony('guild-1')).toBe(a);
    expect(getCeremony('guild-2')).toBe(b);
    clearCeremony('guild-1');
    expect(getCeremony('guild-1')).toBeUndefined();
    expect(getCeremony('guild-2')).toBe(b);
  });

  it('rejects duplicate display names case-insensitively', () => {
    const teams = [
      { teamId: 'a', displayName: 'Sharks' },
      { teamId: 'b', displayName: 'sharks' },
    ];
    const names = new Map([
      ['a', 'Sharks'],
      ['b', 'sharks'],
    ]);
    expect(() => createCeremony('guild-1', 'Lottery', { teams }, names)).toThrow(
      'Duplicate team name',
    );
  });

  it('an abort that races begin stops the ceremony before any commitment', async () => {
    const session = makeSession();
    const { io, posts } = collectorIo();
    requestAbort(session);

    await expect(
      runCeremony(session, io, { delayMs: 0, sleep: instantSleep, seedSource: () => 's' }),
    ).rejects.toThrow(CeremonyAborted);

    expect(posts).toHaveLength(0);
    expect(session.state).toBe('GAME_OPEN');
    expect(session.secretSeed).toBeUndefined();
  });
});

describe('ceremony persistence (#176)', () => {
  it('persists the seed before the post and updates it after, then clears at finalize', async () => {
    const session = makeSession();
    session.channelId = 'chan-1';
    const { io } = collectorIo();
    const store = createMemoryCeremonyStore();
    const saved: PersistedCeremony[] = [];
    const realSave = store.saveCommitted.bind(store);
    store.saveCommitted = (r): void => {
      saved.push({ ...r });
      realSave(r);
    };

    await runCeremony(session, io, {
      delayMs: 0,
      sleep: instantSleep,
      seedSource: () => 'sekret',
      store,
    });

    // Saved twice: once BEFORE the commitment post (no message id yet — the fail-closed backstop),
    // then updated AFTER with the salt (commit-message id).
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ channelId: 'chan-1', secretSeed: 'sekret' });
    expect(saved[0].commitMessageId).toBeUndefined();
    expect(saved[0].commitment).toBe(computeCommitment('sekret', CONFIG));
    expect(saved[1].commitMessageId).toBe('msg-1');
    // Cleared at finalize — the seed is public now, nothing to recover.
    expect(store.loadPending()).toEqual([]);
  });

  it('fails closed: a persist failure before the post aborts the run without posting anything', async () => {
    const session = makeSession();
    session.channelId = 'chan-1';
    const { io, posts } = collectorIo();
    const store = createMemoryCeremonyStore();
    store.saveCommitted = (): void => {
      throw new Error('disk full');
    };

    await expect(
      runCeremony(session, io, { delayMs: 0, sleep: instantSleep, seedSource: () => 's', store }),
    ).rejects.toThrow('could not persist ceremony state');

    // Nothing went public, and the session is back to GAME_OPEN so the commissioner can retry.
    expect(posts).toHaveLength(0);
    expect(session.state).toBe('GAME_OPEN');
  });

  it('clears the record after a successful abort disclosure', async () => {
    const session = makeSession();
    session.channelId = 'chan-1';
    const { io } = collectorIo();
    const store = createMemoryCeremonyStore();
    const abortingSleep = (): Promise<void> => {
      requestAbort(session);
      return Promise.resolve();
    };

    await expect(
      runCeremony(session, io, { delayMs: 0, sleep: abortingSleep, seedSource: () => 's', store }),
    ).rejects.toThrow(CeremonyAborted);

    expect(store.loadPending()).toEqual([]);
  });

  it('keeps the record when the abort disclosure post fails — startup recovery is the backstop', async () => {
    const session = makeSession();
    session.channelId = 'chan-1';
    const store = createMemoryCeremonyStore();
    let posts = 0;
    const io: CeremonyIo = {
      post: (p) => {
        posts += 1;
        if (p.kind === 'abort') return Promise.reject(new Error('channel gone'));
        return Promise.resolve({ id: `msg-${posts}` });
      },
    };
    const abortingSleep = (): Promise<void> => {
      requestAbort(session);
      return Promise.resolve();
    };

    await expect(
      runCeremony(session, io, { delayMs: 0, sleep: abortingSleep, seedSource: () => 's', store }),
    ).rejects.toThrow(CeremonyAborted);

    // Disclosure failed, so the committed seed stays persisted for the next startup to reveal.
    const pending = store.loadPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].secretSeed).toBe('s');
  });
});

describe('activity reveal stage (#169)', () => {
  it('streams beats to the stage instead of the channel; commitment/board/seed stay in-channel', async () => {
    const session = makeSession();
    const { io, posts } = collectorIo();
    const { stage, calls } = collectorStage();

    const draws = await runCeremony(session, io, {
      delayMs: 0,
      sleep: instantSleep,
      seedSource: () => 'stage-secret',
      stage,
    });

    // Channel: commitment first, then ONLY board + seed-reveal — no per-pick spam.
    expect(posts.map((p) => p.kind)).toEqual(['commitment', 'board', 'seed-reveal']);

    // Stage: start → 12×(beat, reveal) → finish, in strict order.
    expect(calls.map(([m]) => m)).toEqual([
      'start',
      ...Array.from({ length: 12 }, () => ['beat', 'reveal']).flat(),
      'finish',
    ]);
    const start = calls[0][1] as { commitment: string; teamCount: number; rows: unknown[] };
    expect(start.commitment).toBe(computeCommitment('stage-secret', CONFIG));
    expect(start.teamCount).toBe(12);
    expect(start.rows).toHaveLength(12);

    // Beats pace worst-to-first and the finish carries the full order + verify info.
    const beatPicks = calls
      .filter(([m]) => m === 'beat')
      .map(([, p]) => (p as { pick: number }).pick);
    expect(beatPicks).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const finish = calls[calls.length - 1][1] as {
      order: { pick: number; team: string }[];
      verify: { secretSeed: string; salt: string; drawSeed: string; commitment: string };
    };
    expect(finish.order.map((o) => o.pick)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(finish.order.map((o) => o.team).sort()).toEqual(
      draws
        .map((d) => NAMES.get(d.teamId) as string)
        .slice()
        .sort(),
    );
    expect(finish.verify.secretSeed).toBe('stage-secret');
    expect(finish.verify.salt).toBe('msg-1');
    expect(finish.verify.drawSeed).toBe(composeDrawSeed('stage-secret', 'msg-1'));
  });

  it('falls back to the in-channel reveal when the stage cannot even start', async () => {
    const session = makeSession();
    const { io, posts } = collectorIo();
    const { stage, calls } = collectorStage({ start: true });

    await runCeremony(session, io, {
      delayMs: 0,
      sleep: instantSleep,
      seedSource: () => 's',
      stage,
    });

    // Only the failed start reached the stage; the channel got the full card ceremony.
    expect(calls.map(([m]) => m)).toEqual(['start']);
    expect(posts.filter((p) => p.kind === 'beat')).toHaveLength(12);
    expect(posts.filter((p) => p.kind === 'reveal')).toHaveLength(12);
    expect(session.state).toBe('FINALIZED');
  });

  it('does NOT notify the stage on abort when its start failed (fallback ran in-channel)', async () => {
    const session = makeSession();
    const { io } = collectorIo();
    const { stage, calls } = collectorStage({ start: true });
    let beats = 0;
    const abortingSleep = (): Promise<void> => {
      beats += 1;
      if (beats === 2) requestAbort(session);
      return Promise.resolve();
    };

    await expect(
      runCeremony(session, io, { delayMs: 0, sleep: abortingSleep, seedSource: () => 's', stage }),
    ).rejects.toThrow(CeremonyAborted);

    // The stage never showed this run — an abort ping would paint over whatever it IS showing.
    expect(calls.map(([m]) => m)).toEqual(['start']);
  });

  it('notifies the stage on abort, after the in-channel disclosure', async () => {
    const session = makeSession();
    const { io, posts } = collectorIo();
    const { stage, calls } = collectorStage();
    let beats = 0;
    const abortingSleep = (): Promise<void> => {
      beats += 1;
      if (beats === 2) requestAbort(session);
      return Promise.resolve();
    };

    await expect(
      runCeremony(session, io, { delayMs: 0, sleep: abortingSleep, seedSource: () => 's', stage }),
    ).rejects.toThrow(CeremonyAborted);

    expect(calls.map(([m]) => m)).toContain('abort');
    expect(calls.map(([m]) => m)).not.toContain('finish');
    // The channel abort disclosure still went out (ADR 0006).
    expect(posts.some((p) => p.kind === 'abort')).toBe(true);
    const abortPayload = calls.find(([m]) => m === 'abort')?.[1] as { reason: string };
    expect(abortPayload.reason).toContain('aborted');
  });
});

describe('interruptedDisclosureContent (#176)', () => {
  it('reveals the seed, the commitment hash, and the salt, and flags the interruption', () => {
    const record: PersistedCeremony = {
      guildId: 'g',
      channelId: 'c',
      title: '2026 Draft Lottery',
      config: CONFIG,
      names: [...NAMES.entries()],
      secretSeed: 'the-secret',
      commitment: 'the-hash',
      commitMessageId: 'msg-1',
      drawSeed: 'the-secret|msg-1',
      state: 'LOTTERY_RUNNING',
      createdAt: 1,
    };

    const content = interruptedDisclosureContent(record);

    expect(content).toContain('the-secret');
    expect(content).toContain('the-hash');
    expect(content).toContain('msg-1');
    expect(content).toContain('interrupted');
  });
});
