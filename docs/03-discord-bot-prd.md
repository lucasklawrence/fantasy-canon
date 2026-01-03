# PRD: Discord Bot (Fantasy Canon)

**Date:** 2026-01-02  
**Bot status:** already created (you have token + application)

## 1) Primary UX
League members interact via:
- Slash commands (`/canon ...`)
- Scheduled posts (weekly “This week in history”)
- Optional buttons/select menus to paginate results

## 2) Permissions model
- Admin-only:
  - configure league ID + seasons
  - set channel for scheduled posts
  - trigger ingestion
- Everyone:
  - run read-only story commands

## 3) Command set (v1)
### Setup / admin
- `/canon config set leagueId:<id> startSeason:<yyyy> endSeason:<yyyy>`
- `/canon config set channel:<#channel> tz:<America/Los_Angeles>`
- `/canon ingest season:<yyyy|all> views:<default|all>`
- `/canon status` (last ingest time, seasons available)

### Story commands
- `/canon leaderboard metric:<faab|pointsFor|pointsAgainst|luck|acquisitions>`
- `/canon team team:<@user|teamId> summary season:<yyyy|all>`
- `/canon rivalry teamA:<...> teamB:<...> season:<yyyy|all>`
- `/canon week season:<yyyy> week:<n> recap`

## 4) Scheduled posts (v1)
- Weekly cadence during offseason:
  - “On this week in league history: Week X, Season Y”
- Post types rotate:
  1) closest game
  2) biggest upset
  3) FAAB war
  4) highest scorer
  5) funniest stat (e.g., most drops)

## 5) Content rendering
- Text-only fallback is required (in case image render fails).
- Rich mode: attach a PNG “card” + short caption.

## 6) Observability
- Log commands + errors
- Admin-only `/canon debug lastFetch` to print view list + response sizes
- Store ingestion stats:
  - requests, success rate, latency, response bytes

## 7) Anti-spam
- Per-user cooldown on heavy commands (e.g., rivalry all-time)
- Cached computed results (per season)

## 8) Security
- Never print secrets (Discord token, ESPN cookies).
- If you add private league support later, store cookies encrypted.

## 9) “Start implementing now” checklist
### Inputs I need from you (minimal)
- Discord channel ID for automated posts
- Decide whether team mapping is by ESPN `teamId` or by Discord user
  - Recommended: start with ESPN `teamId`; optional mapping later

### Implementation steps (scaffold)
1. Create a monorepo with:
   - `apps/bot` (discord.js)
   - `apps/api` (optional HTTP API for ingestion + rendering)
   - `packages/espn-client`
   - `packages/core` (storyline logic)
2. Register slash commands on startup (or via deploy script).
3. Implement `/canon status` + `/canon ingest` using your league config.
4. Store snapshots (Supabase Postgres recommended).
5. Implement one storyline command end-to-end + card render.

## 10) Definition of done (v1)
- Bot can be invited and responds to `/canon status`.
- Admin can configure league + seasons.
- Admin can ingest a season.
- Users can run `/canon leaderboard metric:faab season:2025`.
- Bot posts a scheduled weekly “throwback” automatically.
