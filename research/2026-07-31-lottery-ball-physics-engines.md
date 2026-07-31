---
date: 2026-07-31
topic: Physics/motion libraries for the lottery-machine ball hopper — what bundles cleanly into a Discord Activity, and which engine fits 12 balls in a box
league: { sport: NFL, size: 12, type: snake, roster: redraft, scoring: full-PPR, season: 2026 }
workflow_run_id: n/a (inline research during the #211 ship, 2026-07-31; empirics measured in PR)
stats: { sources_fetched: 8, claims_extracted: 9, claims_verified: 9, confirmed: 8, refuted: 1 }
sources_trusted: [docs.discord.com, brm.io, github.com/dimforge, webflow.com, css-tricks.com, socket.dev]
---

# Physics engines for the lottery-machine hopper
### Platform research (not player research) · inline survey + empirics measured in the #211 PR

## ⚡ Takeaway
Nothing is excluded by the Activity's CSP as long as it **bundles** — we already self-host one esbuild
bundle, so any pure-JS library rides along same-origin. The only real trap is WASM fetched as a
separate asset (use base64-embedding `-compat` builds if ever needed). For our workload — **twelve
balls in a closed circular hopper** — engine throughput is irrelevant and the pick is **matter-js**
on API friction and zero-ceremony bundling. Measured cost in this repo: **+89.1kb minified**
(`lottery.js` 161.2kb → 250.3kb), loaded once per ceremony. GSAP's licensing objection is dead
(fully free since 2025-04-30) — irrelevant for physics, but it's the strongest tool if we later want
richer choreography.

## The CSP constraint, precisely
`confidence: high` (Discord docs + WavePlay, consistent)
- Every request from an Activity iframe must route through `https://<app_id>.discordsays.com`;
  anything else fails `blocked:csp` — including an npm dependency fetching at runtime.
- We serve `dist/client/lottery.js` from our own mapped origin, so **a bundled library is
  same-origin and unaffected**. The filter is "no runtime fetches", not "no libraries".
- As of the 2025-07-30 platform update the `/.proxy/` prefix is **optional** — `/<path>` and
  `/.proxy/<path>` behave identically. Our `transport.ts` needs no change either way.
- **WASM**: a separate `.wasm` asset is a runtime fetch. Rapier ships `-compat` packages that embed
  the wasm as base64 in the JS precisely for this; if Rapier is ever adopted, it must be `-compat`.

## Engine comparison (against *our* workload, not in the abstract)
`confidence: high` for the facts; the verdicts are judgment
| Engine | Facts | Verdict for a 12-ball hopper |
|---|---|---|
| **matter-js** | Pure JS, gentle API, optional built-in canvas renderer (dev-oriented), MIT | **Picked.** Bundles with zero ceremony; measured +89.1kb min here |
| **planck.js** | Box2D port: proper iterative solver, CCD, richer joints | More accurate; accuracy buys nothing for cosmetic tumbling |
| **rapier2d** | Fastest browser engine as of mid-2026 (SIMD builds 2–5× their 2024 releases); WASM | Advantage appears at thousands of bodies; costs a base64 blob. Overkill |
| **GSAP** | 100% free incl. all former Club plugins since 2025-04-30 (Webflow) | Not a physics engine; best-in-class for future *choreography* work |

**Why the slowest engine wins:** at 12 bodies every engine idles far below frame budget. The axes
that actually bind are bundle weight, API friction, and bundler compatibility — matter-js wins all
three. Optimizing throughput here optimizes the one axis that doesn't bind.

## Fairness / steerability
`confidence: high` (verified by implementation in the same PR)
- All candidates allow direct position/velocity writes, so the sealed draw stays in charge: the
  pile simulates freely, and the *chosen* outcome is imposed on cue. The sim never selects.
- Our implementation goes further: the sim only animates the **pile** (tumble, boil, extraction
  recoil, drawn-team exit). The #195 pull/chute/FLIP stays DOM — the canvas never even renders the
  extracted ball, so there is no seam where sim nondeterminism could contradict the reveal.
- Ball *numbers* are derived presentation: contiguous per-team ranges in odds-table order (the same
  counts the commitment binds), and the "which ball came out" flourish is FNV-1a over
  `commitment:pick` — deterministic, so every viewer/replay shows the same number.

## Empirics measured in the #211 PR (was: open questions)
- **Bundle**: `lottery.js` 161.2kb → **250.3kb** (+89.1kb min, esbuild). Acceptable for a
  once-per-ceremony load behind the Discord proxy.
- **Render cost**: pre-rendered sprite per ball face (hue+number) → frame loop is
  drawImage+rotate; matter sleeping parks the rAF loop when the pile settles and nothing animates.
- **Reduced motion**: sim runs a synchronous settle burst and paints one still frame; no loop.
- **Hidden tab**: sim pauses outright on `visibilitychange` (rides the #204 handler).

## ❌ Refuted / killed claims (do NOT act on)
- **"GSAP needs a paid Club license for commercial plugins"** — dead since 2025-04-30; the standard
  license now covers commercial use incl. all former Club plugins (Webflow acquisition).

## 🔴 Caveats
1. **Mobile webview feel is unmeasured** — iOS/Android opt-ins are on; no source speaks to sim
   performance inside the mobile Activity webview. Needs a device check on lottery night's setup.
2. Bundlephobia numbers were not quotable (client-rendered page); the +89.1kb figure is our own
   esbuild measurement, which is the number that matters anyway.
3. matter-js is in maintenance-mode cadence (0.20.x); fine for a cosmetic sim, but don't build
   load-bearing gameplay on unfixed edge cases.

## Open questions / follow-ups
- Mobile device test (fold into #168 Phase B's session).
- If richer choreography lands later (finale sequences, board transitions), evaluate GSAP then —
  license is no longer a factor.

## Sources
- Trusted: https://docs.discord.com/developers/activities/development-guides/networking ·
  https://brm.io/matter-js/docs/classes/Render.html · https://socket.dev/npm/package/@dimforge/rapier2d-compat ·
  https://github.com/dimforge/rapier.js/issues/49 · https://webflow.com/blog/gsap-becomes-free
- Secondary: https://css-tricks.com/gsap-is-now-completely-free-even-for-commercial-use/ ·
  https://blog.waveplay.com/discord-proxy-csp-patch/ · https://napejs.org/benchmark.html
