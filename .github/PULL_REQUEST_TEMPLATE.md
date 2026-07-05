<!--
Thanks for the PR! Keep it focused on one logical change.
Title = a Conventional Commit subject (e.g. `feat(bot): add button pagination`) — it becomes the
squash-merge commit, so no `(#N)` suffix (GitHub appends it).
See CONTRIBUTING.md for the full workflow.
-->

## Summary

<!-- What does this change and why? 1–3 sentences. Link the issue it closes. -->

Closes #

## Test plan

<!-- Concrete steps a reviewer can run/verify. Paste command output or sample results where useful. -->

- [ ]

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm format:check` passes (`pnpm format` to auto-fix)
- [ ] `pnpm test` passes — new behavior has a regression test
- [ ] `pnpm build` passes
- [ ] No compiled `.js`/`.d.ts` committed under `src/`; secrets kept out of the diff
- [ ] Conventional Commit title; PR scoped to one logical change
