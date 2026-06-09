# Start Implementing the Discord Bot (You already created it)

## 1) What you need locally

- Node 20+
- Your bot token
- Application (client) ID
- A Discord server where you can invite the bot
- Permissions: `applications.commands`, `bot`

## 2) Environment variables

Create `apps/bot/.env`:

- `DISCORD_TOKEN=...`
- `DISCORD_APP_ID=...`
- `DATABASE_URL=...` (optional for day 1)

## 3) Minimal code plan (discord.js v14)

1. Login bot
2. Register a `/canon status` command
3. Handle interactions:
   - if command is `canon` subcommand `status`, reply “online”
4. Add `/canon ingest` next, wired to ESPN client

## 4) Invite URL (how to generate)

In Discord Developer Portal:

- OAuth2 → URL Generator
- Scopes: `bot`, `applications.commands`
- Bot permissions: Send Messages, Embed Links, Attach Files, Read Message History

## 5) First milestone commands

- `/canon status` → proves bot + commands work
- `/canon config set leagueId startSeason endSeason`
- `/canon ingest season:2025 view:mTeam`
- `/canon leaderboard metric:faab season:2025`

## 6) Common gotchas

- You must deploy/refresh slash commands after changing definitions.
- Guild commands appear instantly; global can take a while.
- Keep token out of git (use `.env`, `.gitignore`).

## 7) Suggested scaffolding tasks (copy/paste)

- [ ] Create `apps/bot` with TypeScript + discord.js
- [ ] Add command deploy script
- [ ] Implement interaction router
- [ ] Add config persistence (DB or JSON for MVP)
- [ ] Implement ESPN fetcher and snapshot saving
- [ ] Implement first leaderboard command
