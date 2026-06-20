import { handleAllPlaySubcommand } from '../allPlay.js';
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
    {
      matchupPeriodId: 2,
      home: { teamId: 1, totalPoints: 115 },
      away: { teamId: 3, totalPoints: 95 },
    },
    {
      matchupPeriodId: 2,
      home: { teamId: 2, totalPoints: 105 },
      away: { teamId: 4, totalPoints: 99 },
    },
  ],
};

describe('handleAllPlaySubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
      guildId: null,
    });

    await handleAllPlaySubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('reports no weekly scores when the scoreboard is empty', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleAllPlaySubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toContain('No weekly scores found');
  });

  it('renders the all-play leaderboard on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: TEAMS, mScoreboard: SCOREBOARD },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleAllPlaySubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • All-Play (Wins vs. All %)');
    expect(content).toContain('Alpha Aces');
    expect(content).toMatch(/% vs all/);
  });

  it('honors the limit option', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: TEAMS, mScoreboard: SCOREBOARD },
    });
    const { interaction, lastContent } = createMockInteraction({
      options: { season: 2024, limit: 2 },
    });

    await handleAllPlaySubcommand(interaction, context);

    const rows = (lastContent() ?? '').split('\n').filter((l) => /^\d+\./.test(l));
    expect(rows).toHaveLength(2);
  });
});
