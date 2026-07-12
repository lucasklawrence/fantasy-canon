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
    normalize_dag.py    # transform: snapshots → teams / team_week_scores / transactions (#15)
    normalize.py        # airflow-free transforms + partitioned table storage (unit-tested)
    storylines_dag.py   # storylines: normalized tables → luck / churn / waiver_spend / rivalries (#16)
    storylines.py       # airflow-free metric transforms over the derived tables (unit-tested)
    conventions.py      # airflow-free shared default_args + data-quality gate (#18, unit-tested)
  tests/
    test_canon_broadcast.py
    test_espn.py
    test_snapshots.py
    test_normalize.py
    test_storylines.py
    test_conventions.py
  data/                 # snapshot output (gitignored; mounted into the worker)
```

## `espn_ingest` DAG (issue #14)

The **extract** step: pulls ESPN views for a season and writes them as **idempotent,
partitioned snapshots** (`data/season=<yyyy>/<view>.json`, atomic overwrite). One mapped
task per view, fetched in pure Python (`requests`) — no Node worker needed for ingest.
Re-runs/backfills overwrite the same partition, so they're safe. Feeds the
`normalize` DAG below (#15), then storylines (#16).

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

## `normalize` DAG (issue #15)

The **transform** step: reads the raw snapshots `espn_ingest` wrote and produces three
**derived tables** as partitioned, idempotent JSON (mirroring the snapshot storage, atomic
overwrite). Runs as its own DAG so the transform stage is independently triggerable and
backfillable; the storylines DAG (#16) will consume these tables next.

| Table | Source view | Partition | Row shape |
|-------|-------------|-----------|-----------|
| `teams` | `mTeam` | `season=<yyyy>/teams.json` | `teamId, name, abbrev, location, nickname` |
| `team_week_scores` | `mScoreboard` | `season=<yyyy>/week=<n>/…` | `week, teamId, points, oppId, result` (W/L/T) |
| `transactions` | `mTransactions2` | `season=<yyyy>/week=<n>/…` | `id, type, status, teamId, bid, week, time, items[]` |

Each table file is an **envelope** (`{table, season, week, as_of, row_count, rows}`); `as_of`
stamps when the run wrote the partition, so revised numbers become an auditable time series —
the partition is the audit grain, since a re-run overwrites it whole. Transaction rows whose
`scoringPeriodId` is absent fall into a `week=0` bucket so nothing is dropped. Pure Python
(stdlib only) — no Node, and the transforms unit-test without Airflow (`test_normalize.py`).

**Config** (Airflow Variables, or env via `.env`):

| Key | Purpose |
|-----|---------|
| `INGEST_SEASON` | Season year to normalize (required) |
| `SNAPSHOT_ROOT` | Where ingest wrote snapshots (default `/opt/airflow/data/snapshots`) |
| `NORMALIZED_ROOT` | Output dir for derived tables (default `/opt/airflow/data/normalized`, mounted to `./data`) |

Run `espn_ingest` first, then trigger `normalize`; derived tables land under
`orchestration/data/normalized/`.

## `storylines` DAG (issue #16)

The **storylines** step: pure transforms over the normalized derived tables that materialize
four **storyline tables** (same partitioned, idempotent envelope store as `normalize`). No ESPN
calls — a clean dependency boundary: it reads only what `normalize` wrote.

| Table | Source | Partition | Row shape |
|-------|--------|-----------|-----------|
| `luck` | `team_week_scores` | `season=<yyyy>/luck.json` | `teamId, wins/losses/ties, allPlay{Wins,Losses,Ties,WinPct}, games, expectedWins, luck` |
| `churn` | `transactions` | `season=<yyyy>/churn.json` | `teamId, adds, drops, trades, moves, weeks, churnPerWeek` |
| `waiver_spend` | `transactions` | `season=<yyyy>/week=<n>/…` | `week, teamId, spend` (FAAB per week) |
| `rivalries` | `team_week_scores` | `season=<yyyy>/rivalries.json` | `teamA, teamB, aWins, bWins, aPoints, bPoints` |

- **Luck** = `wins − expectedWins`, where `expectedWins` is the schedule-independent all-play
  expectation (`allPlayWinPct × games`) — the value the bot's Monte Carlo (`expectedWins.ts`)
  converges to, computed analytically so it stays deterministic and hand-verifiable.
- **Churn** counts item-level adds/drops (a trade moves players both ways) per settled
  transaction; `churnPerWeek = moves / weeks` (season length = max week in `team_week_scores`).
- **Waiver spend** sums positive, executed waiver bids per `(week, team)` — mirrors the bot's
  `isWaiverSpend` gate.
- **Rivalries** builds every head-to-head pairing (`teamA` = lower id), ranked most-lopsided
  first; ties count toward neither side.

**Config** (Airflow Variables, or env via `.env`):

| Key | Purpose |
|-----|---------|
| `INGEST_SEASON` | Season year to compute (required) |
| `NORMALIZED_ROOT` | Where `normalize` wrote derived tables (default `/opt/airflow/data/normalized`) |
| `STORYLINES_ROOT` | Output dir for storyline tables (default `/opt/airflow/data/storylines`, mounted to `./data`) |

Run `normalize` first, then trigger `storylines`; storyline tables land under
`orchestration/data/storylines/`. Pure Python (stdlib only) — no Node, and the transforms
unit-test without Airflow (`test_storylines.py`).

## Pipeline conventions (issue #18)

The three data-pipeline DAGs (`espn_ingest` → `normalize` → `storylines`) share their
reliability rules through `conventions.py`, so they behave the same way and there's one place
to change them. Stdlib only, so the validators unit-test without Airflow (`test_conventions.py`).

**Retries / backoff / timeouts.** Every DAG uses `pipeline_default_args()` for its
`default_args`: 3 retries with **exponential backoff** (2m → 4m → 8m, capped at 30m) so a
transient blip on ESPN's unofficial endpoints is retried rather than fatal, without hammering
them, plus a 30-minute per-task `execution_timeout` so a wedged fetch fails loudly instead of
pinning a worker.

**Idempotent overwrite.** Derived data is *dynamic* — ESPN revises the just-finished week's
numbers for a day or two — so every load overwrites its `(season[, week])` partition whole,
last-write-wins (atomic temp-file + `os.replace`, see `write_table`). Weekly tables
(`team_week_scores`, `transactions`, `waiver_spend`) additionally **clear their week partitions
before writing** (`clear_weekly_partitions`): since a weekly load only writes the weeks that
have rows, a rerun where a week goes empty would otherwise leave a stale partition behind.
Clearing first makes the write a true whole-table overwrite, so a re-run or backfill always
converges to the same state as a fresh run.

**Data-quality gate.** `normalize` and `storylines` end with a `quality_gate` task that runs
after all the loads, re-reads the tables, and **fails the DAG** if the output looks wrong — no
rows where rows are expected, null ids, or a gap in the week sequence (`check_min_rows` /
`check_no_null_fields` / `check_contiguous_weeks`, aggregated by `run_data_quality` so every
violation is reported at once). A bad load is caught loudly here instead of silently feeding
the next stage.

**Schedule passes.** The DAGs stay `schedule=None` (manual/triggered) for local-first, $0 dev,
but `conventions.py` defines the intended production cadence as constants so enabling them later
is a one-line change per DAG:

| Constant | Cron | Purpose |
|----------|------|---------|
| `SCHEDULE_FINALIZE` | `0 16 * * 2` (Tue 16:00 UTC) | authoritative recompute of the just-finished week, after ESPN's Mon/Tue stat corrections land |
| `SCHEDULE_REFRESH` | `0 12 * * *` (daily 12:00 UTC) | refresh the in-progress week so mid-week views aren't stale; the finalize pass later supersedes it |

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
