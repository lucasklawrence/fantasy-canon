import { handleHomeAwaySubcommand } from '../storylines.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';
import { RICH_TEAMS } from '../../../lib/__tests__/handlerFixtures.js';

describe('handleHomeAwaySubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
      guildId: null,
    });

    await handleHomeAwaySubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('renders just the header when no team data is available', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleHomeAwaySubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toBe('League L • Season 2024 • Home/Away');
  });

  it('names the home merchant and road warrior on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: RICH_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleHomeAwaySubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • Home/Away');
    // Beta Bears have the biggest home-over-away edge.
    expect(content).toContain('Home merchant: Beta Bears — home 66.7%, away 42.9%');
    // Gamma Goats win on the road and lose at home.
    expect(content).toContain('Road warrior: Gamma Goats — home 16.7%, away 57.1%');
  });
});
