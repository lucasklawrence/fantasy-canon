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

/**
 * A richer 4-team `mTeam` payload that fills in the fields the storyline/legacy/scout handlers
 * read beyond a bare record: streaks, home/away splits, trade-block statuses, draft-projected
 * vs final rank, transaction counters (for archetypes/FAAB/moves), and `members[]` +
 * `primaryOwner` for manager-name resolution. Designed so each derived "winner" is unambiguous:
 *
 *  - Champion / dominant: **Alpha Aces** (rankFinal 1, 10-3, longest WIN streak 5).
 *  - Most unlucky (legacy: high points, few wins): **Delta Ducks** (most points, 3-10).
 *  - Biggest draft steal (proj 8 → finish 4): **Delta Ducks**; bust (proj 1 → finish 2): Beta Bears.
 *  - Longest losing streak: **Gamma Goats** (LOSS 6); road warrior (best away−home): Gamma Goats.
 *  - Home merchant (best home−away): **Beta Bears**.
 *  - Most on the block: **Alpha Aces** (2); most untouchable: **Beta Bears** (3).
 *  - Archetypes: Alpha = Wire Addict (adds 30), Beta = Minimalist (total moves 10).
 */
export const RICH_TEAMS = {
  members: [
    { id: '{A}', displayName: 'Mike R.' },
    { id: '{B}', displayName: 'Sarah L.' },
    { id: '{C}', displayName: 'Tom W.' },
    { id: '{D}', displayName: 'Lee K.' },
  ],
  teams: [
    {
      id: 1,
      location: 'Alpha',
      nickname: 'Aces',
      primaryOwner: '{A}',
      draftDayProjectedRank: 3,
      rankFinal: 1,
      record: {
        overall: {
          wins: 10,
          losses: 3,
          ties: 0,
          pointsFor: 1500.5,
          pointsAgainst: 1300.2,
          streakType: 'WIN',
          streakLength: 5,
        },
        home: { wins: 6, losses: 1 },
        away: { wins: 4, losses: 2 },
      },
      transactionCounter: {
        acquisitions: 30,
        drops: 25,
        moveToActive: 10,
        moveToIR: 2,
        trades: 1,
        acquisitionBudgetSpent: 90,
      },
      tradeBlock: {
        players: [
          { status: 'ON_THE_BLOCK' },
          { status: 'ON_THE_BLOCK' },
          { status: 'UNTOUCHABLE' },
        ],
      },
    },
    {
      id: 2,
      location: 'Beta',
      nickname: 'Bears',
      primaryOwner: '{B}',
      draftDayProjectedRank: 1,
      rankFinal: 2,
      record: {
        overall: {
          wins: 7,
          losses: 6,
          ties: 0,
          pointsFor: 1400,
          pointsAgainst: 1390,
          streakType: 'LOSS',
          streakLength: 2,
        },
        home: { wins: 4, losses: 2 },
        away: { wins: 3, losses: 4 },
      },
      transactionCounter: {
        acquisitions: 5,
        drops: 4,
        moveToActive: 1,
        moveToIR: 0,
        trades: 0,
        acquisitionBudgetSpent: 40,
      },
      tradeBlock: {
        players: [{ status: 'UNTOUCHABLE' }, { status: 'UNTOUCHABLE' }, { status: 'UNTOUCHABLE' }],
      },
    },
    {
      id: 3,
      location: 'Gamma',
      nickname: 'Goats',
      primaryOwner: '{C}',
      draftDayProjectedRank: 5,
      rankFinal: 3,
      record: {
        overall: {
          wins: 5,
          losses: 8,
          ties: 0,
          pointsFor: 1350,
          pointsAgainst: 1420,
          streakType: 'LOSS',
          streakLength: 6,
        },
        home: { wins: 1, losses: 5 },
        away: { wins: 4, losses: 3 },
      },
      transactionCounter: {
        acquisitions: 40,
        drops: 35,
        moveToActive: 15,
        moveToIR: 3,
        trades: 2,
        acquisitionBudgetSpent: 75,
      },
    },
    {
      id: 4,
      location: 'Delta',
      nickname: 'Ducks',
      primaryOwner: '{D}',
      draftDayProjectedRank: 8,
      rankFinal: 4,
      record: {
        overall: {
          wins: 3,
          losses: 10,
          ties: 0,
          pointsFor: 1600,
          pointsAgainst: 1500,
          streakType: 'WIN',
          streakLength: 1,
        },
        home: { wins: 2, losses: 4 },
        away: { wins: 1, losses: 6 },
      },
      transactionCounter: {
        acquisitions: 12,
        drops: 10,
        moveToActive: 4,
        moveToIR: 1,
        trades: 0,
        acquisitionBudgetSpent: 20,
      },
    },
  ],
};

/** An `mSettings` payload exposing a league name and a FAAB acquisition budget. */
export const SETTINGS_WITH_NAME = {
  settings: {
    name: 'Dynasty Warriors',
    acquisitionSettings: { acquisitionBudget: 200 },
  },
};

/** A minimal `mRoster` payload: team 1 has one starter and one bench player. */
export const ROSTER_TEAM1 = {
  teams: [
    {
      id: 1,
      roster: {
        entries: [
          {
            lineupSlotId: 0,
            playerPoolEntry: { player: { fullName: 'Josh Allen', defaultPositionId: 1 } },
          },
          {
            lineupSlotId: 20,
            playerPoolEntry: { player: { fullName: 'Backup Back', defaultPositionId: 2 } },
          },
        ],
      },
    },
  ],
};
