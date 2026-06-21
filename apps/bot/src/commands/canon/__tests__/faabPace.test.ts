import { handleFaabPaceSubcommand } from '../faabPace.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';
import { FOUR_TEAMS, SETTINGS_WITH_NAME } from '../../../lib/__tests__/handlerFixtures.js';

// A cached transactions snapshot: Alpha spends $50 (wk1) + $10 (wk2); Beta spends $30 (wk1).
const TX_SNAPSHOT = {
  leagueId: 'L',
  season: 2024,
  view: 'mTransactions2',
  fetchedAt: new Date(0),
  payload: {
    transactions: [
      {
        id: 't1',
        type: 'WAIVER',
        status: 'EXECUTED',
        bidAmount: 50,
        scoringPeriodId: 1,
        teamId: 1,
      },
      {
        id: 't2',
        type: 'WAIVER',
        status: 'EXECUTED',
        bidAmount: 10,
        scoringPeriodId: 2,
        teamId: 1,
      },
      {
        id: 't3',
        type: 'WAIVER',
        status: 'EXECUTED',
        bidAmount: 30,
        scoringPeriodId: 1,
        teamId: 2,
      },
    ],
  },
};

describe('handleFaabPaceSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
      guildId: null,
    });

    await handleFaabPaceSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('reports no FAAB spend data when there are no waiver transactions', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: FOUR_TEAMS, mSettings: SETTINGS_WITH_NAME },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleFaabPaceSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toBe('No FAAB spend data found.');
  });

  it('ranks teams by spend with pacing on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      snapshots: [TX_SNAPSHOT],
      fetchPayloads: { mTeam: FOUR_TEAMS, mSettings: SETTINGS_WITH_NAME },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleFaabPaceSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    // Budget (200) comes from mSettings; league name too.
    expect(content).toContain('League Dynasty Warriors • Season 2024 • FAAB pace (spent)');
    expect(content).toContain('1. Alpha Aces — $60.00 spent (left $140.00)');
    expect(content).toContain('pace: front-loaded');
    expect(content).toContain('weeks tracked: 2');
    expect(content).toContain('2. Beta Bears — $30.00 spent (left $170.00)');
  });

  it('switches the headline figure in left mode', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      snapshots: [TX_SNAPSHOT],
      fetchPayloads: { mTeam: FOUR_TEAMS, mSettings: SETTINGS_WITH_NAME },
    });
    const { interaction, lastContent } = createMockInteraction({
      options: { season: 2024, mode: 'left' },
    });

    await handleFaabPaceSubcommand(interaction, context);

    const content = lastContent() ?? '';
    expect(content).toContain('FAAB pace (left)');
    expect(content).toContain('1. Alpha Aces — $140.00 left (spent $60.00)');
  });
});
