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
```

## Local tooling (optional)

```powershell
uv sync                          # installs airflow + ruff for editor support / unit tests
uv run ruff check dags
```

## Notes

- Host Postgres is mapped to **5433** (not 5432) so it never clashes with the app's own DB.
- `logs/`, `plugins/`, and `.env` are gitignored — only `dags/` and config are tracked.
- Keep `apache-airflow` in `pyproject.toml` in lockstep with the image tag in `docker-compose.yaml`.
