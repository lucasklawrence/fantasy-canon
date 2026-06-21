import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handleLineupSubcommand } from '../lineup.js';
import { createMockContext } from '../../../lib/__tests__/mockContext.js';
import { createMockInteraction } from '../../../lib/__tests__/mockInteraction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(__dirname, '../../../lib/__tests__/fixtures', name), 'utf8'),
  );
}

const mMatchup = fixture('mMatchup-2024-wk1.json');
const mSettings = fixture('mSettings-2024.json');
// The two teams in the fixture matchup.
const TEAMS = {
  teams: [
    { id: 10, location: 'Squad', nickname: 'Ten' },
    { id: 13, location: 'Squad', nickname: 'Thirteen' },
  ],
};

describe('handleLineupSubcommand', () => {
  it('replies with the missing-league prompt when no league is configured', async () => {
    const { context } = createMockContext({});
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024 },
      guildId: null,
    });

    await handleLineupSubcommand(interaction, context);

    expect(deferred()).toBe(false);
    expect(lastContent()).toContain('League ID is required');
  });

  it('reports unreadable lineup slots when mSettings has no slot counts', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: TEAMS, mSettings: {} },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024, weeks: 1 },
    });

    await handleLineupSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toContain('Could not read this league’s lineup slots');
  });

  it('reports no boxscore data when the weeks have no matchups', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: TEAMS, mSettings, mMatchup: {} },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024, weeks: 1 },
    });

    await handleLineupSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    expect(lastContent()).toBe('No boxscore data found for season 2024 (weeks 1–1).');
  });

  it('ranks teams by optimal-lineup % on the happy path', async () => {
    const { context } = createMockContext({
      defaultLeagueId: 'L',
      fetchPayloads: { mTeam: TEAMS, mSettings, mMatchup },
    });
    const { interaction, deferred, lastContent } = createMockInteraction({
      options: { season: 2024, weeks: 1 },
    });

    await handleLineupSubcommand(interaction, context);

    expect(deferred()).toBe(true);
    const content = lastContent() ?? '';
    expect(content).toContain('League L • Season 2024 • Optimal-Lineup % (weeks 1–1)');
    // Squad Ten started 95.81 of a possible 106.91 → 89.6%, 11.1 left on the bench.
    expect(content).toContain('1. Squad Ten — 89.6% optimal (11.1 pts left on bench)');
    expect(content).toContain('Squad Thirteen — 83.3% optimal');
  });
});
