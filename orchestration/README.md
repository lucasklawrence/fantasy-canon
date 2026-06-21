# Fantasy Canon — Orchestration (Airflow sidecar)

Python [Airflow](https://airflow.apache.org/) sidecar that orchestrates Fantasy Canon's
data pipeline: **ESPN ingest → normalize → storylines → Discord posts**
(see `docs/04-system-architecture.md`). It is a *separate* uv/Python workspace,
deliberately **outside** the pnpm/TS workspace — the bot and `node-cron` are untouched.

Tracking: epic **#12**, this scaffold **#13**. Real DAGs land in #14–#17.

## Cost

⚠️ **Local = $0** and is the default. Everything below runs in Docker on your machine.
GCP **Cloud Composer** is *not* used here — it idles at ~$300–400/mo, so it's only ever
a deliberate short burst (then torn down) for managed-Airflow experience. See #19.

## Prerequisites

- Docker + Docker Compose (Docker Desktop on Windows)
- [uv](https://docs.astral.sh/uv/) — only for local linting / editor autocomplete; Airflow itself runs in Docker

## Quickstart

```powershell
cd orchestration
Copy-Item .env.example .env      # then edit if needed (defaults work for the example public league)
docker compose up                # first run pulls images (~1 GB) and migrates the DB
```

Then open the UI:

- URL: http://localhost:8080
- Login: `admin` / `admin` (override via `AIRFLOW_ADMIN_USER` / `AIRFLOW_ADMIN_PASSWORD` in `.env`)

Verify the loop: in the UI, un-pause and trigger **`hello_canon`** — both tasks should go
green, and `check_config`'s logs should print your `ESPN_LEAGUE_ID`.

```powershell
docker compose down              # stop, keep metadata
docker compose down -v           # stop and wipe the metadata DB (fresh start)
```

## Layout

```
orchestration/
  docker-compose.yaml   # postgres + LocalExecutor webserver + scheduler (local only)
  Dockerfile            # custom Airflow image: + Node + pnpm + baked repo (#96)
  pyproject.toml        # uv deps for local tooling; airflow version mirrors the image tag
  .env.example          # league id, ESPN cookies (private leagues only), admin login
  dags/
    hello_canon.py      # smoke-test DAG — delete once real DAGs exist
    weekly_broadcast.py # posts weekly cards to Discord (#51)
    canon_broadcast.py  # airflow-free helper for the broadcast command (unit-tested)
    espn_ingest.py      # extract: ESPN views → idempotent snapshots (#14)
    espn.py             # airflow-free ESPN read client (URL builder unit-tested)
    snapshots.py        # airflow-free partitioned/idempotent snapshot storage (unit-tested)
  tests/
    test_canon_broadcast.py
    test_espn.py
    test_snapshots.py
  data/                 # snapshot output (gitignored; mounted into the worker)
```

## `espn_ingest` DAG (issue #14)

The **extract** step: pulls ESPN views for a season and writes them as **idempotent,
partitioned snapshots** (`data/season=<yyyy>/<view>.json`, atomic overwrite). One mapped
task per view, fetched in pure Python (`requests`) — no Node worker needed for ingest.
Re-runs/backfills overwrite the same partition, so they're safe. Feeds the future
normalize → storylines steps (#15–#16).

**Config** (Airflow Variables, or env via `.env`):

| Key | Purpose |
|-----|---------|
| `ESPN_LEAGUE_ID` | League to pull (required) |
| `INGEST_SEASON` | Season year (required) |
| `INGEST_VIEWS` | Optional comma list (default: mTeam, mRoster, mScoreboard, mTransactions2, mSettings, mDraftDetail) |
| `SNAPSHOT_ROOT` | Output dir in the worker (default `/opt/airflow/data/snapshots`, mounted to `./data`) |
| `ESPN_S2` / `ESPN_SWID` | Cookies — private leagues only |

Trigger it from the UI; snapshots land under `orchestration/data/`. This DAG runs as-is in
the stock image (Python only — unlike `weekly_broadcast`, no Node required).

## `weekly_broadcast` DAG (issue #51)

Posts the **power-ranking** and **standings** cards to the league Discord channel once a
week (Tuesdays 16:00 UTC). Each metric is a mapped task that retries independently. The
task shells out to the bot's broadcast CLI (`apps/bot/broadcast.ts`); rendering + posting
live in the bot, per [ADR 0002](../docs/decisions/0002-scheduling-airflow.md).

**Config** (Airflow Variables, or env via `.env` — see `.env.example`):

| Key | Purpose |
|-----|---------|
| `BROADCAST_CHANNEL_ID` | Discord channel to post to (required) |
| `DISCORD_TOKEN` | Bot token used to post (required) |
| `BROADCAST_SEASON` | Season year to render (required) |
| `DISCORD_APP_ID` | Application (client) id — required by the bot's config loader |
| `BROADCAST_LEAGUE_ID` | League id (falls back to `ESPN_LEAGUE_ID`) |
| `CANON_BROADCAST_CMD` | How the worker runs the CLI (defaults to the baked-in repo path) |

### Node-capable worker (issue #96)

The broadcast task shells out to a **Node** CLI, but the stock `apache/airflow` image has no
Node and doesn't carry the repo — so out of the box the task fails with `pnpm: not found`.
This stack therefore builds a **custom Airflow image** (`orchestration/Dockerfile`, ADR 0002
option 1) that extends `apache/airflow:2.10.5` with Node 24 + pnpm and bakes the pnpm
workspace in at `/opt/fantasy-canon` (a frozen `pnpm install`; the CLI runs via `tsx`, no
compile step). With the repo baked in, the default
`CANON_BROADCAST_CMD = pnpm --dir /opt/fantasy-canon/apps/bot run broadcast --` runs as-is.

- `docker compose up` builds the image on first run (slow once: installs the workspace,
  including the renderer's native `@resvg/resvg-js` Linux prebuilt).
- **After changing bot code, rebuild:** `docker compose up --build` (the repo is baked at
  build time, not bind-mounted — the most reliable option on Windows, where pnpm's symlink
  store doesn't bind-mount cleanly). DAG files under `dags/` are still mounted, so DAG edits
  need no rebuild.
- Provide `DISCORD_TOKEN` **and** `DISCORD_APP_ID` in `.env` — the bot's `loadEnv()` requires
  both, even though REST posting only uses the token.

To verify end-to-end, fill in `.env` and trigger the DAG (issue #97): both mapped tasks
(`power-ranking`, `standings`) should go green and the cards appear in the channel.

## Local tooling (optional)

```powershell
uv sync                          # installs airflow + ruff for editor support / unit tests
uv run ruff check dags
uv run pytest                    # runs the airflow-free helper tests
```

## Notes

- Host Postgres is mapped to **5433** (not 5432) so it never clashes with the app's own DB.
- `logs/`, `plugins/`, and `.env` are gitignored — only `dags/` and config are tracked.
- Keep `apache-airflow` in `pyproject.toml` in lockstep with the image tag in `docker-compose.yaml`.
