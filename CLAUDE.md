# CLAUDE.md

Guidance for AI coding agents (Claude Code, Cursor, Copilot) and humans working in this repo.

## What this is

**Fantasy Canon** — a Discord-first offseason companion for ESPN Fantasy Football leagues. It pulls past-season data from ESPN, normalizes it, derives "canonical storylines" (rivalries, comebacks, waiver legends, draft regrets), and posts shareable visuals + slash-command output to Discord. A newer **draft order** feature adds an animated, provably-fair lottery (API + web activity).

> ESPN's league endpoints are **unofficial** and may change. Public leagues (2020+) work without auth; private leagues need `ESPN_S2` + `ESPN_SWID` cookies.

## Stack

- **pnpm** workspaces monorepo, **Node >= 20**, **ESM everywhere** (`"type": "module"` — use `.js` extensions in relative import specifiers even from `.ts` sources, as the code already does).
- **TypeScript** (strict, see `tsconfig.base.json`), **Vitest** for tests, **ESLint** (type-aware) + **Prettier**.
- Apps: Fastify (api), discord.js v14 (bot), React + Vite + matter-js (activity).

## Commands (run from repo root)

| Task | Command |
|------|---------|
| Install | `pnpm install` |
| Typecheck (whole repo) | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Test | `pnpm test` (watch: `pnpm test:watch`) |
| Build all packages | `pnpm build` |
| Run the bot | `pnpm dev` |
| Run the API | `pnpm dev:api` |
| Debug ESPN client | `pnpm debug:espn -- <args>` |
| Deploy slash commands | `pnpm -C apps/bot run deploy` |
| Run activity web app | `pnpm -C apps/activity run dev` |

## Verification rule (important)

Before considering a change done, run:

```
pnpm typecheck && pnpm lint && pnpm test
```

> **Known caveat:** as of this writing the baseline is **not green** — `typecheck` and `lint` fail on a clean checkout (tracked in issues #3, #4, #5). Until those land, judge your change by *not adding new* errors to the relevant package, and keep `pnpm test` green (currently 20 passing). Once the baseline is fixed, treat all three as hard gates.

## Repository map

### `apps/`
- **`api`** — Fastify HTTP + SSE server for the draft-order feature. Entry: `src/index.ts` → `server.ts`, routes in `src/routes/` (`draftOrder.ts`, `sse.ts`), in-memory `store.ts`. Port from `PORT` (default 4000).
- **`bot`** — discord.js v14 bot. Entry: `src/index.ts` → `config.ts` (env/context) + `services/discord.ts` (client + interaction handlers). Slash commands live in `src/commands/canon/*` (bids, faabPace, leaderboard, rivalries, storylines, timeline, transactions, …) and `src/commands/draftOrder/`. Shared helpers in `src/lib/`.
- **`activity`** — React + Vite single-page "Discord Activity" for the animated lottery. Physics via matter-js; `src/renderer/LotteryRenderer.ts`, API access in `src/api.ts`.

### `packages/`
- **`shared`** — cross-cutting types/config (`EnvConfig`, etc.). Depended on by everything.
- **`core`** — pure domain logic, no I/O. Re-exports `storylines`, `metrics` (luck index), `narratives` (templates), `draftOrder` (engine, RNG, state machine, mini-games). Best place for testable business rules.
- **`espn-client`** — unofficial ESPN API client: `client.ts`, `views.ts`, `types.ts`, `inspect.ts`.
- **`db`** — persistence layer. **Currently a `NoopDbClient` placeholder** — repos (`leagueConfigRepo`, `snapshotsRepo`, `teamsRepo`, `transactionsRepo`, `canonEventsRepo`, `draftOrder/`) and SQL migrations (`src/migrations/`) exist but the client isn't wired to a real Postgres yet. Don't assume live DB calls work.
- **`renderer`** — server-side SVG→PNG (via `@resvg/resvg-js`) for cards/graphs posted to Discord (`leaderboardCard`, `luckGraph`, `draftProphecyGraph`, `faabPaceGraph`, `theme`).

### Other
- **`docs/`** — product PRDs and architecture (`00`–`13`, plus `docs/draftOrder/`). Start at `docs/00-product-overview.md` and `docs/05-repository-structure.md`.
- **`scripts/`** — `debug-espn.ts` and the VS Code workspace.

## Conventions

- **TypeScript is the only source of truth.** Do not commit compiled `.js`/`.d.ts` into `src/` (some stale artifacts exist today — see issue #5; don't add more). Build output belongs in `dist/` (gitignored).
- Imports use `.js` extensions on relative paths (ESM/NodeNext resolution).
- `core` stays pure (no network/DB/discord). Side-effectful code lives in `apps/*`, `espn-client`, `db`, `renderer`.
- Tests are colocated in `__tests__/` next to the code, named `*.test.ts`, run by Vitest.
- Format with Prettier (`pnpm format`); don't hand-fight its style.

## Environment

Copy `.env.example` → `.env`. Keys: `DISCORD_TOKEN`, `DISCORD_APP_ID`, `DATABASE_URL`, `ESPN_LEAGUE_ID`, and (private leagues only) `ESPN_S2`, `ESPN_SWID`. The bot also reads `apps/bot/.env.example`.

## Slash commands

- **`/ship-issue <number>`** (`.claude/commands/ship-issue.md`, tracked) — takes a GitHub issue from open to PR-ready in its own worktree: align → implement → verify → PR → `/review` loop, stopping at "ready to merge" for your spot-check. Does not merge. Parallel-safe.
