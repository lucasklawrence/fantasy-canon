# Fantasy Canon

Fantasy Canon is a Discord-first offseason companion for ESPN Fantasy Football leagues that turns past seasons into **canonical storylines**: rivalries, comeback arcs, waiver legends, draft regrets, and weekly chaos — with shareable visuals and automated “On this week in history” posts.

> **Note:** ESPN’s league endpoints used here are **unofficial** and may change or require cookies for private leagues. This project is designed to work with **public leagues (2020+)** like your example league.

## What you can build first

1. **ESPN client**: pull league snapshots by season + view.
2. **Storage**: persist raw snapshots + normalized tables (teams, matchups, rosters, transactions).
3. **Discord bot**: slash commands to generate storylines and weekly recap cards.
4. **Viz layer**: simple charts/“cards” generated server-side and posted to Discord.

## CI / Deployment

- **CI** (`.github/workflows/ci.yml`): typecheck · lint · format:check · test · build on every PR and push to `main`.
- **Slash-command deploy** (`.github/workflows/deploy-commands.yml`): registers the `/canon` command tree
  with Discord (global commands) automatically when command sources change on `main`, or via a manual
  **Run workflow** (workflow_dispatch). Requires two repository **Actions secrets**:
  - `DISCORD_TOKEN` — the bot token.
  - `DISCORD_APP_ID` — the application (client) ID.

  Add them under **Settings → Secrets and variables → Actions**. Without them the deploy job fails fast
  (`loadEnv` throws). Global commands can take up to ~1h to propagate.

## Docs

- `docs/00-product-overview.md`
- `docs/01-espn-data-access.md`
- `docs/02-storylines-and-visualizations.md`
- `docs/03-discord-bot-prd.md`
- `docs/04-system-architecture.md`
- `docs/05-repository-structure.md`
- `docs/06-implementation-plan.md`
- `docs/07-backlog.md`
- `docs/08-app-description-and-tags.md`
- `docs/09-discord-bot-start.md`

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for setup, the five verification gates
(`typecheck · lint · format:check · test · build`), and branch/commit/PR conventions.
[`CLAUDE.md`](CLAUDE.md) is the deeper guide for architecture and conventions.
Issue and PR templates live in [`.github/`](.github/).
