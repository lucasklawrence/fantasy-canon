# Implementation Plan (Step-by-step)

This is written to unblock you **today** for scaffolding.

## Phase 0 — Project bootstrap (1–2 hours)
1. Create repo: `fantasy-canon`
2. Setup monorepo:
   - PNPM workspace
   - TypeScript base config
   - ESLint + Prettier
3. Add environment wiring:
   - `.env.example`
   - `DISCORD_TOKEN`, `DISCORD_APP_ID`
   - `DATABASE_URL`
   - `ESPN_LEAGUE_ID` (optional default)

## Phase 1 — Bot “hello world” + slash commands (half day)
1. `apps/bot`: discord.js client login
2. `deploy-commands.ts`: registers `/canon status`
3. Implement `/canon status`:
   - respond with bot version + configured league/seasons (if present)
4. Add minimal config persistence:
   - start with DB table `league_config` keyed by `guild_id`

**Exit criteria:** You can run `/canon status` in your server.

## Phase 2 — ESPN fetch + snapshot storage (1–2 days)
1. `packages/espn-client`: fetch wrapper with retry/backoff
2. Implement `fetchLeague({ leagueId, season, view })`
3. `packages/db`: `espn_snapshots` table + repo
4. Implement `/canon ingest season:YYYY view:mTeam`:
   - fetch
   - store snapshot (jsonb)
   - reply with size + top-level keys

**Exit criteria:** You can ingest 2025 `mTeam` and see it stored.

## Phase 3 — Normalize 1–2 tables + first storyline (1–2 days)
Start with what you already have in `mTeam`:
1. Parse `teams[]` into `teams` table:
   - season, teamId, name, owners, pointsFor/Against, record, waiverRank, transaction counters
2. Storyline #1: FAAB spend leaderboard:
   - metric: `transactionCounter.acquisitionBudgetSpent`
   - output: top 12
3. Add a basic leaderboard “card” renderer OR text output.

**Exit criteria:** `/canon leaderboard metric:faab season:2025` works.

## Phase 4 — Weekly throwback scheduler (half day)
1. Add `node-cron` job
2. Choose one consistent weekly post:
   - “FAAB kings” or “Luckiest team”
3. Post to configured channel.

**Exit criteria:** bot posts automatically once/week.

## Phase 5 — Matchups + week-level canon (later)
1. Discover and ingest views that include schedule/boxscores
2. Normalize:
   - `team_week_scores`
   - `matchups`
3. Add storylines:
   - closest games
   - biggest upset
   - rivalries

## Testing checklist
- Unit tests for metric functions (luck, churn, etc.)
- Integration test for snapshot insert + fetch
- Dry-run mode for scheduled posts (does not post, logs instead)
