import { handleBidsSubcommand } from '../bids.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';
import { FOUR_TEAMS, SETTINGS_WITH_NAME } from '../../../lib/__tests__/handlerFixtures.js';

// Player 101 draws two near-equal bids ($50 vs $48 → spread 2); player 102 draws a lopsided
// pair ($30 vs $10 → ratio 3).
const TX_SNAPSHOT = {
  leagueId: 'L',
  season: 2024,
  view: 'mTransactions2',
  fetchedAt: new Date(0),
  payload: {
    transactions: [
      {
        id: 'b1',
        type: 'WAIVER',
        status: 'EXECUTED',
        bidAmount: 50,
        teamId: 1,
        items: [{ playerId: 101 }],
      },
      {
        id: 'b2',
        type: 'WAIVER',
        status: 'EXECUTED',
        bidAmount: 48,
        teamId: 2,
        items: [{ playerId: 101 }],
      },
      {
        id: 'b3',
        type: 'WAIVER',
        status: 'EXECUTED',
        bidAmount: 30,
        teamId: 1,
        items: [{ playerId: 102 }],
      },
      {
        id: 'b4',
        type: 'WAIVER',
        status: 'EXECUTED',
        bidAmount: 10,
        teamId: 3,
        items: [{ playerId: 102 }],
      },
    ],
  },
};

const ROSTER = {
  teams: [
    {
      id: 1,
      roster: {
        entries: [
          { playerPoolEntry: { player: { id: 101, fullName: 'Star WR' } } },
          { playerPoolEntry: { player: { id: 102, fullName: 'Sleeper RB' } } },
        ],
      },
    },
  ],
};

describe('handleBidsSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
      guildId: null,
    });

    await handleBidsSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('reports when the transactions payload is unavailable', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: FOUR_TEAMS, mRoster: ROSTER, mSettings: SETTINGS_WITH_NAME },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleBidsSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toContain('Transactions payload not available');
  });

  it('finds close bids on the same player (default mode)', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      snapshots: [TX_SNAPSHOT],
      fetchPayloads: { mTeam: FOUR_TEAMS, mRoster: ROSTER, mSettings: SETTINGS_WITH_NAME },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleBidsSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League Dynasty Warriors • Season 2024 • close bids');
    expect(content).toContain('Star WR — spread $2.00 — Alpha Aces: $50 | Beta Bears: $48');
  });

  it('finds lopsided bids in lopsided mode', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      snapshots: [TX_SNAPSHOT],
      fetchPayloads: { mTeam: FOUR_TEAMS, mRoster: ROSTER, mSettings: SETTINGS_WITH_NAME },
    });
    const { interaction, lastContent } = createMockInteraction({
      options: { season: 2024, mode: 'lopsided' },
    });

    await handleBidsSubcommand(interaction, context);

    const content = lastContent() ?? '';
    expect(content).toContain('lopsided bids');
    expect(content).toContain(
      'Sleeper RB — spread $20.00 (x3.00) — Alpha Aces: $30 | Gamma Goats: $10',
    );
  });
});
