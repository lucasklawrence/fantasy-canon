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
} from '../draftOrderCeremony.js';
import { createMemoryCeremonyStore, type PersistedCeremony } from '../ceremonyStore.js';

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
  it('persists the committed record and clears it once the seed is revealed at finalize', async () => {
    const session = makeSession();
    session.channelId = 'chan-1';
    const { io } = collectorIo();
    const store = createMemoryCeremonyStore();
    const saved: PersistedCeremony[] = [];
    const realSave = store.saveCommitted.bind(store);
    store.saveCommitted = (r): void => {
      saved.push(r);
      realSave(r);
    };

    await runCeremony(session, io, {
      delayMs: 0,
      sleep: instantSleep,
      seedSource: () => 'sekret',
      store,
    });

    // Saved exactly once, at commit, with everything needed to reveal later.
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      guildId: 'guild-1',
      channelId: 'chan-1',
      secretSeed: 'sekret',
      commitMessageId: 'msg-1',
      state: 'LOTTERY_RUNNING',
    });
    expect(saved[0].commitment).toBe(computeCommitment('sekret', CONFIG));
    // Cleared at finalize — the seed is public now, nothing to recover.
    expect(store.loadPending()).toEqual([]);
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
