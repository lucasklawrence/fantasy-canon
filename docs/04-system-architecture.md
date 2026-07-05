# System Architecture (Fantasy Canon)

Architecture as [C4](https://c4model.com/) diagrams — **Context → Container → Component** — written
as [Mermaid](https://mermaid.js.org/syntax/c4.html), which GitHub renders inline (no build step, no
committed images, stays diffable).

This doc is the single source of truth for **what talks to what**. It reflects `main` **plus the ops
chain (#95–#97)** and calls out placeholders honestly rather than drawing the aspirational MVP. For
the package layout behind these views see [`05-repository-structure.md`](05-repository-structure.md);
for the scheduling decision see [ADR 0002](decisions/0002-scheduling-airflow.md); for the Airflow
sidecar see [`orchestration/README.md`](../orchestration/README.md).

> **Honest-state callouts (read these before the diagrams):**
>
> - **No live app database.** `packages/db` ships in-memory repos plus a no-op `NoopDbClient`; the
>   bot wires the **in-memory repos**, so nothing is persisted. The only Postgres is Airflow's
>   **metadata** DB. The
>   [target data model](#target-data-model-not-yet-persisted) below is where persistence is _headed_,
>   not what runs today.
> - **Scheduling is not `node-cron`.** The weekly post runs on a dependency-free, self-rescheduling
>   timer inside the always-on bot (`services/scheduler.ts`) — the hobby-scale production runtime per
>   [ADR 0002](decisions/0002-scheduling-airflow.md). Airflow is local-first dev + the broader ingest
>   pipeline, and remains a _valid_ broadcast path via the CLI.
> - **`apps/api` is a stub** (logs a message; no server). It appears in no diagram until it does
>   something.

## C4 Level 1 — System Context

Two human roles drive one system that sits between **Discord** (how people reach it) and the
**ESPN Fantasy API** (where the data comes from). Both external systems are things we don't control:
Discord is the chat platform; ESPN's league endpoints are _unofficial_.

```mermaid
C4Context
    title System Context - Fantasy Canon

    Person(member, "League member", "Runs /canon commands; receives weekly cards")
    Person(admin, "League admin", "Sets post channel and league via /canon config; runs /canon ingest")

    System(canon, "Fantasy Canon", "Discord-first offseason companion: pulls ESPN history, derives storylines, posts visuals and slash-command output")

    System_Ext(discord, "Discord", "Chat platform. Gateway delivers interactions inbound; REST posts outbound")
    System_Ext(espn, "ESPN Fantasy API", "Unofficial league endpoints. Public leagues 2020+; private needs ESPN_S2 and ESPN_SWID cookies")

    Rel(member, discord, "Types /canon ...")
    Rel(admin, discord, "Configures and ingests")
    Rel(discord, canon, "Delivers interactions", "gateway WebSocket")
    Rel(canon, discord, "Posts cards and replies", "REST")
    Rel(canon, espn, "Fetches league views", "HTTPS")

    UpdateLayoutConfig($c4ShapeInRow="2", $c4BoundaryInRow="1")
```

## C4 Level 2 — Container

The system is **two runtimes** plus two data stores:

- **Discord Bot** — the always-on Node process. It is the production runtime for _both_ on-demand
  `/canon` commands _and_ (via its in-process scheduler) the weekly broadcast.
- **Airflow sidecar** — a local-first Python/Docker stack (custom image with Node + pnpm + the baked
  repo, issue #96). It owns the ESPN ingest pipeline and can _also_ drive the weekly broadcast by
  shelling out to the **Broadcast CLI**.

Note the **two paths to the same weekly post**: the bot's in-process scheduler (hobby default) and
`Airflow → Broadcast CLI` (dev / future hosted). Both reuse the exact same `renderBroadcast()` +
`postBroadcast()` code — the CLI is just a second entrypoint. Neither store below is the app DB:
Postgres holds Airflow metadata; snapshots are JSON files from the ingest DAG.

```mermaid
C4Container
    title Container - Fantasy Canon

    Person(member, "League member")
    Person(admin, "League admin")
    System_Ext(discord, "Discord", "Gateway + REST")
    System_Ext(espn, "ESPN Fantasy API", "Unofficial endpoints")

    System_Boundary(canon, "Fantasy Canon") {
        Container(bot, "Discord Bot", "Node 24, discord.js v14, tsx", "Always-on gateway process. Routes /canon interactions and runs the in-process weekly scheduler - the hobby-scale production runtime per ADR 0002")
        Container(cli, "Broadcast CLI", "Node, tsx, apps/bot/broadcast.ts", "Short-lived process the weekly_broadcast DAG shells out to; renders and posts one card via REST")
        Container(airflow, "Airflow sidecar", "Python, Docker custom image with Node+pnpm+baked repo", "Local-first orchestration. DAGs: espn_ingest, weekly_broadcast, hello_canon")
        ContainerDb(pg, "Postgres", "Postgres 16, Docker", "Airflow metadata only - NOT the app database")
        ContainerDb(snap, "ESPN snapshots", "JSON files, orchestration/data", "Idempotent partitioned view dumps written by espn_ingest")
    }

    Rel(member, discord, "/canon ...")
    Rel(admin, discord, "/canon config, ingest")
    Rel(discord, bot, "Interactions", "gateway WS")
    Rel(bot, discord, "Cards and replies", "REST")
    Rel(bot, espn, "Fetches views", "HTTPS")

    Rel(airflow, cli, "Runs weekly", "BashOperator, pnpm/tsx")
    Rel(cli, espn, "Fetches views", "HTTPS")
    Rel(cli, discord, "Posts card", "REST")
    Rel(airflow, espn, "Ingests views", "HTTPS, requests")
    Rel(airflow, snap, "Writes", "atomic overwrite")
    Rel(airflow, pg, "Reads/writes metadata", "SQL")

    UpdateLayoutConfig($c4ShapeInRow="2", $c4BoundaryInRow="1")
```

## C4 Level 3 — Component (Discord Bot internals)

Zooming into the bot container. An interaction arrives at the **router**, which dispatches to one of
~30 **`/canon` subcommands**. Each composes the shared packages (`core` for metrics/storylines,
`renderer` for cards, `espn-client` — usually via the bot's fetch-through cache) and replies over
REST. The **scheduler** is a parallel entry that reuses the **broadcast render/post** lib — the same
lib the standalone CLI calls. `shared` (types/config) underpins every package and is omitted from the
graph to reduce noise.

```mermaid
C4Component
    title Component - Discord Bot (apps/bot)

    System_Ext(discord, "Discord", "Gateway + REST")
    System_Ext(espn, "ESPN Fantasy API", "Unofficial endpoints")

    Container_Boundary(bot, "Discord Bot") {
        Component(entry, "Entry and Config", "index.ts, config.ts", "loadEnv + createBotContext: espnClient, in-memory repos, teamNameCache. Logs in and starts the scheduler")
        Component(router, "Interaction router", "services/discord.ts", "Handles interactionCreate; routes the /canon command and autocomplete")
        Component(handlers, "Command handlers", "commands/canon/*", "~30 subcommands: luck, allplay, trophies, rivalries, scout, plus faab/legacy/admin/config groups")
        Component(scheduler, "Weekly scheduler", "services/scheduler.ts", "Dependency-free self-rescheduling timer - NOT node-cron. Opt-in via BROADCAST_* env")
        Component(bcast, "Broadcast render/post", "lib/broadcastRender.ts, lib/postBroadcast.ts", "Assembles a card and posts via REST. Shared with the broadcast CLI")
        Component(botlib, "Bot lib", "lib/*", "Glue helpers: leagueInfo, teamNames, roster, weeklyScores, snapshots fetch-through cache")
        Component(core, "core", "@fantasy-canon/core", "Pure domain: storylines incl faab, metrics incl luck, narratives")
        Component(espnc, "espn-client", "@fantasy-canon/espn-client", "Unofficial ESPN fetch and view registry")
        Component(renderer, "renderer", "@fantasy-canon/renderer", "SVG to PNG cards and graphs via @resvg/resvg-js")
        ComponentDb(db, "db repos", "@fantasy-canon/db", "In-memory repos plus a no-op DbClient - nothing persisted")
    }

    Rel(discord, router, "Interactions", "gateway WS")
    Rel(entry, router, "Registers handlers")
    Rel(entry, scheduler, "Starts if configured")
    Rel(router, handlers, "Dispatches")
    Rel(handlers, botlib, "Uses")
    Rel(handlers, core, "Computes metrics")
    Rel(handlers, renderer, "Renders cards")
    Rel(handlers, discord, "Replies", "REST")
    Rel(botlib, espnc, "Fetch-through")
    Rel(botlib, db, "Snapshot cache")
    Rel(espnc, espn, "Fetches views", "HTTPS")
    Rel(scheduler, bcast, "Triggers weekly")
    Rel(bcast, core, "Metrics")
    Rel(bcast, renderer, "Renders")
    Rel(bcast, discord, "Posts card", "REST")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Runtime & deployment (current)

- **One always-on Node process** (the bot) is the whole production runtime. It must stay connected to
  the gateway for slash commands anyway, so the weekly broadcast piggybacks on it via the in-process
  scheduler (opt-in through `BROADCAST_CHANNEL_ID` / `BROADCAST_SEASON`). No separate scheduler
  service to host.
- **Hosting** is the subject of the ops chain: #95 (register commands + secrets, done), #96 (Node-capable
  Airflow worker image), #97 (verify a real weekly post). A single always-free VM (e.g. GCP
  `e2-micro`) can carry the bot and, with `BROADCAST_*` set, the weekly post — no Airflow required in
  prod.
- **Airflow is local-first.** `orchestration/docker-compose.yaml` (Postgres + LocalExecutor
  webserver + scheduler) runs on your machine at ~$0; Cloud Composer is deliberately avoided
  (~$300–400/mo). It's for developing the ingest pipeline and as an alternate broadcast path, not the
  production cron.
- **Persistence is not wired.** The bot uses **in-memory repos** (the db package's `DbClient` is a
  no-op `NoopDbClient`); ESPN payloads are cached in-memory per process. Standing up a real Postgres
  (Supabase or otherwise) behind the repos is future work.

## Data flow

**On-demand command** (the live path):

1. Member runs a `/canon …` slash command; Discord delivers the interaction over the gateway.
2. The router dispatches to the handler, which fetches the needed ESPN views — most commands via the
   `ensureSnapshot` fetch-through cache (repo hit, else `espn-client` → save); a few admin commands
   hit `espn-client` directly.
3. The handler computes metrics/storylines in `core` and renders a card in `renderer`.
4. It replies to the interaction over REST (card PNG + text).

**Scheduled broadcast** (weekly, two equivalent entrypoints):

1. Trigger — either the bot's in-process scheduler (Tuesdays 16:00 UTC) or Airflow's
   `weekly_broadcast` DAG shelling out to the Broadcast CLI.
2. `renderBroadcast()` pulls snapshots, computes the metric (`power-ranking` / `standings`), renders
   the graph.
3. `postBroadcast()` posts to the configured channel via REST — no interaction, no gateway needed.

## Target data model (not yet persisted)

> ⚠️ **Not live.** The bot runs on **in-memory repos** today; no database is connected. This is the
> schema those repos (`snapshotsRepo`, `teamsRepo`, `transactionsRepo`, `leagueConfigRepo`,
> `canonEventsRepo`) are shaped for once a real Postgres is wired.

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
