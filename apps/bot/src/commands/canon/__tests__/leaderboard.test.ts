import { handleLeaderboardSubcommand } from '../leaderboard.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';
import { FOUR_TEAMS, RICH_TEAMS } from '../../../lib/__tests__/handlerFixtures.js';

describe('handleLeaderboardSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { metric: 'faab', season: 2024 },
      guildId: null,
    });

    await handleLeaderboardSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('rejects an unsupported metric before deferring', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { metric: 'points', season: 2024 },
    });

    await handleLeaderboardSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toBe('Metric "points" is not supported yet.');
  });

  it('reports no FAAB data when neither teams nor transactions carry spend', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { metric: 'faab', season: 2024 },
    });

    await handleLeaderboardSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toBe('No FAAB data found.');
  });

  it('ranks teams by FAAB spend on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: RICH_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { metric: 'faab', season: 2024 },
    });

    await handleLeaderboardSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • Metric: FAAB');
    expect(content).toContain('1. Alpha Aces — $90.00');
    expect(content).toContain('2. Gamma Goats — $75.00');
  });
});
