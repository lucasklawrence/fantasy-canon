import { handleManagerArchetypesSubcommand } from '../storylines.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';
import { RICH_TEAMS } from '../../../lib/__tests__/handlerFixtures.js';

describe('handleManagerArchetypesSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
      guildId: null,
    });

    await handleManagerArchetypesSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('renders just the header when no team data is available', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleManagerArchetypesSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toBe('League L • Season 2024 • Manager archetypes');
  });

  it('classifies each team by transaction tendency on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: RICH_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleManagerArchetypesSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • Manager archetypes');
    expect(content).toContain('Alpha Aces — Wire Addict (adds 30)');
    expect(content).toContain('Beta Bears — Minimalist (total moves 10)');
  });
});
