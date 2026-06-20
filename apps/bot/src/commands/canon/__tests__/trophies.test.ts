import { handleTrophiesSubcommand } from '../trophies.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';
import { FOUR_TEAMS } from '../../../lib/__tests__/handlerFixtures.js';

// Week 1: a blowout (1 over 2 by 40) and a nail-biter (3 over 4 by 2).
const MATCHUPS = {
  schedule: [
    {
      matchupPeriodId: 1,
      home: { teamId: 1, totalPoints: 130 },
      away: { teamId: 2, totalPoints: 90 },
    },
    {
      matchupPeriodId: 1,
      home: { teamId: 3, totalPoints: 110 },
      away: { teamId: 4, totalPoints: 108 },
    },
  ],
};

describe('handleTrophiesSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024, week: 1 },
      guildId: null,
    });

    await handleTrophiesSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('reports no matchups when the week has none', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024, week: 1 },
    });

    await handleTrophiesSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toBe('No matchups found for week 1 of 2024.');
  });

  it('renders the weekly trophies on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      // mSettings defaults to {} → no starter slots → trophy extras stay empty, so only the
      // six score-based trophies render (no boxscore fixture needed).
      fetchPayloads: { mTeam: FOUR_TEAMS, mMatchupScore: MATCHUPS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024, week: 1 },
    });

    await handleTrophiesSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • Week 1 Trophies');
    // Assert the correct team earns each award, not just that the category rendered:
    expect(content).toContain('👑 High Score: Alpha Aces'); // team 1 scored 130, the week high
    expect(content).toContain('💩 Low Score: Beta Bears'); // team 2 scored 90, the week low
  });
});
