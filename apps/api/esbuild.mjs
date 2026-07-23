// Bundle the browser client (#127 Phase 2) → dist/client/activity.js.
//
// Separate from the tsc build gate (ADR 0005: the bundle can't be exercised until the manual portal
// work in #168, so CI typechecks the client via src/client/tsconfig.json but doesn't esbuild it).
// Run explicitly with `pnpm -C apps/api run build:client`; `run dev` builds it first. The
// `@discord/embedded-app-sdk` runtime is bundled in; core is imported type-only, so no server code
// reaches the browser.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/client/activity.ts'],
  outfile: 'dist/client/activity.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  logLevel: 'info',
});
