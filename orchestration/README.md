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
  pyproject.toml        # uv deps for local tooling; airflow version mirrors the image tag
  .env.example          # league id, ESPN cookies (private leagues only), admin login
  dags/
    hello_canon.py      # smoke-test DAG — delete once real DAGs exist
    weekly_broadcast.py # posts weekly cards to Discord (#51)
    canon_broadcast.py  # airflow-free helper for the broadcast command (unit-tested)
  tests/
    test_canon_broadcast.py
```

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
| `BROADCAST_LEAGUE_ID` | League id (falls back to `ESPN_LEAGUE_ID`) |
| `CANON_BROADCAST_CMD` | How the worker runs the CLI (override per deployment) |

> **Runtime requirement:** the `apache/airflow` image has **no Node and doesn't mount the
> repo**, so the default `CANON_BROADCAST_CMD` won't run as-is. To actually post, the worker
> must be able to run the Node CLI — bake Node + the repo into a custom Airflow image, or
> point `CANON_BROADCAST_CMD` at a bot container — and provide `DISCORD_TOKEN` in its env.
> That image work is the deployment follow-up; the DAG, config, and command wiring land here.

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
