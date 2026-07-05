# Custom Airflow image for Fantasy Canon orchestration (issue #96).
#
# The stock `apache/airflow` image has no Node and doesn't carry the repo, so the
# `weekly_broadcast` DAG's `pnpm … run broadcast` task fails with `pnpm: not found`.
# This image extends it with Node + pnpm and bakes the pnpm workspace in at
# `/opt/fantasy-canon`, so the default `CANON_BROADCAST_CMD` runs as-is and the
# scheduled cards actually post. (ADR 0002, option 1 — custom image + baked repo.)
#
# Build context is the REPO ROOT (see docker-compose.yaml `build.context: ..`) so the
# whole workspace can be copied in. The broadcast CLI runs via `tsx` (no compile step,
# exactly like `pnpm dev`), so a frozen install is all the worker needs.
#
# Keep the airflow tag in lockstep with pyproject.toml + docker-compose.yaml, and the
# Node major with the repo's `engines.node` (>=24).
FROM apache/airflow:2.10.5

# --- Node + pnpm (root) ----------------------------------------------------------
USER root

# Node 24 from NodeSource (Debian bookworm base). corepack ships with Node and
# provides the pnpm shim; the exact pnpm version is pinned below from packageManager.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Repo lives outside /opt/airflow so it never collides with the dags/logs/data mounts.
# Owned by the airflow user so pnpm can write node_modules at build time and the
# runtime user can read it.
ENV FANTASY_CANON_ROOT=/opt/fantasy-canon
RUN mkdir -p ${FANTASY_CANON_ROOT} && chown airflow:root ${FANTASY_CANON_ROOT}

# --- Workspace install (airflow user) --------------------------------------------
USER airflow
WORKDIR ${FANTASY_CANON_ROOT}

# Copy manifests first so the (slow) dependency layer is cached across bot-code-only
# edits — only a manifest/lockfile change re-runs the install.
COPY --chown=airflow:root package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=airflow:root apps/api/package.json ./apps/api/
COPY --chown=airflow:root apps/bot/package.json ./apps/bot/
COPY --chown=airflow:root packages/core/package.json ./packages/core/
COPY --chown=airflow:root packages/db/package.json ./packages/db/
COPY --chown=airflow:root packages/espn-client/package.json ./packages/espn-client/
COPY --chown=airflow:root packages/renderer/package.json ./packages/renderer/
COPY --chown=airflow:root packages/shared/package.json ./packages/shared/

# Pin pnpm to the repo's packageManager and install the full workspace (devDeps
# included — `tsx` runs the CLI). `@resvg/resvg-js` pulls its Linux prebuilt here,
# which is exactly why the install must happen in-image and not reuse host modules.
RUN corepack prepare pnpm@9.12.0 --activate \
  && pnpm install --frozen-lockfile

# Now the source. node_modules from the install layer survives (COPY merges; the
# .dockerignore keeps host node_modules out), so this layer is cheap to rebuild.
COPY --chown=airflow:root . ./

# Back to Airflow's working dir for the entrypoint.
WORKDIR /opt/airflow
