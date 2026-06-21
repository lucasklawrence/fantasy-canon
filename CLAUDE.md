# CLAUDE.md

Guidance for AI coding agents (Claude Code, Cursor, Copilot) and humans working in this repo.

> This describes the `main` branch. Active feature work (e.g. the draft-order lottery — API, web
> "activity" app, and `draftOrder` modules in `core`/`db`) lives on feature branches and is **not** on
> `main` yet. Don't assume code described on a feature branch exists here.

## What this is

**Fantasy Canon** — a Discord-first offseason companion for ESPN Fantasy Football leagues. It pulls
past-season data from ESPN, normalizes it, derives "canonical storylines" (rivalries, comebacks,
waiver legends, draft regrets), and posts shareable visuals + slash-command output to Discord.

> ESPN's league endpoints are **unofficial** and may change. Public leagues (2020+) work without auth;
> private leagues need `ESPN_S2` + `ESPN_SWID` cookies.

## Stack

- **pnpm** workspaces monorepo, **Node >= 24**, **ESM everywhere** (`"type": "module"` — use `.js`
  extensions in relative import specifiers even from `.ts` sources, as the code already does).
- **TypeScript** (strict, see `tsconfig.base.json`), **Vitest** for tests (`vitest.config.ts`),
  **ESLint** (type-aware) + **Prettier**.
- Apps: discord.js v14 (bot) is the live app; `apps/api` is a placeholder stub.

## Commands (run from repo root)

| Task | Command |
|------|---------|
| Install | `pnpm install` |
| Typecheck (whole repo) | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Test | `pnpm test` (watch: `pnpm test:watch`) |
| Format | `pnpm format` |
| Build everything (flat `dist/` each, must stay green) | `pnpm build` |
| Run the bot | `pnpm dev` |
| Run the API stub | `pnpm -C apps/api run dev` |
| Debug ESPN client | `pnpm debug:espn -- <args>` |
| Deploy slash commands | `pnpm -C apps/bot run deploy` |

## Verification rule (important)

Before considering a change done, run:

```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

> **`pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, and `pnpm build` are all hard
> gates — green on `main`, keep them green** (typecheck exits 0 since #3; lint since #4; formatting
> enforced since #49; build emits via TS project references, see `docs/decisions/0001`; tests
> currently **15 passing**). A change that reds any of them isn't done. `pnpm format` auto-fixes
> formatting drift.

**CI** (`.github/workflows/ci.yml`) runs all five gates on every PR and push to `main` against a
committed, frozen `pnpm-lock.yaml`, and every one blocks merge.

## Repository map

### `apps/`
- **`bot`** — discord.js v14 bot; the live application. Entry: `src/index.ts` → `config.ts` (env/context)
  + `services/discord.ts` (client + interaction handlers). Slash commands live in `src/commands/canon/*`
  (bids, faabPace, leaderboard, rivalries, storylines, timeline, transactions, …). Shared helpers in
  `src/lib/` (leagueInfo, teamNames, transactions). Register commands with `run deploy`.
- **`api`** — placeholder. `src/index.ts` just logs a stub message; no server wired up yet. Build it
  out here when an HTTP surface is needed.

### `packages/`
- **`shared`** — cross-cutting types/config (`EnvConfig`, etc.). Depended on by everything.
- **`core`** — pure domain logic, no I/O. Re-exports `storylines` (incl. `faab`), `metrics` (luck
  index), and `narratives` (templates). Best place for testable business rules.
- **`espn-client`** — unofficial ESPN API client: `client.ts`, `views.ts`, `types.ts`, `inspect.ts`.
- **`db`** — persistence layer. **Currently a `NoopDbClient` placeholder** — repos
  (`leagueConfigRepo`, `snapshotsRepo`, `teamsRepo`, `transactionsRepo`, `canonEventsRepo`) exist but
  the client isn't wired to a real Postgres yet. Don't assume live DB calls work.
- **`renderer`** — server-side SVG→PNG (via `@resvg/resvg-js`) for cards/graphs posted to Discord:
  `cards/leaderboardCard`, `graphs/luckGraph`, `graphs/draftProphecyGraph`, `graphs/faabPaceGraph`,
  `theme`.

### Other
- **`docs/`** — product PRDs and architecture (`00`–`13`). Start at `docs/00-product-overview.md` and
  `docs/05-repository-structure.md`. ADRs live in `docs/decisions/` (numbered `000N-title.md`).
- **`scripts/`** — `debug-espn.ts` and the VS Code workspace.

## Conventions

- **TypeScript is the only source of truth.** Don't commit compiled `.js`/`.d.ts` into `src/` — build
  output belongs in `dist/` (gitignored).
- **Module resolution (don't be confused by `main` → `dist`).** Package `main`/`exports` point at
  `dist` so a `node dist/...` consumer resolves compiled output, but **dev and tests still run from
  source** — `exports` carries a `development` condition → `src/index.ts`. `tsc` (typecheck/build) and
  `tsx` (`dev`/`deploy`/`broadcast`) resolve cross-package imports via tsconfig `paths` → `src`;
  `vitest` selects the `development` condition (`vitest.config.ts`) → `src`. So **no build is needed
  before dev/test**. Full rationale + the per-tool resolution table in
  [`docs/decisions/0003`](docs/decisions/0003-package-exports-dist.md).
- Imports use `.js` extensions on relative paths (ESM/NodeNext resolution).
- `core` stays pure (no network/DB/discord). Side-effectful code lives in `apps/*`, `espn-client`,
  `db`, `renderer`.
- Tests are colocated in `__tests__/` next to the code, named `*.test.ts`, run by Vitest.
- Format with Prettier (`pnpm format`); don't hand-fight its style.

## Environment

Copy `.env.example` → `.env`. Keys: `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DATABASE_URL`,
`ESPN_LEAGUE_ID`, and (private leagues only) `ESPN_S2`, `ESPN_SWID`. The bot also reads
`apps/bot/.env.example`.

## Slash commands

- **`/ship-issue <number>`** (`.claude/commands/ship-issue.md`, tracked) — takes a GitHub issue from
  open to PR-ready in its own worktree: align → implement → verify → PR → `/review` loop, stopping at
  "ready to merge" for your spot-check. Does not merge. Parallel-safe.
