import { handleTrophiesSubcommand } from '../trophies.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';

const TEAMS = {
  teams: [
    { id: 1, location: 'Alpha', nickname: 'Aces' },
    { id: 2, location: 'Beta', nickname: 'Bears' },
    { id: 3, location: 'Gamma', nickname: 'Goats' },
    { id: 4, location: 'Delta', nickname: 'Ducks' },
  ],
};

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
      fetchPayloads: { mTeam: TEAMS },
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
      fetchPayloads: { mTeam: TEAMS, mMatchupScore: MATCHUPS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024, week: 1 },
    });

    await handleTrophiesSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • Week 1 Trophies');
    expect(content).toContain('👑 High Score:'); // top scorer this week
    expect(content).toContain('💩 Low Score:');
    expect(content).toContain('Alpha Aces'); // team 1 = high score (130)
  });
});
