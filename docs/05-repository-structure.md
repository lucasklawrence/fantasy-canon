# Repository Structure (Scaffolding)

A pragmatic TypeScript monorepo (PNPM workspaces or Turborepo) keeps shared logic clean.

> **How these packages compose at runtime:** see the C4 Container/Component diagrams in
> [`04-system-architecture.md`](04-system-architecture.md). Note this file is early _scaffolding_ —
> the diagrams reflect the actual shape on `main`.

## Top-level

```text
fantasy-canon/
  apps/
    bot/                 # Discord bot runtime
    api/                 # Optional HTTP API (ingestion + render endpoints)
  packages/
    espn-client/         # ESPN fetch + view registry
    core/                # Metrics + storyline engine
    db/                  # DB client + migrations + repos
    renderer/            # PNG card generation
    shared/              # Types, utils, constants
  docs/                  # PRDs and design docs
  scripts/               # CLI scripts (ingest, inspect views)
  .env.example
  package.json
  pnpm-workspace.yaml
  turbo.json             # optional
```

## apps/bot (suggested)

```text
apps/bot/
  src/
    index.ts
    commands/
      canon/
        index.ts
        leaderboard.ts
        team.ts
        ingest.ts
        config.ts
    jobs/
      weeklyThrowback.ts
    services/
      discord.ts
      scheduler.ts
  deploy-commands.ts
  Dockerfile
```

## packages/espn-client

```text
packages/espn-client/
  src/
    index.ts
    views.ts
    client.ts
    types.ts
```

## packages/core

```text
packages/core/
  src/
    storylines/
      faab.ts
      luck.ts
      rivalries.ts
    metrics/
      luckIndex.ts
      churnIndex.ts
    narratives/
      templates.ts
```

## packages/db

```text
packages/db/
  src/
    client.ts
    migrations/
    repos/
      snapshotsRepo.ts
      teamsRepo.ts
      transactionsRepo.ts
```

## packages/renderer

```text
packages/renderer/
  src/
    cards/
      leaderboardCard.ts
      rivalryCard.ts
    render.ts
```

## Local dev requirements

- Node 20+
- PNPM
- Postgres (Supabase) or SQLite for MVP
- Discord bot token + application ID
