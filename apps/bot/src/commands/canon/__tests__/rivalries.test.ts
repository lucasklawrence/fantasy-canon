import { handleRivalrySubcommand, handleRivalriesSubcommand } from '../rivalries.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';
import { FOUR_TEAMS } from '../../../lib/__tests__/handlerFixtures.js';

// Alpha (1) sweeps Beta (2) 2-0; Delta (4) sweeps Gamma (3) 2-0.
const SCOREBOARD = {
  schedule: [
    {
      matchupPeriodId: 1,
      home: { teamId: 1, totalPoints: 120 },
      away: { teamId: 2, totalPoints: 100 },
    },
    {
      matchupPeriodId: 2,
      home: { teamId: 2, totalPoints: 90 },
      away: { teamId: 1, totalPoints: 110 },
    },
    {
      matchupPeriodId: 1,
      home: { teamId: 3, totalPoints: 90 },
      away: { teamId: 4, totalPoints: 110 },
    },
    {
      matchupPeriodId: 2,
      home: { teamId: 4, totalPoints: 100 },
      away: { teamId: 3, totalPoints: 95 },
    },
  ],
};

describe('handleRivalrySubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024, teama: 'Alpha Aces', teamb: 'Beta Bears' },
      guildId: null,
    });

    await handleRivalrySubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('reports unresolvable team names', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: FOUR_TEAMS, mScoreboard: SCOREBOARD },
    });
    const { interaction, lastContent } = createMockInteraction({
      options: { season: 2024, teama: 'Alpha Aces', teamb: 'Nobody Here' },
    });

    await handleRivalrySubcommand(interaction, context);

    expect(lastContent()).toContain('Unable to resolve one or both team names');
  });

  it('reports no head-to-head matchups for teams that never met', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: FOUR_TEAMS, mScoreboard: SCOREBOARD },
    });
    const { interaction, lastContent } = createMockInteraction({
      options: { season: 2024, teama: 'Alpha Aces', teamb: 'Gamma Goats' },
    });

    await handleRivalrySubcommand(interaction, context);

    expect(lastContent()).toContain('No head-to-head matchups found for those teams');
  });

  it('summarizes the head-to-head series on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: FOUR_TEAMS, mScoreboard: SCOREBOARD },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024, teama: 'Alpha Aces', teamb: 'Beta Bears' },
    });

    await handleRivalrySubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • Rivalry');
    expect(content).toContain('Alpha Aces vs Beta Bears');
    expect(content).toContain('2-0 | Points 230.00 - 190.00');
    expect(content).toContain('Alpha Aces lead by 2');
  });
});

describe('handleRivalriesSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
      guildId: null,
    });

    await handleRivalriesSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('reports no matchups when the scoreboard is empty', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleRivalriesSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toContain('No head-to-head matchups found');
  });

  it('ranks rivalries by win differential on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: FOUR_TEAMS, mScoreboard: SCOREBOARD },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleRivalriesSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • Rivalries (top 2)');
    expect(content).toContain('Alpha Aces vs Beta Bears — 2-0');
    expect(content).toContain('Delta Ducks +2');
  });

  it('honors the limit option', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: FOUR_TEAMS, mScoreboard: SCOREBOARD },
    });
    const { interaction, lastContent } = createMockInteraction({
      options: { season: 2024, limit: 1 },
    });

    await handleRivalriesSubcommand(interaction, context);

    const content = lastContent() ?? '';
    expect(content).toContain('Rivalries (top 1)');
    const rows = content.split('\n').filter((l) => l.includes(' vs '));
    expect(rows).toHaveLength(1);
  });
});
