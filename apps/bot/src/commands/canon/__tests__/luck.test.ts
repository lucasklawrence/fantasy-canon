import { handleLuckSubcommand } from '../storylines.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';
import { FOUR_TEAMS } from '../../../lib/__tests__/handlerFixtures.js';

const SCOREBOARD = {
  schedule: [
    {
      matchupPeriodId: 1,
      home: { teamId: 1, totalPoints: 120 },
      away: { teamId: 2, totalPoints: 100 },
    },
    {
      matchupPeriodId: 1,
      home: { teamId: 3, totalPoints: 90 },
      away: { teamId: 4, totalPoints: 110 },
    },
  ],
};

describe('handleLuckSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
      guildId: null,
    });

    await handleLuckSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('reports no teams when the mTeam payload is empty', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleLuckSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toBe('No teams found.');
  });

  it('renders the luck leaderboard on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: FOUR_TEAMS, mScoreboard: SCOREBOARD },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleLuckSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • Luck');
    expect(content).toContain('Luckiest:');
    expect(content).toContain('Unluckiest:');
    expect(content).toContain('Alpha Aces');
    expect(content).toMatch(/wins vs .*expected/);
  });
});
