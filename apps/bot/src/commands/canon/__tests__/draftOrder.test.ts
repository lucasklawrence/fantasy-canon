import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import {
  createMockInteraction,
  MockInteractionOptions,
  type CapturedReply,
} from '../../../lib/__tests__/mockInteraction.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { FOUR_TEAMS, RICH_TEAMS } from '../../../lib/__tests__/handlerFixtures.js';
import { ballCountForTeam, type DraftOrderState } from '@fantasy-canon/core';
import {
  clearCeremony,
  createCeremony,
  getCeremony,
  markPreviewPosted,
  oddsRows,
  type CeremonySession,
  requestAbort,
  resetCeremoniesForTests,
  type RunCeremonyOptions,
  runCeremony,
  setCeremony,
} from '../../../lib/draftOrderCeremony.js';
import {
  applyBallsOverrides,
  applyBonusOverrides,
  DRAFT_ORDER_LAUNCH_ID,
  handleDraftOrderAbortSubcommand,
  handleDraftOrderBeginSubcommand,
  handleDraftOrderHypeSubcommand,
  handleDraftOrderLaunchButton,
  handleDraftOrderSetupSubcommand,
  handleDraftOrderStatusSubcommand,
  parseManualTeams,
  performActivityBegin,
  performActivityReimport,
  postActivityEditLine,
  recoverInterruptedCeremonies,
} from '../draftOrder.js';
import type { ButtonInteraction } from 'discord.js';
import { createMemoryCeremonyStore, type PersistedCeremony } from '../../../lib/ceremonyStore.js';
import type { StageBeginRequest } from '../../../lib/lotteryStageWatcher.js';
import type {
  InspectableRevealStage,
  StageStateSnapshot,
} from '../../../lib/lotteryStageClient.js';
import type { Client } from 'discord.js';

interface ChannelPost {
  content?: string;
  files?: unknown[];
  allowedMentions?: { parse: string[] };
}

/** Mock interaction with a sendable channel and (by default) commissioner permissions. */
function ceremonyInteraction(opts: MockInteractionOptions & { commissioner?: boolean } = {}): {
  interaction: ChatInputCommandInteraction;
  lastContent: () => string | undefined;
  replies: CapturedReply[];
  channelPosts: ChannelPost[];
} {
  const handle = createMockInteraction(opts);
  const channelPosts: ChannelPost[] = [];
  Object.assign(handle.interaction as object, {
    channel: {
      isSendable: () => true,
      send: (payload: ChannelPost): Promise<{ id: string }> => {
        channelPosts.push(payload);
        return Promise.resolve({ id: `chan-${channelPosts.length}` });
      },
    },
    memberPermissions: (opts.commissioner ?? true) ? { has: () => true } : { has: () => false },
  });
  return {
    interaction: handle.interaction,
    lastContent: handle.lastContent,
    replies: handle.replies,
    channelPosts,
  };
}

/**
 * A stage double that only answers `state()` — `begin`'s single read (#210). Every `begin` test
 * passes one: the handler awaits that read before committing, so without an injected stage the
 * test would reach a real `FANTASY_STAGE_URL` (a dev api on :4610 answers it for real).
 */
function stageHolding(
  snapshot: StageStateSnapshot | Error = { phase: 'idle' },
): InspectableRevealStage {
  return {
    state: () => (snapshot instanceof Error ? Promise.reject(snapshot) : Promise.resolve(snapshot)),
    lobby: () => Promise.resolve(),
    clear: () => Promise.resolve(),
    start: () => Promise.resolve(),
    beat: () => Promise.resolve(),
    reveal: () => Promise.resolve(),
    finish: () => Promise.resolve(),
    abort: () => Promise.resolve(),
  };
}

afterEach(() => resetCeremoniesForTests());

describe('parseManualTeams', () => {
  it('parses names with optional bonus balls', () => {
    expect(parseManualTeams('Sharks, Vipers:2, The A:Team:1')).toEqual([
      { name: 'Sharks', bonusBalls: 0 },
      { name: 'Vipers', bonusBalls: 2 },
      { name: 'The A:Team', bonusBalls: 1 },
    ]);
  });

  it('rejects malformed entries', () => {
    expect(() => parseManualTeams('Sharks:lots')).toThrow('Sharks:lots');
    expect(() => parseManualTeams(':2')).toThrow(':2');
  });

  it('caps bonus balls per team', () => {
    expect(() => parseManualTeams('Sharks:11')).toThrow('capped at 10');
  });
});

describe('applyBonusOverrides', () => {
  it('applies bonus balls by case-insensitive name and rejects unknown teams', () => {
    const teams = [
      { teamId: 't1', name: 'Sharks', bonusBalls: 0 },
      { teamId: 't2', name: 'Ducks', bonusBalls: 0 },
    ];
    applyBonusOverrides(teams, 'sharks:2');
    expect(teams[0].bonusBalls).toBe(2);
    expect(() => applyBonusOverrides(teams, 'Goats:1')).toThrow('No team named "Goats"');
  });
});

describe('applyBallsOverrides', () => {
  it('sets base balls by case-insensitive name — lowering as well as raising', () => {
    const teams = [
      { teamId: 't1', name: 'Sharks', bonusBalls: 0, baseBalls: 8 },
      { teamId: 't2', name: 'Ducks', bonusBalls: 0, baseBalls: 3 },
    ];
    applyBallsOverrides(teams, 'sharks:2, Ducks:5');
    expect(teams[0].baseBalls).toBe(2);
    expect(teams[1].baseBalls).toBe(5);
  });

  it('requires the Name:count form with count >= 1 and rejects unknown teams', () => {
    const teams = [{ teamId: 't1', name: 'Sharks', bonusBalls: 0 }];
    expect(() => applyBallsOverrides(teams, 'Sharks')).toThrow('Name:count');
    expect(() => applyBallsOverrides(teams, 'Sharks:0')).toThrow('Name:count');
    expect(() => applyBallsOverrides(teams, 'Sharks:2.5')).toThrow('Name:count');
    expect(() => applyBallsOverrides(teams, 'Goats:2')).toThrow('No team named "Goats"');
  });

  it('caps base balls per team', () => {
    const teams = [{ teamId: 't1', name: 'Sharks', bonusBalls: 0 }];
    expect(() => applyBallsOverrides(teams, 'Sharks:31')).toThrow('capped at 30');
  });
});

describe('handleDraftOrderSetupSubcommand', () => {
  it('rejects non-commissioners and DMs', async () => {
    const { context } = createMockContext();
    const denied = ceremonyInteraction({ options: { season: 2026 }, commissioner: false });
    await handleDraftOrderSetupSubcommand(denied.interaction, context);
    expect(denied.lastContent()).toContain('commissioner');

    const dm = ceremonyInteraction({ options: { season: 2026 }, guildId: null });
    await handleDraftOrderSetupSubcommand(dm.interaction, context);
    expect(dm.lastContent()).toContain('server channel');
  });

  it('manual teams: posts the public odds preview and freezes a GAME_OPEN session', async () => {
    const { context } = createMockContext();
    const { interaction, lastContent, channelPosts } = ceremonyInteraction({
      options: { season: 2026, teams: 'Sharks, Vipers:2, Ducks, Goats' },
    });

    await handleDraftOrderSetupSubcommand(interaction, context);

    expect(channelPosts).toHaveLength(1);
    expect(channelPosts[0].files).toHaveLength(1);
    const session = getCeremony('guild-1');
    expect(session?.state).toBe('GAME_OPEN');
    expect(session?.config.teams.map((t) => t.bonusBalls ?? 0)).toEqual([0, 2, 0, 0]);
    expect(lastContent()).toContain('begin');
  });

  it('never lets a ceremony post parse mentions — team names are ESPN-controlled text (#222)', async () => {
    const { context } = createMockContext();
    // A team literally named @everyone: the post must carry it as inert text.
    const { interaction, channelPosts } = ceremonyInteraction({
      options: { season: 2026, teams: '@everyone, Vipers, Ducks, Goats' },
    });

    await handleDraftOrderSetupSubcommand(interaction, context);

    expect(channelPosts.length).toBeGreaterThan(0);
    for (const post of channelPosts) {
      expect(post.allowedMentions).toEqual({ parse: [] });
    }
  });

  it('ESPN teams: resolves names from the mTeam snapshot', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'league-1',
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const { interaction, channelPosts } = ceremonyInteraction({ options: { season: 2026 } });

    await handleDraftOrderSetupSubcommand(interaction, context);

    const session = getCeremony('guild-1');
    expect(session?.config.teams).toHaveLength(4);
    expect(session?.names.get('4')).toBe('Delta Ducks');
    expect(channelPosts).toHaveLength(1);
  });

  it('surfaces ESPN failures as an ephemeral setup error, not a crash', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'league-1',
      fetchThrows: ['mTeam'],
    });
    const { interaction, lastContent, channelPosts } = ceremonyInteraction({
      options: { season: 2026 },
    });

    await handleDraftOrderSetupSubcommand(interaction, context);

    expect(channelPosts).toHaveLength(0);
    expect(getCeremony('guild-1')).toBeUndefined();
    expect(lastContent()).toContain('Setup failed');
  });
});

describe('handleDraftOrderBeginSubcommand', () => {
  it('requires a set-up ceremony', async () => {
    const { interaction, lastContent } = ceremonyInteraction({ options: {} });
    await handleDraftOrderBeginSubcommand(interaction, stageHolding());
    expect(lastContent()).toContain('setup');
  });

  it('fires the ceremony: commitment posts to the channel before any reveal', async () => {
    const { context } = createMockContext();
    const setup = ceremonyInteraction({
      options: { season: 2026, teams: 'Sharks, Vipers, Ducks, Goats' },
    });
    await handleDraftOrderSetupSubcommand(setup.interaction, context);

    const begin = ceremonyInteraction({ options: { delay: 5 } });
    await handleDraftOrderBeginSubcommand(begin.interaction, stageHolding());
    const session = getCeremony('guild-1');
    expect(session?.state).toBe('LOTTERY_RUNNING');

    // The commitment must land before the first drum-roll delay elapses; then abort to
    // unwind the detached run (the disclosure post proves the ADR 0006 abort policy).
    await vi.waitFor(
      () => {
        expect(begin.channelPosts.some((p) => p.content?.includes('commitment'))).toBe(true);
      },
      { timeout: 5000 },
    );
    requestAbort(session!);
    await vi.waitFor(
      () => {
        expect(session?.state).toBe('CANCELLED');
      },
      { timeout: 5000 },
    );
    const last = begin.channelPosts[begin.channelPosts.length - 1];
    expect(last.content).toContain('revealed anyway');
  });
});

describe('handleDraftOrderBeginSubcommand — abort race', () => {
  it('an abort completing during the reply await stops begin before any commitment', async () => {
    const { context } = createMockContext();
    const setup = ceremonyInteraction({ options: { season: 2026, teams: 'A, B, C, D' } });
    await handleDraftOrderSetupSubcommand(setup.interaction, context);
    const session = getCeremony('guild-1');

    const begin = ceremonyInteraction({ options: { delay: 5 } });
    const originalReply = begin.interaction.reply.bind(begin.interaction) as (
      payload: unknown,
    ) => Promise<unknown>;
    Object.assign(begin.interaction as object, {
      reply: (payload: unknown) => {
        // Simulate `/canon draftorder abort` landing while begin awaits its ephemeral reply.
        requestAbort(session!);
        clearCeremony('guild-1');
        return originalReply(payload);
      },
    });

    await handleDraftOrderBeginSubcommand(begin.interaction, stageHolding());

    expect(begin.channelPosts).toHaveLength(0);
    expect(session?.state).toBe('GAME_OPEN');
    expect(session?.secretSeed).toBeUndefined();
    expect(begin.lastContent()).toContain('aborted before it could start');
  });
});

describe('status + abort', () => {
  it('status reports the session state ephemerally', async () => {
    const { context } = createMockContext();
    const setup = ceremonyInteraction({ options: { season: 2026, teams: 'A, B' } });
    await handleDraftOrderSetupSubcommand(setup.interaction, context);

    const status = ceremonyInteraction({ options: {} });
    await handleDraftOrderStatusSubcommand(status.interaction);
    expect(status.lastContent()).toContain('GAME_OPEN');
  });

  it('abort before begin cancels publicly without any seed', async () => {
    const { context } = createMockContext();
    const setup = ceremonyInteraction({ options: { season: 2026, teams: 'A, B' } });
    await handleDraftOrderSetupSubcommand(setup.interaction, context);

    const abort = ceremonyInteraction({ options: {} });
    await handleDraftOrderAbortSubcommand(abort.interaction);

    expect(getCeremony('guild-1')).toBeUndefined();
    expect(abort.channelPosts[0]?.content).toContain('before any commitment');
    expect(abort.lastContent()).toContain('cancelled');
  });
});

describe('standings-derived weights (#165)', () => {
  const lastSeasonSnapshot = (payload: unknown) => ({
    leagueId: 'league-1',
    season: 2025,
    view: 'mTeam',
    fetchedAt: new Date(),
    payload,
  });

  it('defaults ESPN setups to last-season standings (worst finish → most balls)', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'league-1',
      snapshots: [lastSeasonSnapshot(RICH_TEAMS)],
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const { interaction, lastContent } = ceremonyInteraction({ options: { season: 2026 } });

    await handleDraftOrderSetupSubcommand(interaction, context);

    const session = getCeremony('guild-1');
    expect(session?.config.teams.map((t) => t.baseBalls)).toEqual([1, 2, 3, 4]);
    expect(lastContent()).toContain('2025 final standings');
  });

  it('weights:equal keeps the flat #164 behavior', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'league-1',
      snapshots: [lastSeasonSnapshot(RICH_TEAMS)],
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const { interaction, lastContent } = ceremonyInteraction({
      options: { season: 2026, weights: 'equal' },
    });

    await handleDraftOrderSetupSubcommand(interaction, context);

    const session = getCeremony('guild-1');
    expect(session?.config.teams.every((t) => t.baseBalls === undefined)).toBe(true);
    expect(lastContent()).not.toContain('standings');
  });

  it('balls sets a team base directly; bonus still adds on top', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'league-1',
      snapshots: [lastSeasonSnapshot(RICH_TEAMS)],
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const { interaction } = ceremonyInteraction({
      options: { season: 2026, balls: 'Alpha Aces:6', bonus: 'Beta Bears:2' },
    });

    await handleDraftOrderSetupSubcommand(interaction, context);

    const teams = getCeremony('guild-1')?.config.teams ?? [];
    expect(teams[0]).toMatchObject({ teamId: '1', baseBalls: 6 });
    expect(teams[1]).toMatchObject({ teamId: '2', baseBalls: 2, bonusBalls: 2 });
  });

  it('a failed standings fetch degrades to equal weights with a note — setup still succeeds', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'league-1',
      // Roster season is a cache hit; the 2025 standings fetch is a miss and throws.
      snapshots: [{ ...lastSeasonSnapshot(RICH_TEAMS), season: 2026 }],
      fetchThrows: ['mTeam'],
    });
    const { interaction, lastContent, channelPosts } = ceremonyInteraction({
      options: { season: 2026 },
    });

    await handleDraftOrderSetupSubcommand(interaction, context);

    const session = getCeremony('guild-1');
    expect(session?.state).toBe('GAME_OPEN');
    expect(session?.config.teams.every((t) => t.baseBalls === undefined)).toBe(true);
    expect(channelPosts).toHaveLength(1);
    expect(lastContent()).toContain('using equal weights');
  });

  it('roster teams missing from last season get mid-pack balls and are flagged', async () => {
    const threeRanked = { teams: (RICH_TEAMS as { teams: unknown[] }).teams.slice(0, 3) };
    const { context } = createMockContext({
      defaultLeagueId: 'league-1',
      snapshots: [lastSeasonSnapshot(threeRanked)],
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const { interaction, lastContent } = ceremonyInteraction({ options: { season: 2026 } });

    await handleDraftOrderSetupSubcommand(interaction, context);

    const teams = getCeremony('guild-1')?.config.teams ?? [];
    expect(teams.map((t) => t.baseBalls)).toEqual([1, 2, 3, 2]);
    expect(lastContent()).toContain('Delta Ducks');
    expect(lastContent()).toContain('mid-pack');
  });
});

describe('hype subcommand (#165)', () => {
  it('requires a frozen bag and commissioner permissions', async () => {
    const none = ceremonyInteraction({ options: {} });
    await handleDraftOrderHypeSubcommand(none.interaction);
    expect(none.lastContent()).toContain('setup');

    const { context } = createMockContext();
    const setup = ceremonyInteraction({ options: { season: 2026, teams: 'A, B' } });
    await handleDraftOrderSetupSubcommand(setup.interaction, context);
    const denied = ceremonyInteraction({ options: {}, commissioner: false });
    await handleDraftOrderHypeSubcommand(denied.interaction);
    expect(denied.lastContent()).toContain('commissioner');
    expect(denied.channelPosts).toHaveLength(0);
  });

  it('posts rotating hype copy with the frozen odds card, appending the note', async () => {
    const { context } = createMockContext();
    const setup = ceremonyInteraction({
      options: { season: 2026, teams: 'Sharks:2, Vipers, Ducks, Goats' },
    });
    await handleDraftOrderSetupSubcommand(setup.interaction, context);

    const first = ceremonyInteraction({ options: { note: 'Draft night is Aug 30.' } });
    await handleDraftOrderHypeSubcommand(first.interaction);
    const second = ceremonyInteraction({ options: {} });
    await handleDraftOrderHypeSubcommand(second.interaction);

    expect(first.channelPosts).toHaveLength(1);
    expect(first.channelPosts[0].files).toHaveLength(1);
    expect(first.channelPosts[0].content).toContain('Draft night is Aug 30.');
    expect(first.channelPosts[0].content).toContain('frozen');
    expect(second.channelPosts).toHaveLength(1);
    expect(second.channelPosts[0].content).not.toBe(first.channelPosts[0].content);
    expect(getCeremony('guild-1')?.state).toBe('GAME_OPEN');
  });

  it('posts nothing when the ceremony changes while the card renders', async () => {
    const { context } = createMockContext();
    const setup = ceremonyInteraction({ options: { season: 2026, teams: 'A, B' } });
    await handleDraftOrderSetupSubcommand(setup.interaction, context);
    const session = getCeremony('guild-1');

    const hype = ceremonyInteraction({ options: {} });
    Object.assign(hype.interaction as object, {
      deferReply: () => {
        // Simulate an abort (or replacing setup) landing while hype awaits its defer/render.
        requestAbort(session!);
        clearCeremony('guild-1');
        return Promise.resolve({});
      },
    });

    await handleDraftOrderHypeSubcommand(hype.interaction);

    expect(hype.channelPosts).toHaveLength(0);
    expect(hype.lastContent()).toContain('nothing was posted');
  });
});

describe('preview ≡ commitment consistency (#165)', () => {
  it('the commitment binds exactly the previewed standings-weighted bag', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'league-1',
      snapshots: [
        {
          leagueId: 'league-1',
          season: 2025,
          view: 'mTeam',
          fetchedAt: new Date(),
          payload: RICH_TEAMS,
        },
      ],
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const setup = ceremonyInteraction({ options: { season: 2026 } });
    await handleDraftOrderSetupSubcommand(setup.interaction, context);
    expect(setup.channelPosts).toHaveLength(1);
    expect(setup.channelPosts[0].files).toHaveLength(1);
    const session = getCeremony('guild-1');
    // What the public preview card renders: `oddsRows` is the odds-card's exact input.
    const previewedRows = oddsRows(session!);
    expect(previewedRows.map((row) => row.balls).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(
      session!.config.teams.map((team) =>
        ballCountForTeam(team, session!.config.baseBallCount ?? 1),
      ),
    ).toEqual([1, 2, 3, 4]);

    const begin = ceremonyInteraction({ options: { delay: 5 } });
    await handleDraftOrderBeginSubcommand(begin.interaction, stageHolding());
    await vi.waitFor(
      () => {
        expect(begin.channelPosts.some((p) => p.content?.includes('commitment'))).toBe(true);
      },
      { timeout: 5000 },
    );

    // The public commitment post lists, per team name, the exact ball counts the preview card
    // rendered — the published odds and the committed bag are the same data.
    const commitment = begin.channelPosts.find((p) => p.content?.includes('commitment'))!.content!;
    for (const row of previewedRows) {
      expect(commitment).toMatch(
        new RegExp(`• ${row.team} \\(\`\\d+\`\\) — ${row.balls} ball\\(s\\)`),
      );
    }

    requestAbort(session!);
    await vi.waitFor(
      () => {
        expect(session?.state).toBe('CANCELLED');
      },
      { timeout: 5000 },
    );
  });

  it('a bag that never had a public preview cannot commit', async () => {
    // Changing the bag means a new session via setup; until its preview posts (CREATED →
    // GAME_OPEN), begin refuses — enforcing "no commit without a fresh public preview".
    const session = createCeremony(
      'guild-1',
      'Backdoor Lottery',
      { teams: [{ teamId: 'a' }, { teamId: 'b' }] },
      new Map([
        ['a', 'A'],
        ['b', 'B'],
      ]),
    );
    setCeremony(session);

    const begin = ceremonyInteraction({ options: {} });
    await handleDraftOrderBeginSubcommand(begin.interaction, stageHolding());

    expect(begin.channelPosts).toHaveLength(0);
    expect(session.state).toBe('CREATED');
    expect(begin.lastContent()).toContain('setup');
  });
});

describe('in-Activity ball edits folded in at begin (#210)', () => {
  function openSession() {
    const session = createCeremony(
      'guild-1',
      '2026 Draft Lottery',
      { teams: [{ teamId: 'a' }, { teamId: 'b' }], baseBallCount: 1 },
      new Map([
        ['a', 'Alpha'],
        ['b', 'Bravo'],
      ]),
    );
    markPreviewPosted(session);
    setCeremony(session);
    return session;
  }

  it('commits the edited bag and re-posts the odds card before the commitment (ADR 0006)', async () => {
    const session = openSession();
    const begin = ceremonyInteraction({ options: { delay: 5 } });

    await handleDraftOrderBeginSubcommand(
      begin.interaction,
      stageHolding({
        phase: 'lobby',
        lobby: { guildId: 'guild-1' },
        adjustments: [{ teamId: 'b', balls: 4 }],
      }),
    );

    // The fresh public preview names the change and lands *before* the commitment, so the channel
    // record never shows a commitment binding a bag nobody published.
    const adjusted = begin.channelPosts.findIndex((p) => p.content?.includes('Bravo'));
    expect(adjusted).toBe(0);
    expect(begin.channelPosts[0].content).toContain('1 → 4 ball(s)');
    expect(begin.channelPosts[0].files).toHaveLength(1);

    // The commitment post is the one listing the frozen bag team by team (the adjusted preview
    // also says the word "commitment", so match on the bag listing instead).
    const bagListing = (): ChannelPost | undefined =>
      begin.channelPosts.find((p) => p.content?.includes('• Alpha ('));
    await vi.waitFor(() => expect(bagListing()).toBeDefined(), { timeout: 5000 });
    // …and it binds the edited counts, not the ones setup froze.
    const commitment = bagListing()!.content!;
    expect(commitment).toMatch(/• Bravo \(`\w+`\) — 4 ball\(s\)/);
    expect(commitment).toMatch(/• Alpha \(`\w+`\) — 1 ball\(s\)/);

    requestAbort(session);
    await vi.waitFor(() => expect(session.state).toBe('CANCELLED'), { timeout: 5000 });
  });

  it('posts nothing extra when the Activity holds no edits', async () => {
    const session = openSession();
    const begin = ceremonyInteraction({ options: { delay: 5 } });

    await handleDraftOrderBeginSubcommand(
      begin.interaction,
      stageHolding({ phase: 'lobby', lobby: { guildId: 'guild-1' } }),
    );

    expect(begin.channelPosts[0].content).toContain('commitment');
    requestAbort(session);
    await vi.waitFor(() => expect(session.state).toBe('CANCELLED'), { timeout: 5000 });
  });

  it('never drains another guild’s lobby into this guild’s bag', async () => {
    const session = openSession();
    const begin = ceremonyInteraction({ options: { delay: 5 } });

    // The stage is one process-wide slot (#191), and team ids collide across guilds trivially —
    // `a`/`b` here, `team-1` for any manual setup. Guild B arming and editing after guild A's
    // setup must not put B's ball counts under A's commitment.
    await handleDraftOrderBeginSubcommand(
      begin.interaction,
      stageHolding({
        phase: 'lobby',
        lobby: { guildId: 'guild-2' },
        adjustments: [{ teamId: 'b', balls: 9 }],
      }),
    );

    expect(begin.channelPosts.some((p) => p.content?.includes('adjusted the hopper'))).toBe(false);
    const bagListing = (): ChannelPost | undefined =>
      begin.channelPosts.find((p) => p.content?.includes('• Alpha ('));
    await vi.waitFor(() => expect(bagListing()).toBeDefined(), { timeout: 5000 });
    expect(bagListing()!.content).toMatch(/• Bravo \(`\w+`\) — 1 ball\(s\)/);

    requestAbort(session);
    await vi.waitFor(() => expect(session.state).toBe('CANCELLED'), { timeout: 5000 });
  });

  it('rolls the bag back when the adjusted preview cannot be posted', async () => {
    const session = openSession();
    const begin = ceremonyInteraction({ options: { delay: 5 } });
    // Fail only the adjusted preview; the commitment and everything after it still post. Without
    // a rollback the ceremony would commit ball counts that were never publicly previewed.
    const channel = begin.interaction.channel as unknown as {
      send: (p: ChannelPost) => Promise<{ id: string }>;
    };
    const realSend = channel.send.bind(channel);
    channel.send = (payload: ChannelPost): Promise<{ id: string }> =>
      payload.content?.includes('adjusted the hopper')
        ? Promise.reject(new Error('channel send failed'))
        : realSend(payload);

    await handleDraftOrderBeginSubcommand(
      begin.interaction,
      stageHolding({
        phase: 'lobby',
        lobby: { guildId: 'guild-1' },
        adjustments: [{ teamId: 'b', balls: 4 }],
      }),
    );

    expect(begin.replies.some((r) => r.content?.includes('pending edits'))).toBe(true);
    const bagListing = (): ChannelPost | undefined =>
      begin.channelPosts.find((p) => p.content?.includes('• Alpha ('));
    await vi.waitFor(() => expect(bagListing()).toBeDefined(), { timeout: 5000 });
    // Back to what `setup` froze and previewed — the warning the commissioner got is accurate.
    expect(bagListing()!.content).toMatch(/• Bravo \(`\w+`\) — 1 ball\(s\)/);

    requestAbort(session);
    await vi.waitFor(() => expect(session.state).toBe('CANCELLED'), { timeout: 5000 });
  });

  it('refuses to commit when a replacing setup lands while the edits are being applied', async () => {
    const session = openSession();
    const begin = ceremonyInteraction({ options: { delay: 5 } });
    // A `setup` for the same guild completing during the drain's awaits has already posted its own
    // public preview; committing this session now would put the *old* bag in the channel after it.
    const racingStage = stageHolding({ phase: 'lobby', lobby: { guildId: 'guild-1' } });
    const raced: InspectableRevealStage = {
      ...racingStage,
      state: async () => {
        const replacement = createCeremony(
          'guild-1',
          'Replacement Lottery',
          { teams: [{ teamId: 'a' }, { teamId: 'b' }], baseBallCount: 1 },
          new Map([
            ['a', 'Alpha'],
            ['b', 'Bravo'],
          ]),
        );
        markPreviewPosted(replacement);
        setCeremony(replacement);
        return racingStage.state();
      },
    };

    await handleDraftOrderBeginSubcommand(begin.interaction, raced);

    expect(begin.replies.some((r) => r.content?.includes('ceremony changed'))).toBe(true);
    expect(begin.channelPosts).toHaveLength(0);
    expect(session.state).toBe('GAME_OPEN');
  });

  it('an unreachable stage still commits, but warns the commissioner about it', async () => {
    const session = openSession();
    const begin = ceremonyInteraction({ options: { delay: 5 } });

    await handleDraftOrderBeginSubcommand(
      begin.interaction,
      stageHolding(new Error('ECONNREFUSED')),
    );

    // The ceremony is never blocked on presentation — but this is the one case where what the
    // commissioner saw and what gets committed can differ, so they're told.
    expect(begin.replies.some((r) => r.content?.includes('pending edits'))).toBe(true);
    expect(begin.channelPosts.some((p) => p.content?.includes('commitment'))).toBe(true);

    requestAbort(session);
    await vi.waitFor(() => expect(session.state).toBe('CANCELLED'), { timeout: 5000 });
  });
});

describe('recoverInterruptedCeremonies (#176)', () => {
  function pendingRecord(over: Partial<PersistedCeremony> = {}): PersistedCeremony {
    return {
      guildId: 'guild-1',
      channelId: 'chan-1',
      title: '2026 Draft Lottery',
      config: { teams: [{ teamId: 'a' }, { teamId: 'b' }], baseBallCount: 1 },
      names: [
        ['a', 'Alpha'],
        ['b', 'Bravo'],
      ],
      secretSeed: 'the-secret',
      commitment: 'the-hash',
      commitMessageId: 'msg-1',
      drawSeed: 'the-secret|msg-1',
      state: 'LOTTERY_RUNNING',
      createdAt: 1,
      ...over,
    };
  }

  function fakeClient(fetch: (id: string) => Promise<unknown>): Client {
    return { channels: { fetch: (id: string) => fetch(id) } } as unknown as Client;
  }

  /** An inspectable stage double for the #205 reconcile pass — records clears and aborts. */
  function fakeStage(snapshot: StageStateSnapshot | Error = { phase: 'idle' }): {
    stage: InspectableRevealStage;
    cleared: { guildId?: string }[];
    aborted: { reason: string; ifCommitment?: string }[];
    stateCalls: () => number;
  } {
    const cleared: { guildId?: string }[] = [];
    const aborted: { reason: string; ifCommitment?: string }[] = [];
    let stateCalls = 0;
    const stage: InspectableRevealStage = {
      state: () => {
        stateCalls += 1;
        return snapshot instanceof Error ? Promise.reject(snapshot) : Promise.resolve(snapshot);
      },
      lobby: () => Promise.resolve(),
      clear: (c) => {
        cleared.push(c);
        return Promise.resolve();
      },
      start: () => Promise.resolve(),
      beat: () => Promise.resolve(),
      reveal: () => Promise.resolve(),
      finish: () => Promise.resolve(),
      abort: (a) => {
        aborted.push(a);
        return Promise.resolve();
      },
    };
    return { stage, cleared, aborted, stateCalls: () => stateCalls };
  }

  it('discloses the seed to the origin channel and clears the record', async () => {
    const store = createMemoryCeremonyStore();
    store.saveCommitted(pendingRecord());
    const sent: { content?: string }[] = [];
    const channel = {
      isSendable: () => true,
      send: (p: { content?: string }) => {
        sent.push(p);
        return Promise.resolve({ id: 'x' });
      },
    };
    const fetched: string[] = [];
    const client = fakeClient((id) => {
      fetched.push(id);
      return Promise.resolve(channel);
    });

    await recoverInterruptedCeremonies(client, store, fakeStage().stage);

    expect(fetched).toEqual(['chan-1']);
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toContain('the-secret');
    expect(sent[0].content).toContain('interrupted');
    expect(store.loadPending()).toEqual([]);
  });

  it('keeps the record when the channel is gone (nothing to disclose to)', async () => {
    const store = createMemoryCeremonyStore();
    store.saveCommitted(pendingRecord());
    const client = fakeClient(() => Promise.resolve(null));

    await recoverInterruptedCeremonies(client, store, fakeStage().stage);

    expect(store.loadPending()).toHaveLength(1);
  });

  it('keeps the record when the disclosure post throws (retry next startup)', async () => {
    const store = createMemoryCeremonyStore();
    store.saveCommitted(pendingRecord());
    const channel = {
      isSendable: () => true,
      send: () => Promise.reject(new Error('rate limited')),
    };
    const client = fakeClient(() => Promise.resolve(channel));

    await recoverInterruptedCeremonies(client, store, fakeStage().stage);

    expect(store.loadPending()).toHaveLength(1);
  });

  it('launch button responds with LAUNCH_ACTIVITY, ephemeral error on failure (#169)', async () => {
    expect(DRAFT_ORDER_LAUNCH_ID).toBe('canon:draftorder:launch');
    const launchActivity = vi.fn().mockResolvedValue({});
    const reply = vi.fn().mockResolvedValue({});
    await handleDraftOrderLaunchButton({
      launchActivity,
      reply,
    } as unknown as ButtonInteraction);
    expect(launchActivity).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();

    const failing = vi.fn().mockRejectedValue(new Error('activities disabled'));
    await handleDraftOrderLaunchButton({
      launchActivity: failing,
      reply,
    } as unknown as ButtonInteraction);
    expect(reply).toHaveBeenCalledOnce();
    const [payload] = reply.mock.calls[0] as [{ content: string }];
    expect(payload.content).toContain('Lottery Machine');
  });

  it('skips a guild that already has a live ceremony in memory', async () => {
    const store = createMemoryCeremonyStore();
    store.saveCommitted(pendingRecord());
    const live = createCeremony('guild-1', 'Live Lottery', { teams: [{ teamId: 'a' }] }, new Map());
    live.state = 'LOTTERY_RUNNING';
    setCeremony(live);
    let sent = 0;
    const client = fakeClient(() =>
      Promise.resolve({
        isSendable: () => true,
        send: () => {
          sent += 1;
          return Promise.resolve({});
        },
      }),
    );

    const stranded = fakeStage({ phase: 'revealing', start: { commitment: 'the-hash' } });
    await recoverInterruptedCeremonies(client, store, stranded.stage);

    expect(sent).toBe(0);
    expect(store.loadPending()).toHaveLength(1);
    // The live in-memory ceremony also blocks the #205 stage reconcile — nothing is inspected
    // or torn down while this process could legitimately be pacing the stage.
    expect(stranded.stateCalls()).toBe(0);
    expect(stranded.aborted).toHaveLength(0);
  });

  it('clears an orphaned lobby at boot, scoped to the guild the snapshot reports (#205)', async () => {
    const { stage, cleared, aborted } = fakeStage({ phase: 'lobby', lobby: { guildId: 'g-lob' } });
    await recoverInterruptedCeremonies(
      fakeClient(() => Promise.resolve(null)),
      createMemoryCeremonyStore(),
      stage,
    );

    expect(cleared).toEqual([{ guildId: 'g-lob' }]);
    expect(aborted).toHaveLength(0);
  });

  it('aborts a stranded reveal whose seed this pass just disclosed, and says so (#205)', async () => {
    const store = createMemoryCeremonyStore();
    store.saveCommitted(pendingRecord()); // commitment 'the-hash'
    const channel = {
      isSendable: () => true,
      send: () => Promise.resolve({ id: 'x' }),
    };
    const { stage, aborted, cleared } = fakeStage({
      phase: 'revealing',
      start: { commitment: 'the-hash', guildId: 'guild-1' },
    });

    await recoverInterruptedCeremonies(
      fakeClient(() => Promise.resolve(channel)),
      store,
      stage,
    );

    expect(cleared).toHaveLength(0);
    expect(aborted).toHaveLength(1);
    expect(aborted[0].reason).toContain('just disclosed');
    // Conditional server-side: only the inspected run may be aborted, never a replacement.
    expect(aborted[0].ifCommitment).toBe('the-hash');
  });

  it('aborts a stranded run with the generic reason when no record matched (#205)', async () => {
    const { stage, aborted } = fakeStage({
      phase: 'waiting',
      start: { commitment: 'unknown-hash' },
    });
    await recoverInterruptedCeremonies(
      fakeClient(() => Promise.resolve(null)),
      createMemoryCeremonyStore(),
      stage,
    );

    expect(aborted).toHaveLength(1);
    expect(aborted[0].reason).toContain('cannot continue');
  });

  it('leaves idle and terminal stage phases untouched (#205)', async () => {
    for (const phase of ['idle', 'finished', 'aborted']) {
      const { stage, cleared, aborted } = fakeStage({ phase });
      await recoverInterruptedCeremonies(
        fakeClient(() => Promise.resolve(null)),
        createMemoryCeremonyStore(),
        stage,
      );
      expect(cleared).toHaveLength(0);
      expect(aborted).toHaveLength(0);
    }
  });

  it('re-checks for a live ceremony after the state fetch — a racing begin wins (#205)', async () => {
    const { stage, aborted, cleared } = fakeStage({
      phase: 'revealing',
      start: { commitment: 'stale-hash' },
    });
    const racing: InspectableRevealStage = {
      ...stage,
      state: () => {
        // A setup lands while the reconciler's GET is in flight — ANY fresh session (here still
        // pre-begin, lobby just armed) must make the stale snapshot lose.
        setCeremony(createCeremony('guild-9', 'Racing', { teams: [{ teamId: 'a' }] }, new Map()));
        return stage.state();
      },
    };

    await recoverInterruptedCeremonies(
      fakeClient(() => Promise.resolve(null)),
      createMemoryCeremonyStore(),
      racing,
    );

    expect(aborted).toHaveLength(0);
    expect(cleared).toHaveLength(0);
  });

  it('survives an unreachable stage at boot — disclosure still completes (#205)', async () => {
    const store = createMemoryCeremonyStore();
    store.saveCommitted(pendingRecord());
    const channel = {
      isSendable: () => true,
      send: () => Promise.resolve({ id: 'x' }),
    };
    const down = fakeStage(new Error('ECONNREFUSED'));

    await expect(
      recoverInterruptedCeremonies(
        fakeClient(() => Promise.resolve(channel)),
        store,
        down.stage,
      ),
    ).resolves.toBeUndefined();
    expect(store.loadPending()).toEqual([]); // the seed still went out
  });
});

describe('postActivityEditLine (#220)', () => {
  function clientWith(
    sent: { content?: string; allowedMentions?: unknown }[],
    sendable = true,
  ): Client {
    return {
      channels: {
        fetch: () =>
          Promise.resolve({
            isSendable: () => sendable,
            send: (p: { content?: string; allowedMentions?: unknown }) => {
              sent.push(p);
              return Promise.resolve({ id: 'm1' });
            },
          }),
      },
    } as unknown as Client;
  }

  function openSession(over: { state?: DraftOrderState; lobbyChannelId?: string } = {}) {
    const session = createCeremony(
      'guild-1',
      '2026 Draft Lottery',
      { teams: [{ teamId: 'a' }, { teamId: 'b' }], baseBallCount: 1 },
      new Map([
        ['a', 'Alpha'],
        ['b', 'Bravo'],
      ]),
    );
    markPreviewPosted(session);
    session.lobbyChannelId = 'lobby-chan';
    Object.assign(session, over);
    setCeremony(session);
    return session;
  }

  it('posts to the channel where that guild’s setup ran', async () => {
    const sent: { content?: string }[] = [];
    openSession();
    await expect(postActivityEditLine(clientWith(sent))('guild-1', '🛠 line')).resolves.toBe(true);
    // Mentions suppressed: team names come from ESPN, so a league could have one called
    // `@everyone` and every edit line would ping the server.
    expect(sent).toEqual([{ content: '🛠 line', allowedMentions: { parse: [] } }]);
  });

  it('drops an edit for a guild this bot is not running a ceremony for', async () => {
    const sent: { content?: string }[] = [];
    openSession();
    // The stage is one process-wide slot (#191) — a lobby belonging to someone else must never
    // make this bot post into a league it isn't running.
    await expect(postActivityEditLine(clientWith(sent))('guild-2', 'x')).resolves.toBe(false);
    await expect(postActivityEditLine(clientWith(sent))(undefined, 'x')).resolves.toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('drops an edit once the bag is sealed, or with no lobby channel captured', async () => {
    const sent: { content?: string }[] = [];
    // Past GAME_OPEN anything arriving is stale, and posting it beside a commitment would mislead.
    openSession({ state: 'LOTTERY_RUNNING' });
    await expect(postActivityEditLine(clientWith(sent))('guild-1', 'x')).resolves.toBe(false);

    resetCeremoniesForTests();
    openSession({ lobbyChannelId: undefined });
    await expect(postActivityEditLine(clientWith(sent))('guild-1', 'x')).resolves.toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('drops an edit when the channel is not sendable', async () => {
    const sent: { content?: string }[] = [];
    openSession();
    await expect(postActivityEditLine(clientWith(sent, false))('guild-1', 'x')).resolves.toBe(
      false,
    );
    expect(sent).toHaveLength(0);
  });
});

describe('performActivityReimport (#219)', () => {
  function reimportClient(sent: { content?: string; files?: unknown[] }[]): Client {
    return {
      channels: {
        fetch: () =>
          Promise.resolve({
            isSendable: () => true,
            send: (p: { content?: string; files?: unknown[] }) => {
              sent.push(p);
              return Promise.resolve({ id: 'm1' });
            },
          }),
      },
    } as unknown as Client;
  }

  /** A session as `setup` leaves it for an ESPN-backed ceremony. */
  function espnSession(over: Partial<CeremonySession> = {}) {
    const session = createCeremony(
      'guild-1',
      '2026 Draft Lottery',
      { teams: [{ teamId: 'a' }, { teamId: 'b' }], baseBallCount: 1 },
      new Map([
        ['a', 'Stale Alpha'],
        ['b', 'Stale Bravo'],
      ]),
    );
    markPreviewPosted(session);
    session.lobbyChannelId = 'lobby-chan';
    session.leagueId = 'league-1';
    session.season = 2026;
    session.commissionerIds = ['commish'];
    Object.assign(session, over);
    setCeremony(session);
    return session;
  }

  it('refetches the roster, resets the bag, and posts a fresh preview', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'league-1',
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const session = espnSession();
    const sent: { content?: string; files?: unknown[] }[] = [];

    await expect(
      performActivityReimport(reimportClient(sent), context, stageHolding())('guild-1'),
    ).resolves.toBe(true);

    // The roster is whatever ESPN just returned, not what setup froze.
    expect(session.config.teams).toHaveLength(4);
    expect(session.names.get('4')).toBe('Delta Ducks');
    expect(session.names.has('a')).toBe(false);
    // A refetched roster invalidates mini-game awards made against the old one.
    expect(session.miniGameBonuses).toBeUndefined();
    // The channel gets a plain announcement plus the re-rendered odds card.
    expect(sent[0].content).toContain('re-imported the league');
    expect(sent[0].content).toContain('earlier in-Activity edits were reset');
    expect(sent[1].files).toHaveLength(1);
  });

  it('refuses a refetched roster that would be invalid, leaving the old one installed', async () => {
    // Two teams sharing a name is something `createCeremony` rejects — installing it straight from
    // ESPN would only fail later, on `begin` or on an unrelated rename's uniqueness check.
    const collidingTeams = {
      teams: [
        { id: 1, location: 'Same', nickname: 'Name' },
        { id: 2, location: 'Same', nickname: 'Name' },
      ],
    };
    const { context } = createMockContext({
      defaultLeagueId: 'league-1',
      fetchPayloads: { mTeam: collidingTeams },
    });
    const session = espnSession();
    const sent: { content?: string }[] = [];

    await expect(
      performActivityReimport(reimportClient(sent), context, stageHolding())('guild-1'),
    ).rejects.toThrow('two teams called');
    // The session still holds what setup froze.
    expect(session.names.get('a')).toBe('Stale Alpha');
    expect(session.config.teams).toHaveLength(2);
  });

  it('goes to ESPN rather than the snapshot the setup already cached', async () => {
    // Every ESPN-backed setup has cached this exact league/season/view, so a cache-first read
    // would hand back the roster the commissioner is asking us to replace — the re-import would
    // silently do nothing, which is the whole feature failing quietly.
    const { context } = createMockContext({
      defaultLeagueId: 'league-1',
      snapshots: [
        {
          leagueId: 'league-1',
          season: 2026,
          view: 'mTeam',
          fetchedAt: new Date(),
          payload: RICH_TEAMS,
        },
      ],
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const session = espnSession();
    const sent: { content?: string }[] = [];

    await expect(
      performActivityReimport(reimportClient(sent), context, stageHolding())('guild-1'),
    ).resolves.toBe(true);
    // FOUR_TEAMS is what the *fetch* returns; RICH_TEAMS is the stale cache.
    expect(session.names.get('4')).toBe('Delta Ducks');
  });

  it('blocks begin while it is publishing, so no commitment precedes the fresh preview', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'league-1',
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const session = espnSession();
    let sawFlagDuringPublish = false;
    const client = {
      channels: {
        fetch: () =>
          Promise.resolve({
            isSendable: () => true,
            send: () => {
              // ADR 0006 requires the fresh preview to precede any commitment for the new bag.
              sawFlagDuringPublish = session.reimportActive === true;
              return Promise.resolve({ id: 'm1' });
            },
          }),
      },
    } as unknown as Client;

    await performActivityReimport(client, context, stageHolding())('guild-1');
    expect(sawFlagDuringPublish).toBe(true);
    // …and it is released once publication finishes, so `begin` is not wedged.
    expect(session.reimportActive).toBe(false);
  });

  it('restores the old roster when the fresh preview cannot be published', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'league-1',
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const session = espnSession();
    const client = {
      channels: {
        fetch: () =>
          Promise.resolve({
            isSendable: () => true,
            send: () => Promise.reject(new Error('channel send failed')),
          }),
      },
    } as unknown as Client;

    await expect(
      performActivityReimport(client, context, stageHolding())('guild-1'),
    ).rejects.toThrow('channel send failed');
    // Keeping the refetched bag would let a later `begin` commit teams the league never saw.
    expect(session.names.get('a')).toBe('Stale Alpha');
    expect(session.config.teams).toHaveLength(2);
    expect(session.reimportActive).toBe(false);
  });

  it('refuses a ceremony with no ESPN league behind it', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'league-1' });
    // A manual `teams:` setup never records a leagueId — there is nothing to refetch.
    espnSession({ leagueId: undefined });
    const sent: { content?: string }[] = [];
    await expect(
      performActivityReimport(reimportClient(sent), context, stageHolding())('guild-1'),
    ).resolves.toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('refuses once the bag is sealed, for another guild, or with no lobby channel', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'league-1' });
    const sent: { content?: string }[] = [];
    const run = performActivityReimport(reimportClient(sent), context, stageHolding());

    espnSession({ state: 'LOTTERY_RUNNING' });
    await expect(run('guild-1')).resolves.toBe(false);
    await expect(run('guild-2')).resolves.toBe(false);
    await expect(run(undefined)).resolves.toBe(false);

    resetCeremoniesForTests();
    espnSession({ lobbyChannelId: undefined });
    await expect(run('guild-1')).resolves.toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe('performActivityBegin (#233)', () => {
  function beginClient(sent: ChannelPost[], sendable = true): Client {
    return {
      channels: {
        fetch: () =>
          Promise.resolve({
            isSendable: () => sendable,
            send: (p: ChannelPost) => {
              sent.push(p);
              return Promise.resolve({ id: `m${sent.length}` });
            },
          }),
      },
    } as unknown as Client;
  }

  /** A session as `setup` leaves it, open for `begin` from either front door. */
  function openSession(over: Partial<CeremonySession> = {}) {
    const session = createCeremony(
      'guild-1',
      '2026 Draft Lottery',
      { teams: [{ teamId: 'a' }, { teamId: 'b' }], baseBallCount: 2 },
      new Map([
        ['a', 'Alpha'],
        ['b', 'Bravo'],
      ]),
    );
    markPreviewPosted(session);
    session.lobbyChannelId = 'lobby-chan';
    session.commissionerIds = ['commish'];
    Object.assign(session, over);
    setCeremony(session);
    return session;
  }

  const REQUEST: StageBeginRequest = {
    delaySeconds: 10,
    direction: 'first-to-last',
    requestedBy: 'commish',
  };

  /** A `runCeremony` stand-in: records its options, never actually draws. */
  function fakeRun(calls: RunCeremonyOptions[]): typeof runCeremony {
    return (_session, _io, options) => {
      calls.push(options);
      return Promise.resolve([]);
    };
  }

  it('runs the slash-begin flow: audit line + launch button in-channel, then the paced reveal', async () => {
    const session = openSession();
    const sent: ChannelPost[] = [];
    const calls: RunCeremonyOptions[] = [];
    const stage = stageHolding();

    await expect(
      performActivityBegin(beginClient(sent), stage, fakeRun(calls))('guild-1', REQUEST),
    ).resolves.toBe(true);

    // The commitment + reveal anchor where `setup` ran — an Activity press has no "this channel".
    expect(session.channelId).toBe('lobby-chan');
    // One post: who sealed (mention renders, never pings — #222), and the launch invite.
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toContain('<@commish> sealed the bag');
    expect(sent[0].content).toContain('~10s');
    expect(sent[0].allowedMentions).toEqual({ parse: [] });
    expect(JSON.stringify(sent[0])).toContain(DRAFT_ORDER_LAUNCH_ID);
    // The ceremony gets the Activity's options — and the stage, since this is activity mode.
    expect(calls).toHaveLength(1);
    expect(calls[0].delayMs).toBe(10_000);
    expect(calls[0].direction).toBe('first-to-last');
    expect(calls[0].stage).toBe(stage);
    // No visual on the request (an older api) ⇒ the machine, never undefined pass-through.
    expect(calls[0].visual).toBe('machine');
  });

  it('passes the race visual through to the ceremony (#235)', async () => {
    openSession();
    const sent: ChannelPost[] = [];
    const calls: RunCeremonyOptions[] = [];

    await expect(
      performActivityBegin(
        beginClient(sent),
        stageHolding(),
        fakeRun(calls),
      )('guild-1', { ...REQUEST, visual: 'race' }),
    ).resolves.toBe(true);
    expect(calls[0].visual).toBe('race');
  });

  it('drains pending Activity edits into the bag before sealing, exactly like slash begin (#210)', async () => {
    const session = openSession();
    const sent: ChannelPost[] = [];
    const calls: RunCeremonyOptions[] = [];
    const stage = stageHolding({
      phase: 'lobby',
      lobby: { guildId: 'guild-1' },
      adjustments: [{ teamId: 'a', balls: 5 }],
    });

    await expect(
      performActivityBegin(beginClient(sent), stage, fakeRun(calls))('guild-1', REQUEST),
    ).resolves.toBe(true);

    // The edit became the authoritative bag before anything could bind it…
    expect(oddsRows(session).find((r) => r.teamId === 'a')?.balls).toBe(5);
    // …and its fresh public odds card posted before the seal line (ADR 0006's ordering).
    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent[sent.length - 1].content).toContain('sealed the bag');
  });

  it('falls back to the default delay when the request carries junk pacing', async () => {
    openSession();
    const sent: ChannelPost[] = [];
    const calls: RunCeremonyOptions[] = [];

    await expect(
      performActivityBegin(
        beginClient(sent),
        stageHolding(),
        fakeRun(calls),
      )('guild-1', {
        delaySeconds: 9999,
        direction: 'worst-to-first',
      }),
    ).resolves.toBe(true);
    expect(calls[0].delayMs).toBe(20_000);
    expect(calls[0].direction).toBe('worst-to-first');
  });

  it('releases the press with a keepAdjustments re-arm when the channel is unusable', async () => {
    const sent: ChannelPost[] = [];
    const calls: RunCeremonyOptions[] = [];
    const rearms: { keepAdjustments?: boolean; guildId?: string }[] = [];
    const stage: InspectableRevealStage = {
      ...stageHolding(),
      lobby: (req) => {
        rearms.push({ keepAdjustments: req.keepAdjustments, guildId: req.guildId });
        return Promise.resolve();
      },
    };

    // Nothing else will ever re-arm this lobby, so a silent false would strand every
    // commissioner's button on "sealing…" — the re-arm clears the request at the source.
    openSession();
    await expect(
      performActivityBegin(beginClient(sent, false), stage, fakeRun(calls))('guild-1', REQUEST),
    ).resolves.toBe(false);
    expect(rearms).toEqual([{ keepAdjustments: true, guildId: 'guild-1' }]);

    resetCeremoniesForTests();
    openSession({ lobbyChannelId: undefined });
    await expect(
      performActivityBegin(beginClient(sent), stage, fakeRun(calls))('guild-1', REQUEST),
    ).resolves.toBe(false);
    expect(rearms).toHaveLength(2);
    expect(sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses to start the ceremony when a replacing setup lands while the seal line posts', async () => {
    const session = openSession();
    const calls: RunCeremonyOptions[] = [];
    const client = {
      channels: {
        fetch: () =>
          Promise.resolve({
            isSendable: () => true,
            send: () => {
              // A concurrent `setup` replaces the registry entry mid-await; the detached old
              // session must not commit after the replacement's fresh preview.
              resetCeremoniesForTests();
              return Promise.resolve({ id: 'm1' });
            },
          }),
      },
    } as unknown as Client;

    await expect(
      performActivityBegin(client, stageHolding(), fakeRun(calls))('guild-1', REQUEST),
    ).resolves.toBe(false);
    expect(calls).toHaveLength(0);
    expect(session.state).toBe('GAME_OPEN');
  });

  it('refuses whenever the slash command would: state, interlocks, channel — and posts nothing', async () => {
    const sent: ChannelPost[] = [];
    const calls: RunCeremonyOptions[] = [];
    const begin = performActivityBegin(beginClient(sent), stageHolding(), fakeRun(calls));

    // No ceremony at all / wrong guild / no guild.
    await expect(begin('guild-1', REQUEST)).resolves.toBe(false);
    openSession({ state: 'LOTTERY_RUNNING' });
    await expect(begin('guild-1', REQUEST)).resolves.toBe(false);
    await expect(begin('guild-2', REQUEST)).resolves.toBe(false);
    await expect(begin(undefined, REQUEST)).resolves.toBe(false);

    // A bag in flux is not sealable — same interlocks as the slash handler.
    resetCeremoniesForTests();
    openSession({ miniGameActive: true });
    await expect(begin('guild-1', REQUEST)).resolves.toBe(false);
    resetCeremoniesForTests();
    openSession({ reimportActive: true });
    await expect(begin('guild-1', REQUEST)).resolves.toBe(false);
    resetCeremoniesForTests();
    openSession({ lobbyChannelId: undefined });
    await expect(begin('guild-1', REQUEST)).resolves.toBe(false);

    // Nowhere to post ⇒ nowhere for the commitment either.
    resetCeremoniesForTests();
    openSession();
    const unsendable = performActivityBegin(
      beginClient(sent, false),
      stageHolding(),
      fakeRun(calls),
    );
    await expect(unsendable('guild-1', REQUEST)).resolves.toBe(false);

    expect(sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
