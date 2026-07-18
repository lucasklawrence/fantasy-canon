import { afterEach, describe, expect, it } from 'vitest';
import type { APIButtonComponentWithCustomId } from 'discord.js';
import { ballCountForTeam, scoreReactionGame } from '@fantasy-canon/core';
import type { ReactionAttempt } from '@fantasy-canon/core';
import {
  applyMiniGameBonuses,
  CeremonyIo,
  CeremonyPost,
  createCeremony,
  markPreviewPosted,
  oddsRows,
  resetCeremoniesForTests,
  runCeremony,
  setCeremony,
  clearCeremony,
} from '../draftOrderCeremony.js';
import {
  buildTeamButtonRows,
  finishReactionRound,
  formatRoundResults,
  MAX_ROUND_TEAMS,
  ReactionRecorder,
  RoundTeam,
  runReactionRound,
} from '../reactionRound.js';

const TEAMS: RoundTeam[] = Array.from({ length: 4 }, (_, i) => ({
  teamId: `t${i + 1}`,
  name: `Team ${i + 1}`,
}));

function makeSession(bonuses: Record<string, number> = {}) {
  const session = createCeremony(
    'guild-1',
    '2027 Draft Lottery',
    {
      teams: TEAMS.map((t) => ({
        teamId: t.teamId,
        displayName: t.name,
        bonusBalls: bonuses[t.teamId] ?? 0,
      })),
      baseBallCount: 1,
    },
    new Map(TEAMS.map((t) => [t.teamId, t.name])),
  );
  markPreviewPosted(session);
  setCeremony(session);
  return session;
}

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

describe('ReactionRecorder', () => {
  it('records valid clicks with GO-relative times and burns pre-GO clicks as false starts', () => {
    const recorder = new ReactionRecorder();
    expect(recorder.record('t1', 'u1', 'alice', 900)).toEqual({
      kind: 'recorded',
      status: 'early',
    });
    recorder.markGo(1000);
    expect(recorder.record('t2', 'u2', 'bob', 1235)).toEqual({
      kind: 'recorded',
      status: 'valid',
      reactionMs: 235,
    });
    expect(recorder.getAttempts()).toMatchObject([
      { teamId: 't1', status: 'early' },
      { teamId: 't2', status: 'valid', reactionMs: 235 },
    ]);
    expect(recorder.clickerFor('t2')).toBe('bob');
  });

  it('locks a team after its first click and spends each user’s only click', () => {
    const recorder = new ReactionRecorder();
    recorder.markGo(1000);
    recorder.record('t1', 'u1', 'alice', 1100);
    // A rival re-click on a locked team changes nothing…
    expect(recorder.record('t1', 'u2', 'bob', 1050)).toEqual({ kind: 'team-locked' });
    // …and a user who already clicked can't claim a second team.
    expect(recorder.record('t2', 'u1', 'alice', 1200)).toEqual({ kind: 'user-spent' });
    expect(recorder.getAttempts()).toHaveLength(1);
    // The spent user's rejected click did not lock t2 for its real manager.
    expect(recorder.record('t2', 'u3', 'cleo', 1300)).toMatchObject({ status: 'valid' });
  });

  it('a false start locks the team — the recorder feeds core, which keeps the first attempt', () => {
    const recorder = new ReactionRecorder();
    recorder.record('t1', 'u1', 'alice', 900);
    recorder.markGo(1000);
    expect(recorder.record('t1', 'u2', 'bob', 1100)).toEqual({ kind: 'team-locked' });
    const result = scoreReactionGame(recorder.getAttempts());
    expect(result.bonusByTeam).toEqual({});
  });
});

describe('buildTeamButtonRows', () => {
  it('chunks one button per team into rows of five', () => {
    const teams = Array.from({ length: 12 }, (_, i) => ({ teamId: `t${i}`, name: `Team ${i}` }));
    const rows = buildTeamButtonRows(teams, 'rr:test');
    expect(rows.map((row) => row.components.length)).toEqual([5, 5, 2]);
    const first = rows[0].components[0].toJSON() as APIButtonComponentWithCustomId;
    expect(first.custom_id).toBe('rr:test:t0');
    expect(first.label).toBe('Team 0');
  });

  it('truncates over-long labels and rejects more than the Discord grid cap', () => {
    const rows = buildTeamButtonRows([{ teamId: 't1', name: 'Z'.repeat(120) }], 'rr:test');
    const long = rows[0].components[0].toJSON() as APIButtonComponentWithCustomId;
    expect(long.label).toHaveLength(80);
    const tooMany = Array.from({ length: MAX_ROUND_TEAMS + 1 }, (_, i) => ({
      teamId: `t${i}`,
      name: `T${i}`,
    }));
    expect(() => buildTeamButtonRows(tooMany, 'rr:test')).toThrow(/at most 25/);
  });
});

describe('formatRoundResults', () => {
  it('shows podium with times and bonuses, false starts, and no-shows', () => {
    const attempts: ReactionAttempt[] = [
      { teamId: 't1', status: 'valid', reactionMs: 120, attemptAt: new Date(1) },
      { teamId: 't2', status: 'valid', reactionMs: 200, attemptAt: new Date(2) },
      { teamId: 't3', status: 'early', attemptAt: new Date(0) },
    ];
    const content = formatRoundResults(scoreReactionGame(attempts), attempts, TEAMS, (teamId) =>
      teamId === 't1' ? 'alice' : undefined,
    );
    expect(content).toContain('🥇 Team 1 — 120 ms → **+2 balls** — clicked by alice');
    expect(content).toContain('🥈 Team 2 — 200 ms → **+1 ball**');
    expect(content).toContain('🚨 False starts (attempt burned): Team 3');
    expect(content).toContain('😴 Never clicked: Team 4');
  });

  it('says the bag is unchanged when nobody scored', () => {
    const content = formatRoundResults(scoreReactionGame([]), [], TEAMS, () => undefined);
    expect(content).toContain('Nobody scored — the bag is unchanged.');
    expect(content).toContain('😴 Never clicked: Team 1, Team 2, Team 3, Team 4');
  });
});

describe('applyMiniGameBonuses', () => {
  it('changes the bag composition and therefore the computed odds', () => {
    const session = makeSession();
    const before = oddsRows(session);
    applyMiniGameBonuses(session, { t1: 2, t2: 1 });

    const balls = new Map(session.config.teams.map((t) => [t.teamId, ballCountForTeam(t, 1)]));
    expect([...balls.values()]).toEqual([3, 2, 1, 1]);
    const after = oddsRows(session);
    const firstPct = (rows: typeof before, team: string) =>
      rows.find((r) => r.team === team)?.firstPct;
    expect(firstPct(before, 'Team 1')).toBeCloseTo(25);
    expect(firstPct(after, 'Team 1')).toBeCloseTo((3 / 7) * 100);
    expect(firstPct(after, 'Team 3')).toBeCloseTo((1 / 7) * 100);
  });

  it('stacks on setup bonuses and a re-run replaces only the mini-game share', () => {
    const session = makeSession({ t4: 2 });
    applyMiniGameBonuses(session, { t1: 2, t2: 1 });
    applyMiniGameBonuses(session, { t3: 2, t1: 1 });

    const byTeam = new Map(session.config.teams.map((t) => [t.teamId, t.bonusBalls]));
    // t1: mini-game 2 replaced by 1; t2: award gone; t3: new +2; t4: setup grant untouched.
    expect(byTeam.get('t1')).toBe(1);
    expect(byTeam.get('t2')).toBe(0);
    expect(byTeam.get('t3')).toBe(2);
    expect(byTeam.get('t4')).toBe(2);
  });

  it('refuses once the bag is no longer mutable', () => {
    const session = makeSession();
    session.state = 'LOTTERY_RUNNING';
    expect(() => applyMiniGameBonuses(session, { t1: 2 })).toThrow(/GAME_OPEN/);
  });
});

describe('finishReactionRound', () => {
  const ATTEMPTS: ReactionAttempt[] = [
    { teamId: 't1', status: 'valid', reactionMs: 120, attemptAt: new Date(1) },
    { teamId: 't2', status: 'valid', reactionMs: 200, attemptAt: new Date(2) },
    { teamId: 't3', status: 'early', attemptAt: new Date(0) },
  ];

  it('posts results then a fresh odds preview, strictly before any commitment (fairness ordering)', async () => {
    const session = makeSession();
    const { io, posts } = collectorIo();

    const result = await finishReactionRound(session, io, ATTEMPTS, () => undefined);
    expect(result?.bonusByTeam).toEqual({ t1: 2, t2: 1 });
    expect(posts.map((p) => p.kind)).toEqual(['minigame', 'preview']);
    expect(posts[1].image?.name).toBe('lottery-odds.png');

    // Dry-run of lottery night: the commitment posts after the public bonus-ball record and
    // binds the updated bag (Team 1 now holds 1 base + 2 bonus = 3 balls).
    await runCeremony(session, io, { delayMs: 0, sleep: instantSleep, seedSource: () => 'seed' });
    expect(posts[2].kind).toBe('commitment');
    expect(posts[2].content).toContain('Team 1 (`t1`) — 3 ball(s)');
    expect(posts.map((p) => p.kind).slice(-2)).toEqual(['board', 'seed-reveal']);
    expect(session.state).toBe('FINALIZED');
  });

  it('discards the round without applying bonuses when the ceremony moved on', async () => {
    const session = makeSession();
    clearCeremony(session.guildId);
    const { io, posts } = collectorIo();

    const result = await finishReactionRound(session, io, ATTEMPTS, () => undefined);
    expect(result).toBeUndefined();
    expect(posts).toHaveLength(1);
    expect(posts[0].content).toContain('discarded');
    expect(session.config.teams.every((t) => (t.bonusBalls ?? 0) === 0)).toBe(true);
  });
});

describe('ceremony without the mini-game', () => {
  it('runs end-to-end on base weights when the round is skipped', async () => {
    const session = makeSession();
    const { io, posts } = collectorIo();

    await runCeremony(session, io, { delayMs: 0, sleep: instantSleep, seedSource: () => 'seed' });
    expect(session.state).toBe('FINALIZED');
    expect(posts[0].kind).toBe('commitment');
    expect(posts[0].content).toContain('Team 1 (`t1`) — 1 ball(s)');
  });
});

describe('runReactionRound', () => {
  it('runs armed → GO → window → scoring against a fake channel, burning early clicks', async () => {
    const session = makeSession();
    const { io, posts } = collectorIo();

    type CollectHandler = (button: {
      customId: string;
      user: { id: string; username: string };
      createdTimestamp: number;
      reply: () => Promise<void>;
    }) => void;
    let collect: CollectHandler | undefined;
    let stopped: string | undefined;
    const edits: string[] = [];
    let armedComponents: ReturnType<typeof buildTeamButtonRows> = [];

    const message = {
      createMessageComponentCollector: (opts: { filter: (i: { customId: string }) => boolean }) => {
        void opts;
        return {
          on: (event: string, handler: CollectHandler) => {
            if (event === 'collect') collect = handler;
          },
          stop: (reason: string) => {
            stopped = reason;
          },
        };
      },
      edit: (payload: { content: string }) => {
        edits.push(payload.content);
        return Promise.resolve();
      },
    };
    const channel = {
      send: (payload: { content: string; components: typeof armedComponents }) => {
        armedComponents = payload.components;
        return Promise.resolve(message);
      },
    };

    // Deterministic clock: GO lands at t=1000; the sleeps hand control back to the test so
    // clicks can be injected in the armed phase and inside the window.
    const sleepGates: Array<() => void> = [];
    const sleep = () => new Promise<void>((resolve) => sleepGates.push(resolve));
    const click = (teamIndex: number, user: string, at: number) => {
      const customId = armedComponents
        .flatMap((row) => row.components)
        .map((b) => (b.toJSON() as APIButtonComponentWithCustomId).custom_id)
        .find((id) => id.endsWith(`:t${teamIndex}`)) as string;
      collect?.({
        customId,
        user: { id: user, username: user },
        createdTimestamp: at,
        reply: () => Promise.resolve(),
      });
    };
    const flush = async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    };

    const run = runReactionRound(session, channel, io, {
      windowMs: 5000,
      armDelayMs: () => 4000,
      now: () => 1000,
      sleep,
    });
    await flush();
    expect(sleepGates).toHaveLength(1);
    click(3, 'jumpy', 900); // false start while armed

    sleepGates.shift()?.();
    await flush(); // GO stamped at 1000, message edited
    expect(edits[0]).toContain('GO!');
    click(1, 'alice', 1120);
    click(2, 'bob', 1250);

    sleepGates.shift()?.();
    const result = await run;

    expect(stopped).toBe('window-closed');
    expect(edits[1]).toContain('Round over');
    expect(result?.bonusByTeam).toEqual({ t1: 2, t2: 1 });
    expect(posts.map((p) => p.kind)).toEqual(['minigame', 'preview']);
    expect(posts[0].content).toContain('🥇 Team 1 — 120 ms → **+2 balls** — clicked by alice');
    expect(posts[0].content).toContain(
      '🚨 False starts (attempt burned): Team 3 — clicked by jumpy',
    );
    expect(posts[0].content).toContain('😴 Never clicked: Team 4');
  });
});
