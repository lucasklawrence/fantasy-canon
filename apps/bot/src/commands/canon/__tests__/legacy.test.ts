import { handleLegacySubcommand, handleLegacyHistorySubcommand } from '../legacy.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';
import { RICH_TEAMS } from '../../../lib/__tests__/handlerFixtures.js';

describe('handleLegacySubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
      guildId: null,
    });

    await handleLegacySubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('reports no teams when the mTeam payload is empty', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleLegacySubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toBe('No teams found.');
  });

  it('computes single-season luck/dominance/archetype awards on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: RICH_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleLegacySubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • Legacy awards');
    // Delta Ducks: most points, fewest wins → unluckiest.
    expect(content).toContain('Most unlucky: Delta Ducks (luck -3.00)');
    expect(content).toContain('Most dominant: Alpha Aces (10-3, win% 0.769)');
    expect(content).toContain('Archetype: Wire/Activity leaders');
    expect(content).toContain('1. Gamma Goats — adds 40, total moves 95');
  });
});

describe('handleLegacyHistorySubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { seasons: '2024' },
      guildId: null,
    });

    await handleLegacyHistorySubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('rejects an unparseable seasons argument', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { seasons: 'nope' },
    });

    await handleLegacyHistorySubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('Provide seasons as comma list or range');
  });

  it('aggregates awards across the requested seasons on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: RICH_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { seasons: '2024' },
    });

    await handleLegacyHistorySubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Legacy (multi-season, aggregated)');
    expect(content).toContain('Seasons: 2024');
    expect(content).toContain('Most unlucky (aggregated): Delta Ducks (luck -3.00)');
    expect(content).toContain('Most dominant (aggregated): Alpha Aces (10-3, win% 0.769)');
  });
});
