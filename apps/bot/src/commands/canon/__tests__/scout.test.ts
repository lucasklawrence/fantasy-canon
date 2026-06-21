import { handleScoutSubcommand, handleScoutAutocomplete } from '../scout.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import {
  createMockInteraction,
  createMockAutocomplete,
} from '../../../lib/__tests__/mockInteraction.js';
import { RICH_TEAMS, ROSTER_TEAM1 } from '../../../lib/__tests__/handlerFixtures.js';
import { buildChoiceLabel, TeamChoice } from '../../../lib/teamNameCache.js';

function choice(teamId: number, teamName: string, managerName?: string): TeamChoice {
  return { teamId, teamName, managerName, label: buildChoiceLabel(teamName, managerName) };
}

describe('handleScoutSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024, opponent: 'Alpha Aces' },
      guildId: null,
    });

    await handleScoutSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('reports no teams when the mTeam payload is empty', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024, opponent: 'Alpha Aces' },
    });

    await handleScoutSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toBe('No teams found for that league and season.');
  });

  it('reports an unresolvable opponent', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: RICH_TEAMS },
    });
    const { interaction, lastContent } = createMockInteraction({
      options: { season: 2024, opponent: 'Zzz Nobody' },
    });

    await handleScoutSubcommand(interaction, context);

    expect(lastContent()).toContain('Unable to resolve opponent "Zzz Nobody"');
  });

  it('renders the scouting report on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: RICH_TEAMS, mRoster: ROSTER_TEAM1 },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024, opponent: 'Alpha Aces' },
    });

    await handleScoutSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • Scout');
    expect(content).toContain('Alpha Aces (Mike R.)');
    expect(content).toContain('Record: 10-3');
    expect(content).toContain('Streak: W5');
    expect(content).toContain('Trade block: 2 on the block, 1 untouchable');
    expect(content).toContain('Starters: QB Josh Allen');
  });

  it('resolves the opponent by manager name', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: RICH_TEAMS, mRoster: ROSTER_TEAM1 },
    });
    const { interaction, lastContent } = createMockInteraction({
      options: { season: 2024, opponent: 'Mike R.' },
    });

    await handleScoutSubcommand(interaction, context);

    expect(lastContent()).toContain('Alpha Aces (Mike R.)');
  });
});

describe('handleScoutAutocomplete', () => {
  it('suggests cached opponents matching the typed value', async () => {
    const { context, teamNameCache } = createMockContext({ defaultLeagueId: 'L' });
    teamNameCache.set('L', 2024, [
      choice(1, 'Alpha Aces', 'Mike R.'),
      choice(2, 'Beta Bears', 'Sarah L.'),
    ]);
    const { interaction, lastChoices } = createMockAutocomplete({
      focused: { name: 'opponent', value: 'alph' },
      options: { season: 2024 },
    });

    await handleScoutAutocomplete(interaction, context);

    expect(lastChoices()).toEqual([{ name: 'Alpha Aces (Mike R.)', value: '1' }]);
  });

  it('responds with no choices when no league resolves', async () => {
    const { context } = createMockContext({});
    const { interaction, lastChoices } = createMockAutocomplete({
      focused: { name: 'opponent', value: 'a' },
      options: { season: 2024 },
    });

    await handleScoutAutocomplete(interaction, context);

    expect(lastChoices()).toEqual([]);
  });

  it('responds with no choices on a cold cache', async () => {
    const { context } = createMockContext({ defaultLeagueId: 'L' });
    const { interaction, lastChoices } = createMockAutocomplete({
      focused: { name: 'opponent', value: 'a' },
      options: { season: 2024 },
    });

    await handleScoutAutocomplete(interaction, context);

    expect(lastChoices()).toEqual([]);
  });

  it('responds with no choices for a non-opponent focused field', async () => {
    const { context, teamNameCache } = createMockContext({ defaultLeagueId: 'L' });
    teamNameCache.set('L', 2024, [choice(1, 'Alpha Aces', 'Mike R.')]);
    const { interaction, lastChoices } = createMockAutocomplete({
      focused: { name: 'season', value: '2024' },
    });

    await handleScoutAutocomplete(interaction, context);

    expect(lastChoices()).toEqual([]);
  });
});
