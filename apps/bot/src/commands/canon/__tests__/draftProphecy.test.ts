import { handleDraftProphecySubcommand } from '../storylines.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';
import { RICH_TEAMS, FOUR_TEAMS } from '../../../lib/__tests__/handlerFixtures.js';

describe('handleDraftProphecySubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
      guildId: null,
    });

    await handleDraftProphecySubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('reports no teams when the mTeam payload is empty', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleDraftProphecySubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toBe('No teams found.');
  });

  it('reports missing projection data when teams have no draft rank', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: FOUR_TEAMS },
    });
    const { interaction, lastContent } = createMockInteraction({ options: { season: 2024 } });

    await handleDraftProphecySubcommand(interaction, context);

    expect(lastContent()).toBe('Draft projection data not available.');
  });

  it('ranks steals and busts by proj-vs-finish delta on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: RICH_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleDraftProphecySubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • Draft Prophecy');
    expect(content).toContain('Steals (beat the prophecy):');
    // Delta Ducks: drafted 8th, finished 4th → biggest steal (Δ4).
    expect(content).toContain('1. Delta Ducks — Δ4.0 (proj 8, finish 4)');
    expect(content).toContain('Busts (fell short):');
    // Beta Bears: drafted 1st, finished 2nd → a bust (Δ-1).
    expect(content).toContain('Beta Bears — Δ-1.0 (proj 1, finish 2)');
  });
});
