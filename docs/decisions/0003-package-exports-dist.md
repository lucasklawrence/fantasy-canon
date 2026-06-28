# 0003 — Package `exports` point at `dist`, with a `development` condition for run-from-source

## Status

Accepted. Supersedes the "deliberately deferred" note in
[`0001-typescript-project-references.md`](./0001-typescript-project-references.md).

## Context

Each workspace package (`@fantasy-canon/{shared,core,espn-client,db,renderer}`) previously set
`main` and `types` to `src/index.ts`. That worked only because **every cross-package import was
type-only** — the emitted JS never actually `import`ed another workspace package at runtime, so the
dangling `.ts` `main` was never followed by a real loader.

`pnpm build` emits a flat, consumable `dist/` per package (see #25 / ADR 0001). The moment a
**runtime** cross-package import from compiled output appears — e.g. a deploy step running
`node apps/bot/dist/index.js`, which imports `@fantasy-canon/core` — Node would resolve
`@fantasy-canon/core` via its `main`, land on `src/index.ts`, and fail (`Cannot find module` / can't
load a `.ts` file). Today the bot, deploy, and broadcast CLI all run via `tsx` (from source), so this
hasn't bitten yet; this ADR removes the tripwire before it does.

The constraint: repointing `main`/`exports` at `dist` must **not** force a build before dev or tests
(the run-from-source ergonomics ADR 0001 wanted to preserve).

## Decision

Give each package an `exports` map with a `development` condition, and repoint `main`/`types` at
`dist`:

```jsonc
{
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "development": "./src/index.ts", // dev/test select this
      "default": "./dist/index.js", // node dist selects this
    },
  },
}
```

Resolution per tool:

| Tool                                   | Resolves via                                                           | Lands on |
| -------------------------------------- | ---------------------------------------------------------------------- | -------- |
| `tsc` (typecheck/build)                | tsconfig `paths` (`tsconfig.base.json`)                                | `src`    |
| `tsx` (`dev`/`deploy`/`broadcast`)     | tsconfig `paths`                                                       | `src`    |
| `vitest`                               | `exports` + `resolve.conditions: ['development']` (`vitest.config.ts`) | `src`    |
| `node dist/...` (prod / future deploy) | `exports` → `default` (no `development` condition)                     | `dist`   |

Only `vitest` reads `exports` for these packages, so it is the only tool that needed the explicit
`development` condition; `tsc`/`tsx` already resolve through tsconfig `paths` and are unaffected.

Also folded out the unused, options-less `renderCard` twin of `renderImage` in
`packages/renderer/src/render.ts` (export-surface cleanup called for in #28).

## Consequences

- A `node dist/...` consumer (a containerized deploy, or moving `broadcast`/`deploy` off `tsx`) now
  resolves compiled output — verified: `import.meta.resolve('@fantasy-canon/core')` from the bot
  resolves to `packages/core/dist/index.js`, while `tsx` resolves `src` with no `dist` present.
- Dev and tests still run from source with **no build step** — `pnpm test` resolves `src` via the
  `development` condition.
- The "source for dev, built for prod" rule is declared **in each package**, not hidden in tooling.
- A future tool that resolves these packages **without** the `development` condition (and without
  tsconfig `paths`) would get `dist` and so must build first. Acceptable — that is the correct prod
  behavior; dev tools either use `paths` (tsc/tsx) or opt into the condition (vitest).
- `exports.types` points at the built `dist/index.d.ts`. Our own typechecking uses `paths` → `src`,
  so this only matters to an external consumer that has run `pnpm build` — which it must have, to
  consume `dist` at all.
