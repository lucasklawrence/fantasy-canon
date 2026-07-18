import { afterEach, describe, expect, it } from 'vitest';
import { composeDrawSeed, computeCommitment, verifyHardenedDraw } from '@fantasy-canon/core';
import {
  buildPreviewPost,
  CeremonyAborted,
  CeremonyIo,
  CeremonyPost,
  createCeremony,
  markPreviewPosted,
  oddsRows,
  requestAbort,
  resetCeremoniesForTests,
  runCeremony,
  setCeremony,
} from '../draftOrderCeremony.js';

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

  it('sessions are stored per guild', () => {
    const session = makeSession();
    setCeremony(session);
    expect(session.guildId).toBe('guild-1');
  });
});
