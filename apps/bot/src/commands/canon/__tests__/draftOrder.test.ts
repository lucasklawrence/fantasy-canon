import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatInputCommandInteraction } from 'discord.js';
import {
  createMockInteraction,
  MockInteractionOptions,
} from '../../../lib/__tests__/mockInteraction.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { FOUR_TEAMS } from '../../../lib/__tests__/handlerFixtures.js';
import {
  clearCeremony,
  getCeremony,
  requestAbort,
  resetCeremoniesForTests,
} from '../../../lib/draftOrderCeremony.js';
import {
  applyBonusOverrides,
  handleDraftOrderAbortSubcommand,
  handleDraftOrderBeginSubcommand,
  handleDraftOrderSetupSubcommand,
  handleDraftOrderStatusSubcommand,
  parseManualTeams,
} from '../draftOrder.js';

interface ChannelPost {
  content?: string;
  files?: unknown[];
}

/** Mock interaction with a sendable channel and (by default) commissioner permissions. */
function ceremonyInteraction(opts: MockInteractionOptions & { commissioner?: boolean } = {}): {
  interaction: ChatInputCommandInteraction;
  lastContent: () => string | undefined;
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
  return { interaction: handle.interaction, lastContent: handle.lastContent, channelPosts };
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
    await handleDraftOrderBeginSubcommand(interaction);
    expect(lastContent()).toContain('setup');
  });

  it('fires the ceremony: commitment posts to the channel before any reveal', async () => {
    const { context } = createMockContext();
    const setup = ceremonyInteraction({
      options: { season: 2026, teams: 'Sharks, Vipers, Ducks, Goats' },
    });
    await handleDraftOrderSetupSubcommand(setup.interaction, context);

    const begin = ceremonyInteraction({ options: { delay: 5 } });
    await handleDraftOrderBeginSubcommand(begin.interaction);
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

    await handleDraftOrderBeginSubcommand(begin.interaction);

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
