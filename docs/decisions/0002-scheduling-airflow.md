# 0002 — Airflow for scheduled broadcasts

## Context

The bot's league-wide content (weekly trophies, power rankings, the standings bump chart, the
season awards recap) is most valuable posted automatically on a weekly cadence — the proven pattern
from prior-art bots is Mon close scores → Tue trophies + power rankings → Wed standings + waivers →
Thu matchups (see `docs/14-data-surfacing-research.md` §2). Today every surface is reachable only as
an on-demand `/canon` command; there is **no scheduled posting path** (issue #51), and a scheduled
post is _not_ a slash-command interaction, so the 3s/15min interaction-token window does not apply —
posts go through `channel.send` to the per-guild `postChannel` already stored by `/canon config`.

Issue #19 framed the mechanism decision. Options considered:

- **(a) `node-cron` in the bot process** — schedule inside the running gateway. Zero new infra,
  fastest to ship, reuses the bot's renderer/ESPN code directly. But scheduling only runs while the
  bot is up, retries/backfill/observability are DIY, and it couples a data pipeline to a chat client.
- **(b) Airflow DAGs** — the repo already carries an `orchestration/` Airflow scaffold (#13) with a
  local Docker Compose dev stack and planned DAGs (`weekly_throwback` #17, pipeline conventions #18).
  Mature retries, backfill, partition-overwrite idempotency, and observability.
- **(c) GitHub Actions cron** — nearly free, no servers, logs in Actions, but coarse cron timing,
  runtime/secrets live in CI, and it is awkward for many fine-grained schedules.

## Decision

Use **Airflow**, matching the existing `orchestration/` scaffold (#13) and DAG backlog (#17–#19).

- **Local-first, Composer-burst cost posture.** Develop and run against the committed
  `docker-compose` Airflow locally (effectively free). Promote to **Cloud Composer only when a
  hosted, always-on scheduler is actually needed**, and treat Composer as a cost-bearing burst
  rather than an always-on default — keep DAGs cheap and idempotent so a local or short-lived hosted
  runner can own them.
- **DAGs trigger a bot-side broadcast entrypoint, not a long-running HTTP service.** The weekly DAGs
  invoke a Node broadcast CLI in `apps/bot` (analogous to `deploy-commands.ts`, run via a Bash/Pod
  operator) that resolves the configured channel, renders the relevant card with the existing
  `@fantasy-canon/renderer` + core metrics, and posts via `channel.send`. This reuses all the
  rendering/ESPN/awards code already on `main` instead of reimplementing it in Python, and avoids
  standing up and securing an HTTP surface on the `apps/api` stub.
- **Pipeline conventions** (retries/backoff, partition-overwrite idempotency, a data-quality gate)
  follow #18 so reruns are safe.

## Consequences

- **Unblocks #51**, which becomes two buildable pieces: (1) a Node broadcast CLI in `apps/bot`
  (channel + content-type → render → `channel.send`), and (2) Airflow DAG(s) in `orchestration/`
  that invoke it on the Mon→Sun cadence. The CLI is independently testable and also reusable by a
  manual "post now" path.
- **Scheduling is decoupled from bot uptime** and gains retries/backfill/observability.
- **Cost stays near zero by default** (local Docker Compose); Cloud Composer is opt-in for hosted
  runs and should be scoped/burst to control spend.
- **Secrets** (`DISCORD_TOKEN`, `DISCORD_APP_ID`, ESPN cookies for private leagues) must be present
  in whatever environment runs the broadcast CLI — the Airflow worker/runner, not the CI deploy job.
- Heavier to operate than `node-cron`; accepted in exchange for a real, observable pipeline that
  aligns with the orchestration work already underway.

## Addendum (2026-06): hobby runtime = in-process scheduler

In practice, hosting Airflow for a single weekly post is overkill at hobby scale, and the
local-only Airflow stack only fires while `docker compose up` is running on a machine — not a
dependable weekly cron. Since the bot is **already an always-on process** (it must stay connected
for slash commands), the weekly broadcast now also runs **in-process** via a small dependency-free
scheduler (`apps/bot/src/services/scheduler.ts`), opt-in through `BROADCAST_CHANNEL_ID` /
`BROADCAST_SEASON` env. It reuses the same `renderBroadcast()` lib as the CLI/DAG.

This does not reverse the decision: **Airflow stays** for local development and the broader
ESPN→normalize→storylines pipeline (epic #12). The in-process scheduler is simply the right
**production runtime for the weekly post at hobby scale**. The broadcast CLI and Airflow DAG remain
valid paths (e.g. if Airflow is later hosted on an always-on host or Composer). See the ops issues
for hosting (#95–#97).

> Both broadcast paths (in-process scheduler and `Airflow → broadcast CLI`, sharing the same
> `renderBroadcast()`/`postBroadcast()` lib) are drawn in the C4 Container diagram in
> [`docs/04-system-architecture.md`](../04-system-architecture.md).
