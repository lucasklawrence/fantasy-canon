# Command Implementation Roadmap (Actionable)

Near-term slash commands to ship next, with scope, dependencies, and acceptance criteria.

## 1) /canon config

- **Purpose:** store guild-specific league/channel/timezone defaults.
- **Subcommands:** `set leagueId:<id> startSeason:<yyyy> endSeason:<yyyy>`, `set channel:<#channel> tz:<IANA>`, `show`.
- **Data:** writes to `leagueConfigRepo` (in-memory now; later DB).
- **Implementation steps:**
  1. Add options + handler that upserts into `leagueConfigRepo`.
  2. Ensure `/canon status` reads from repo if present; fallback to env.
  3. Validate season range (start <= end) and channel belongs to guild.
- **Acceptance:** running `config set` stores values and `config show` echoes them.

## 2) /canon ingest

- **Purpose:** fetch and store ESPN snapshots for a season/view set.
- **Options:** `season:<yyyy|all>`, `views:<default|all|custom>`, `leagueId` override.
- **Data:** uses `espnClient`; writes snapshot to `snapshotsRepo`.
- **Implementation steps:**
  1. Add command + handler to resolve leagueId/season list from config/env.
  2. Loop views (default: `mTeam`, `mRoster`, `mTransactions`, `mDraftDetail`), call `fetchLeague`, save via `snapshotsRepo`.
  3. Reply with per-view status (ok/failed) + payload size.
- **Acceptance:** ingest returns success summary and snapshots retrievable via repo.

## 3) /canon teams

- **Purpose:** list team names/abbrevs/pointsFor for a season.
- **Options:** `season:<yyyy>`, optional `leagueId`.
- **Data:** uses `mTeam` snapshot; can fetch if missing; parse teams array.
- **Implementation steps:**
  1. Add command + handler; resolve leagueId.
  2. Try to read existing snapshot for season/view; otherwise fetch and store.
  3. Build reply with team name/abbrev and pointsFor (or placeholder if absent).
- **Acceptance:** returns 12 teams with names/pointsFor for given season.

## 4) /canon leaderboard

- **Purpose:** surface first storyline metric (FAAB spend).
- **Options:** `metric:<faab>`, `season:<yyyy>`, optional `limit`.
- **Data:** from `mTeam.transactionCounter.acquisitionBudgetSpent`.
- **Implementation steps:**
  1. Ensure `mTeam` snapshot exists; fetch if missing.
  2. Parse transactionCounter for each team; build leaderboard via `buildFaabLeaderboard`.
  3. Reply text-first; later pipe to renderer card.
- **Acceptance:** responds with ordered list of teams and FAAB spent for season.

## 5) /canon inspect (enhance)

- **Purpose:** debug fetch per view.
- **Add-ons:** allow `views:default` (fetch all default views) and base-url fallback when view fetch 401s; include body snippet on failure.

## 6) Scheduled job placeholder

- **Purpose:** weekly throwback skeleton.
- **Implementation steps:** add job registry + `node-cron` stub that logs; wire `/canon config set channel/tz` as prerequisites.
- **Acceptance:** job logs scheduled trigger and respects configured channel (even if no post yet).

## Shared dependencies/tasks

- Add tiny helper to resolve guild config vs env defaults for leagueId/season range.
- Add snapshot cache read-before-fetch in commands to reduce requests.
- Add unit tests for each handler’s pure functions (config validation, FAAB parsing).
