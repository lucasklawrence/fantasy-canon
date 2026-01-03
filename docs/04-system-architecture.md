# System Architecture (Fantasy Canon)

## High-level components
1. **Discord Bot (runtime)** — handles commands, posts, schedules jobs
2. **ESPN Client** — fetches league data by season + view
3. **Storage** — raw JSON snapshots + normalized tables
4. **Storyline Engine** — computes metrics + narratives
5. **Renderer** — generates PNG “cards” (optional but recommended)

## Recommended deployment (simple + reliable)
- Single Node process for MVP (bot + ingestion + rendering)
- Postgres (Supabase) for persistence
- `node-cron` for scheduled jobs

## Data flow
1. Admin runs `/canon ingest season:2025`
2. Bot fetches views (mTeam, mRoster, etc.)
3. Save snapshots
4. Normalize tables
5. Compute storylines
6. Render cards
7. Post to Discord

## DB schema (minimal)
### `league_config`
- `guild_id` (discord server)
- `league_id`
- `start_season`
- `end_season`
- `post_channel_id`
- `timezone`
- `created_at`, `updated_at`

### `espn_snapshots`
- `id` (uuid)
- `league_id`
- `season`
- `view`
- `fetched_at`
- `payload` (jsonb)
- `hash` (optional)

### Derived tables (add as you go)
- `teams` (season-level team metadata)
- `team_week_scores` (week, teamId, points, oppId, result)
- `transactions` (adds/drops/trades, bid, time)
- `roster_entries` (week/team/player)

## “What I need from you” to finalize
- Hosting preference (VPS vs local always-on vs cloud)
- Confirm Supabase DB (yes/no)
- Card style preference (minimal vs branded)
- League rules that matter (PPR/half, playoff weeks, FAAB rules)
