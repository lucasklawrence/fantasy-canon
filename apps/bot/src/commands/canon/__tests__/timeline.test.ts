import { handleTimelineSubcommand } from '../timeline.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';

describe('handleTimelineSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { seasons: '2024' },
      guildId: null,
    });

    await handleTimelineSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('reports an empty timeline when no canon events exist', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { seasons: '2024' },
    });

    await handleTimelineSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toBe('No canon events found. Run champ/luck commands to seed history.');
  });

  it('lists seeded canon events on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      canonEvents: [
        {
          leagueId: 'L',
          season: 2024,
          type: 'champion',
          message: 'Alpha Aces won 2024 (10-3)',
          createdAt: new Date(Date.UTC(2024, 8, 15)),
        },
      ],
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { seasons: '2024' },
    });

    await handleTimelineSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Timeline');
    expect(content).toContain('2024-09-15 • 2024 • champion • Alpha Aces won 2024 (10-3)');
  });
});
