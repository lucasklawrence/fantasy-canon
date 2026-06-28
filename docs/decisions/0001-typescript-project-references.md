# 0001 — TypeScript project references for package builds

## Context

`pnpm build` either emitted a nested `dist/core/src/**` + `dist/shared/src/**` layout or failed with
TS6059: the root `tsconfig.base.json` `paths` map workspace imports to each package's
`src/index.ts`, so tsc pulled dependency _sources_ into the consuming package's program and the
program no longer fit under `rootDir: "src"` (issue #25). Dev/test execution (tsx, vitest) resolves
workspace deps via each package's `main: "src/index.ts"`, not the paths map, so any fix had to keep
sources as the runtime entry.

Considered: (a) project references, (b) resolving workspace deps to built `dist` via package.json
`exports` (breaks the run-from-source dev flow — every `pnpm dev`/`pnpm test` would need a prior
build), (c) deleting the build scripts until output is consumed.

> Update: [`0003-package-exports-dist.md`](./0003-package-exports-dist.md) later adopted (b) — `exports`
> point at `dist` — but kept run-from-source by adding a `development` export condition (→ `src`) that
> `vitest` selects and `tsc`/`tsx` bypass via tsconfig `paths`. So no prior build is needed for dev/test.

## Decision

Use **project references**: every `packages/*` tsconfig sets `composite: true` and `references` its
workspace deps; build scripts are `tsc -b`. tsc then resolves the `paths`-mapped sources of a
referenced project to its declaration output, so each package emits a flat `dist/` containing only
its own files. Supporting choices:

- `tsBuildInfoFile` is placed **inside `dist/`** — by default `tsc -b` writes it next to
  `tsconfig.json`, and a deleted `dist/` with a surviving `.tsbuildinfo` makes rebuilds silently
  no-op ("up to date" with no output on disk). Keeping it in `dist/` makes `rm -rf dist` a real
  clean.
- `src/**/__tests__/**` is excluded from build programs so `dist/` stays consumable; the root
  `pnpm typecheck` program still covers tests.
- Root `pnpm build` filters to `./packages/*`. `apps/bot` carries ~67 pre-existing type errors
  (issue #3) that block its emit; `pnpm build:apps` exists and apps fold back into `build` once #3
  lands. `apps/*` tsconfigs already declare `references` so `tsc -b` orders correctly.
- `package.json` `main`/`types` still point at `src/index.ts` — the dev flow is unchanged and dist
  is opt-in. All cross-package imports are currently type-only, so the emitted JS runs under plain
  node; if a runtime cross-package import appears, `main`/`exports` must move to `dist` for the
  consuming deploy. _(Superseded by [ADR 0003](./0003-package-exports-dist.md): `main`/`exports` now
  point at `dist`, with a `development` condition keeping dev/test on `src`.)_

## Consequences

- `pnpm build` is green and each package's `dist/` is flat (`dist/index.js`, `dist/index.d.ts`, …).
- Builds are incremental; `tsc -b` builds referenced deps automatically, and pnpm's topological
  `-r` ordering keeps workspace builds correct either way.
- A future packaging/deploy step that consumes `dist` at runtime still needs an `exports`-map
  change (deliberately deferred).
