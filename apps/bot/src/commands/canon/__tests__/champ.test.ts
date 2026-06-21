import { handleChampSubcommand, handleChampsSubcommand } from '../storylines.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';
import { RICH_TEAMS } from '../../../lib/__tests__/handlerFixtures.js';

describe('handleChampSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context, canonEventsRepo } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
      guildId: null,
    });

    await handleChampSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
    expect(await canonEventsRepo.list({ leagueId: 'L' })).toHaveLength(0);
  });

  it('reports no teams when the mTeam payload is empty', async () => {
    const { context, canonEventsRepo } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleChampSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toBe('No teams found.');
    // No champion → nothing recorded to the canon timeline.
    expect(await canonEventsRepo.list({ leagueId: 'L' })).toHaveLength(0);
  });

  it('announces the champion and records a canon event on the happy path', async () => {
    const { context, canonEventsRepo } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: RICH_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
    });

    await handleChampSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('Alpha Aces is the champion of 2024.');
    expect(content).toContain('Record 10-3');
    expect(content).toContain('points 1500.5');
    expect(content).toContain('draft proj 3');
    expect(content).toContain('FAAB spent $90');

    const events = await canonEventsRepo.list({ leagueId: 'L' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      season: 2024,
      type: 'champion',
      message: 'Alpha Aces won 2024 (10-3)',
    });
  });
});

describe('handleChampsSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { seasons: '2024' },
      guildId: null,
    });

    await handleChampsSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('rejects an unparseable seasons argument', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { seasons: 'not-a-year' },
    });

    await handleChampsSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('Provide seasons as comma list or range');
  });

  it('lists the champion for each requested season on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: RICH_TEAMS },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { seasons: '2024' },
    });

    await handleChampsSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Champs');
    expect(content).toContain('2024: Alpha Aces (10-3)');
  });
});
