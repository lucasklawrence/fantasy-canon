/**
 * Shared ESPN-payload fixtures for command-handler tests. Kept minimal — just enough
 * shape for `buildTeamNameMap` (location/nickname) and `extractTeams` (record.overall).
 * Scenario-specific schedules (which scores produce which trophy/luck outcome) stay
 * inline in each test so the intent is visible at the assertion.
 */

/** A standard 4-team league. Records are read by extractTeams (luck); name-only commands ignore them. */
export const FOUR_TEAMS = {
  teams: [
    { id: 1, location: 'Alpha', nickname: 'Aces', record: { overall: { wins: 10, losses: 3 } } },
    { id: 2, location: 'Beta', nickname: 'Bears', record: { overall: { wins: 7, losses: 6 } } },
    { id: 3, location: 'Gamma', nickname: 'Goats', record: { overall: { wins: 5, losses: 8 } } },
    { id: 4, location: 'Delta', nickname: 'Ducks', record: { overall: { wins: 3, losses: 10 } } },
  ],
};
