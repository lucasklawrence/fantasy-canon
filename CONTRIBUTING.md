# Contributing to Fantasy Canon

Thanks for contributing — human or AI agent. This is the short, operational guide: how to set up,
what "done" means, and how PRs and issues should look. For the deeper picture (architecture intent,
the repository map, module-resolution rules), read [`CLAUDE.md`](CLAUDE.md) — it's the canonical
guide and the single source of truth for conventions.

## Setup

Prerequisites: **Node >= 24** and **pnpm** (this is a pnpm workspaces monorepo, ESM everywhere).

```bash
pnpm install
cp .env.example .env   # fill in DISCORD_TOKEN, ESPN_LEAGUE_ID, etc. (see .env.example)
```

Run everything from the repo root with `pnpm`; per-package scripts use `pnpm -C <path> run <script>`.

| Task                   | Command                                         |
| ---------------------- | ----------------------------------------------- |
| Install                | `pnpm install`                                  |
| Typecheck (whole repo) | `pnpm typecheck`                                |
| Lint                   | `pnpm lint`                                     |
| Test                   | `pnpm test` (watch: `pnpm test:watch`)          |
| Format                 | `pnpm format` (check-only: `pnpm format:check`) |
| Build everything       | `pnpm build`                                    |
| Run the bot            | `pnpm dev`                                      |

## Verification — the definition of done

Before you consider a change done, run the five gates from the repo root:

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
```

**All five are hard gates.** They're green on `main` and must stay green — a change that reds any of
them isn't done. CI (`.github/workflows/ci.yml`) runs the same five on every PR and every push to
`main`, and each one blocks merge. `pnpm format` auto-fixes formatting drift; don't hand-fight
Prettier's style.

New behavior lands with a regression test. Tests are colocated in `__tests__/` next to the code,
named `*.test.ts`, and run by Vitest. Mock ESPN / Discord / network — **no live calls in tests.**

## Conventions

A few rules that CI and reviewers will hold you to (full rationale in `CLAUDE.md`):

- **TypeScript is the only source of truth.** Never commit compiled `.js`/`.d.ts` into `src/` — build
  output belongs in `dist/` (gitignored).
- **Relative imports use `.js` extensions** (ESM / NodeNext resolution), even from `.ts` sources.
- **`packages/core` stays pure** — no network, DB, Discord, or filesystem I/O. Side-effectful code
  lives in `apps/*`, `packages/espn-client`, `packages/db`, and `packages/renderer`.
- **Secrets are never committed.** `.env` is gitignored; `.env.example` is the key list.

## Branches & commits

- Branch off `main`. Name branches `<type>/<short-slug>` (e.g. `feat/button-pagination`,
  `docs/contributing`); if a branch tracks an issue, include the number: `<type>/<number>-<slug>`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `<type>: <summary>` (scope optional, e.g. `feat(bot): …`). Types: `feat`, `fix`, `chore`, `docs`,
  `refactor`, `test`.
- Reference the issue you're closing in the commit and/or PR body: `Closes #<number>`.

## Pull requests

- Open against `main`. PRs are **squash-merged**, so the PR title becomes the commit subject — write
  it as a Conventional Commit (lowercase type, no `(#N)` suffix — squash-merge appends it).
- Fill in the [pull request template](.github/PULL_REQUEST_TEMPLATE.md): a summary, a concrete test
  plan, and the verification checklist.
- Keep PRs focused — one logical change. Split unrelated work.
- CI must be green before merge. **CodeRabbit** auto-reviews PRs (best-effort input, not a gate).

## Filing issues

Use the [issue templates](.github/ISSUE_TEMPLATE/) (Bug report / Feature request). State the **why**,
the **what**, and concrete **acceptance criteria** — well-scoped issues produce better PRs, from
humans and agents alike.
