import { handleTransactionsSubcommand } from '../transactions.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';
import { FOUR_TEAMS } from '../../../lib/__tests__/handlerFixtures.js';

// 2024-09-15T00:00:00Z in epoch ms (kept literal so the fixture has no Date dependency).
const SEP_15_2024 = Date.UTC(2024, 8, 15);

function txSnapshot(transactions: unknown[]) {
  return {
    leagueId: 'L',
    season: 2024,
    view: 'mTransactions2',
    fetchedAt: new Date(0),
    payload: { transactions },
  };
}

describe('handleTransactionsSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
      guildId: null,
    });

    await handleTransactionsSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('reports when the transactions payload is unavailable', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleTransactionsSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toContain('Transactions payload not available');
  });

  it('reports no transactions when the payload has an empty list', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      snapshots: [txSnapshot([])],
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const { interaction, lastContent } = createMockInteraction({ options: { season: 2024 } });

    await handleTransactionsSubcommand(interaction, context);

    expect(lastContent()).toBe('No transactions found.');
  });

  it('lists the latest transactions on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      snapshots: [
        txSnapshot([
          {
            id: 'x1',
            type: 'WAIVER',
            status: 'EXECUTED',
            teamId: 1,
            bidAmount: 50,
            scoringPeriodId: 3,
            executionDate: SEP_15_2024,
          },
        ]),
      ],
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleTransactionsSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • Latest 1');
    expect(content).toContain('2024-09-15 • Alpha Aces • WAIVER • Week 3 • $50');
  });
});
