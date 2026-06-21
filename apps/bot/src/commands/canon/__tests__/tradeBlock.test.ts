import { handleTradeBlockSubcommand } from '../storylines.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';
import { RICH_TEAMS } from '../../../lib/__tests__/handlerFixtures.js';

describe('handleTradeBlockSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
      guildId: null,
    });

    await handleTradeBlockSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('renders zero-count sections when no team data is available', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleTradeBlockSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • Trade block');
    expect(content).toContain('Most on the block:');
    expect(content).toContain('Most untouchables:');
  });

  it('ranks teams by on-the-block and untouchable counts on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: RICH_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleTradeBlockSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('Most on the block:');
    expect(content).toContain('1. Alpha Aces — 2 listed on the block');
    expect(content).toContain('Most untouchables:');
    expect(content).toContain('1. Beta Bears — 3 untouchable');
  });
});
