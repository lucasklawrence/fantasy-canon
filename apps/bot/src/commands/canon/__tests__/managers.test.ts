import { handleManagersSubcommand } from '../managers.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';
import { RICH_TEAMS } from '../../../lib/__tests__/handlerFixtures.js';

describe('handleManagersSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { seasons: '2024' },
      guildId: null,
    });

    await handleManagersSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('rejects an unparseable seasons argument', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { seasons: 'nope' },
    });

    await handleManagersSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('Provide seasons as comma list or range');
  });

  it('reports no data when the requested seasons have no teams', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { seasons: '2024' },
    });

    await handleManagersSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toBe('No team data found for the requested seasons.');
  });

  it('aggregates manager rollups sorted by wins on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: RICH_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { seasons: '2024' },
    });

    await handleManagersSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L | Seasons 2024 | Manager rollup (wins)');
    expect(content).toContain('1. Mike R. (Alpha Aces) [{A}] - 10-3 (win% 0.769)');
    expect(content).toContain('PF 1501');
    expect(content).toContain('seasons: 2024');
  });
});
