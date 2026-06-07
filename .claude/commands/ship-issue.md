---
description: Ship a GitHub issue end-to-end — questions upfront if any design/implementation choices, then worktree → implement → PR → review loop runs autonomously, stop at "ready to merge" for your final spot-check. Safe to run in parallel — each invocation gets its own worktree.
---

# /ship-issue

Take the GitHub issue at `$ARGUMENTS` from open to PR-ready in one shot. Argument is an issue number
(e.g. `5`) or URL — extract the number.

**Deliverable:** a PR sitting in "ready to merge" state with a test plan in the description. **You do
not merge.** The user reviews and runs `gh pr merge` themselves.

**Prerequisite:** must run from the main repo, NOT from inside another worktree — Phase 2 calls
`EnterWorktree` which fails if the session is already in one. If you're inside a worktree,
`ExitWorktree` (keep or remove as appropriate) first, or ask the user.

**Parallel-safe.** Multiple `/ship-issue` invocations can run concurrently against different issues —
each gets its own worktree and branch. Don't pick the same issue twice.

## Phase 1 — Read the issue + upfront alignment

1. `gh issue view <number>` for title, body, labels, milestone, references.
2. **Read `CLAUDE.md`** if you haven't this session — canonical guide for conventions, architecture
   intent, dev commands, and the repository map (which app/package owns what).
3. If the issue touches a subsystem with a PRD, read it first — `docs/` holds the product/architecture
   docs (`00`–`13`). Don't change a documented contract (e.g. the ESPN view shapes, the storyline
   templates) without noting the impact.
4. Read enough of the codebase to know the blast radius — which files you'll touch, what conventions
   apply, whether anything in flight (open PRs, other worktrees) overlaps.
5. **Upfront question pass — always.** Surface the design/implementation decisions that would
   meaningfully shape the PR: approach variants, scope boundaries, naming/structure, behavior
   tradeoffs, tests/no-tests. List them tersely with a recommendation each, ask in one batch, and
   wait for answers before Phase 2. If the issue is fully specified with no real choices, say "no
   open questions, proceeding" — don't manufacture filler.

## Phase 2 — Worktree + implement

1. Pick a `<slug>` — 2–4 words from the issue title in kebab-case (e.g. `claude-md`,
   `remove-build-artifacts`, `ci-workflow`). Reuse it for the worktree and the branch.
2. `EnterWorktree` named `issue-<number>-<slug>`.
3. Implement against the issue's "Acceptance" criteria. Don't scope-creep. If a step fails, fix and
   retry; if you can't, surface to the user.
4. **Architectural guardrail (per `CLAUDE.md`).** `packages/core` is pure domain logic — **no network,
   DB, discord, or filesystem I/O**. Side-effectful code lives in `apps/*`, `packages/espn-client`,
   `packages/db`, and `packages/renderer`. Before committing, ask: did I put I/O or framework calls in
   `core`? If so, move it out. The split exists so domain rules stay unit-testable.
5. **Source hygiene.** TypeScript is the only source of truth — **never commit compiled `.js`/`.d.ts`
   into `src/`** (build output goes to `dist/`, gitignored). Relative imports use `.js` extensions
   (NodeNext). `packages/db` is a `NoopDbClient` placeholder and `apps/api` is a stub — don't assume a
   live Postgres connection or a running HTTP server.
6. **Audit tests the change may have invalidated.** If you touched function signatures, exported
   types, route paths, or env-var names, grep tests (`**/__tests__/*.test.ts`) for assertions on the
   old shape and update them in the same commit.
7. Verify locally — only the gates that apply, from the repo root:
   - `pnpm install` if `package.json`/deps changed.
   - `pnpm test` — **must pass cleanly** (currently 15 tests). New behavior lands with a regression
     test. Mock ESPN/discord/network — no live calls in tests.
   - `pnpm typecheck` — **hard gate, must exit 0** (green on `main` since #3).
   - `pnpm lint` — baseline **still red** (~30 problems on `main`, tracked in issue #4). Until it
     lands, the bar is: **introduce no new problems** in the files you touched (diff the count
     before/after if unsure). Once green, treat as a hard gate.
   - `pnpm build` if you changed package entry points, tsconfigs, or anything that emits. Covers
     all workspaces (packages + apps) and **must stay green** — each emits a flat `dist/` (project
     references, see `docs/decisions/0001`).
8. **Eyeball rendered output for visual changes.** If you touched `renderer` cards/graphs, render the
   affected output to a PNG and look at it — lint/build passing ≠ the image is right. (There's no web
   UI on `main` yet; if a feature branch adds one, drive it with the Playwright MCP instead.)
9. **If the issue produced a non-obvious architecture decision**, capture it as a short ADR under
   `docs/decisions/000N-title.md` (Context / Decision / Consequences) in the same PR — next number
   after the highest existing (0001 = TS project references).
10. Commit using a Conventional Commits message:
    ```text
    <type>: <one-line summary>

    <2–4 sentence why-not-what>

    Closes #<number>.

    Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
    ```
    Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`. Scope optional.

## Phase 3 — Push + open PR

No user pause. Once any configured CI gate is green (or absent), flow into Phase 4.

1. **Verify the base is current.** `git fetch origin main`, confirm the branch sits on top of
   `origin/main`; rebase if stale *before* the first push. If you already pushed onto a stale base,
   push the rebased commit to a *new* branch name — **never force-push**.
2. Push to `<type>/<number>-<slug>`.
3. Open the PR: base `main`; title `<type>: <summary>` (lowercase type, no `(#N)` suffix —
   squash-merge appends it); body = summary, `Closes #<issue>`, a `## Test plan` checklist of
   concrete things to run/click/verify, screenshots placeholder for Phase 5. **Write the body to a
   temp file and pass `--body-file`** — inline multiline bodies get mangled by PowerShell quoting
   (backticks/quotes inside here-strings), and safety hooks may pattern-match destructive-looking
   command text in the body. Delete the temp file only after the `gh` call succeeds (an
   unconditional `;`-chained cleanup runs even when the command fails). If pushing the worktree's
   auto-named branch under a different remote name, pass `--head <branch>` explicitly.
4. **CI:** `.github/workflows/ci.yml` runs on every PR — typecheck/test/build are hard gates, lint is
   non-blocking until #4 lands. After pushing, give it a moment to register, then watch the run:
   `gh pr checks <pr> --watch` (or poll `gh pr view <pr> --json statusCheckRollup`). A red **required**
   check is a real failure — fix it on the branch before Phase 4, don't merge around it. (No review
   bots yet — `/review` is still the review gate.)

## Phase 4 — Review loop (`/review`-led)

`/review` is the primary signal. Any review bots added later are best-effort — don't gate on them.

Loop until convergence, **max 3 iterations**:

1. Run `/review` on the PR. Address actionable findings with a new commit on the same branch. Push.
2. If review bots are installed later, check their inline comments (`gh pr view <pr> --json
   comments,reviews`; `gh api repos/:owner/:repo/pulls/<pr>/comments`) and address actionable items,
   replying on each thread with what changed (or why you disagree).
3. **Convergence** — stop when `/review` returns no new actionable findings, CI is green (lint may
   show a non-blocking ✗ until #4), and no reviewer is repeating an already-addressed finding (a
   repeat = stop and surface, not ping-pong).
4. Otherwise `ScheduleWakeup` ~270s and repeat.
5. **Hard cap:** if 3 iterations haven't converged, stop and surface — "N rounds; here's what's still
   flagged. Need direction."

If a comment is unclear or you disagree, don't silently fix/ignore — reply with reasoning and note it
in the hand-off.

### After convergence: capture deferred work as follow-up issues

Gather every nit / suggestion / `/review` polish item **not** applied to this PR (skipped bot nits,
out-of-scope findings, "future refactor" code comments). Then file one or more GitHub issues —
**group** related items by theme, **split** genuinely independent ones, **file zero** only if all
deferred items were trivial taste calls. Each references the originating PR (`Spotted while shipping
#<PR>`) and uses existing labels. Mention follow-up numbers in the Phase 5 hand-off.

## Phase 5 — Hand off (the only user-pause besides Phase 1)

The user's spot-check moment. Everything else is autonomous.

1. **Rendered-image changes → capture the image first.** Any new/modified `renderer` card or graph.
   Render the affected output to a PNG (a throwaway tsx script against the package source works;
   delete it after), save under `screenshots/pr-<pr>/…`, **look at the image yourself**, then publish
   to a throwaway `screenshots-pr-<pr>` branch with git plumbing — no checkout needed. Run it in
   **Bash, not PowerShell** (PowerShell pipes prepend a BOM that breaks `git mktree`):
   ```bash
   b=$(git hash-object -w shot.png) \
     && tree=$(printf '100644 blob %s\tshot.png\n' "$b" | git mktree) \
     && commit=$(git commit-tree "$tree" -m "screenshots for PR #N") \
     && [ -n "$commit" ] && git push origin "$commit:refs/heads/screenshots-pr-N"
   ```
   **Never compose a push refspec from a variable that might be empty** — `":refs/heads/x"` is a
   branch *deletion*; guard with `[ -n "$commit" ]` as above. Reference the
   `raw.githubusercontent.com/<owner>/<repo>/screenshots-pr-<pr>/…` URL in the PR comment; if the
   push fails, list local paths and ask the user to drag them in. (If a feature branch adds a web
   UI, drive it with the Playwright MCP and capture desktop `1280×800` + mobile `390×844` instead.)
2. **Bot / data / logic change → capture a verification snippet** instead: the relevant Vitest output
   showing the new behavior, or a sample of the command output / rendered text. Numbers are the
   artifact; pictures aren't always honest.
3. Post a final PR comment: ✅ `/review` status; **screenshots** (if step 1) or **verification
   snippet** (if step 2); **test plan** (concrete steps before merge); **follow-ups**
   (`Deferred to #N: …`); the merge command `gh pr merge <pr> --squash --delete-branch`.
4. Tell the user in one short message: PR URL
   (`https://github.com/lucasklawrence/fantasy-canon/pull/<pr>`), one-line summary, "Spot-check the
   test plan, then say 'merge' (or run the command yourself)."
5. Stop. **Do not merge.** Don't exit the worktree — the user may want one more change.

## Project-specific notes

- **pnpm workspaces monorepo, ESM, Node >= 20.** Run everything from the repo root with `pnpm`
  (`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`). Per-package: `pnpm -C <path> run <script>`.
- **Pure `core`, side-effectful edges.** New domain logic goes in `packages/core` (no I/O); ESPN/DB/
  discord/render code lives in its dedicated package or `apps/*`.
- **TypeScript-only source.** No committed `.js`/`.d.ts` under `src/`; `.js` import extensions on
  relative paths (NodeNext).
- **`packages/db` and `apps/api` are placeholders.** `db` is a `NoopDbClient` (repos exist but aren't
  wired to live Postgres); `apps/api` is a stub that just logs. Don't write code that assumes a real
  DB connection or a running server without saying so.
- **ESPN endpoints are unofficial.** Public leagues (2020+) work without auth; private leagues need
  `ESPN_S2`/`ESPN_SWID`. Mock them in tests.
- **Secrets never committed.** `.env` is gitignored; use `.env.example` (and `apps/bot/.env.example`)
  as the key list.
- **Default branch `main`.** Squash-merge. Conventional commits.
- **`.claude/commands/` is tracked** — shared slash commands (this file included) are committed so
  they travel with the repo; the rest of `.claude/` (local settings) stays gitignored.
- **PowerShell on Windows.** `&&` doesn't chain (use `;` + `if ($?)`, or parallel Bash calls). The
  Bash tool is available for POSIX needs. Multiline text for `gh` (`pr create`, `issue create`,
  `pr comment`) goes through `--body-file`, never inline. Pipes into git plumbing add a BOM — use
  Bash for `hash-object`/`mktree`/`commit-tree` work.
- **Reproduction runs can litter `src/`.** The old `tsc -p` configs emitted `.js`/`.d.ts` next to
  sources on *failed* builds (tsc emits on error by default). If you ran builds while reproducing a
  bug, check `git status` for stray `src/**/*.js`/`.d.ts` before committing — never commit them.
- **CI is live** (`.github/workflows/ci.yml`): typecheck/test/build hard, lint non-blocking until #4.
  No review bots yet — `/review` is the review gate. When #4 lands, drop the lint step's
  `continue-on-error` so it gates too.
