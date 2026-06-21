import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve workspace packages to their TS source in dev/test. Package `exports` now point
  // `main`/`default` at `dist` (so `node dist/...` works), with a `development` condition that
  // maps back to `src/index.ts`; selecting it here keeps tests running from source with no
  // build step. See docs/decisions/0003-package-exports-dist.md.
  resolve: {
    conditions: ["development"]
  },
  test: {
    globals: true,
    include: ["packages/**/__tests__/**/*.test.ts", "apps/**/__tests__/**/*.test.ts"]
  }
});
