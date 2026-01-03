# Backlog (Features → Tasks)

## Feature: ESPN ingestion
- [ ] Add view registry with “default” set (mTeam, mRoster, mTransactions, mDraftDetail)
- [ ] Add season-range ingest script (2020 → now)
- [ ] Add snapshot hashing + “skip if unchanged”
- [ ] Add structured logging with request timings
- [ ] Add rate limiting + exponential backoff

## Feature: Data model + analytics
- [ ] `teams` table from mTeam
- [ ] `transactions` table from mTransactions
- [ ] `matchups` + `team_week_scores` from schedule views
- [ ] Compute: luck index, churn index, waiver spend per week, rivalry stats

## Feature: Discord bot commands
- [ ] /canon config set ...
- [ ] /canon ingest ...
- [ ] /canon leaderboard ...
- [ ] /canon team summary ...
- [ ] /canon rivalry ...
- [ ] /canon week recap ...

## Feature: Scheduled content
- [ ] Weekly throwback job
- [ ] Rotation schedule (5 post types)
- [ ] “Season anniversary” posts (draft day, playoffs)

## Feature: Visual cards
- [ ] Leaderboard card
- [ ] Rivalry card
- [ ] Week recap card

## Feature: Multi-league support
- [ ] per-guild multiple leagues
- [ ] per-channel subscriptions

## Feature: Private league support (future)
- [ ] cookie-based auth (SWID/espn_s2)
- [ ] encrypted storage
