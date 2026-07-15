# 0005 — Web draft dashboard as a Discord Activity

## Status

**Proposed.** Records the host decision for the real-time web draft dashboard ([#127]) and lands the
first increment — the `apps/api` backend scaffold — alongside it. To be moved to **Accepted** once
the Embedded App SDK client + Discord Developer Portal registration (the manual, `type:manual` steps
below) are wired and a live Activity renders in the league's server. Builds on [#156] (the local
read-only advisor) and reuses the pure projection lifted to `core` in this change.

## Context

[#127] asks for a "real-time web draft board" in `apps/api` (today a one-line stub). Two things
already decided the shape before this ADR:

1. **[#156] shipped a working localhost board** — a read-only, single-user dashboard the user runs on
   their own machine during their real draft (Playwright/CDP capture → `buildAdviceView` →
   `127.0.0.1` page). It proves the projection and the dashboard UI, but it is local-only and
   read-only; it is not a surface the league can open.
2. **Discord-surface research** (workflow `wf_0bd161cf-25d`, 25 sources, 22/25 confirmed — see the
   [[discord-surface-constraints]] note) established that a dense, real-time, interactive board is
   **only** achievable inside Discord as an **Activity** (Embedded App SDK): classic components and
   Components V2 are too coarse and too capped, and a slash-command-driven board dies at the
   **15-minute interaction token** (a snake draft runs longer). The same research surfaced the hard
   constraints an Activity imposes, which drive every decision here.

The user chose the **Discord Activity** host over a standalone `apps/api` website, so the board lives
where the league already is rather than as one more URL to host and share.

### The binding Activity constraints (from the research)

- All iframe traffic is **proxied through `{clientId}.discordsays.com`**; any unmapped domain fails
  `blocked:csp`. An Activity that needs external data (our engine, later ESPN) must call a **mapped
  backend**, which is exactly what `apps/api` becomes.
- **WebSocket is the only push transport** that survives the proxy sandbox. (This rules out SSE — the
  otherwise-obvious choice for a one-way board feed.)
- Authentication is a **server-side OAuth2** flow: the client runs `ready → authorize` to get a code,
  the **backend** exchanges it for a token using the `client_secret` (which never touches the
  browser), then the client `authenticate`s.
- **Verification only gates servers with >25 members.** A single private league (<25) can run an
  **unverified** Activity with the dev team + ≤50 testers — so this is viable for our league without
  Discord app review.

## Decision

**Build #127 as a Discord Activity, with `apps/api` as the Activity's mapped backend and static
host.** This reconciles the issue's `apps/api` scope with the chosen host: the Activity iframe is
served by, and talks only to, `apps/api`.

Concretely:

- **Transport: WebSocket.** The backend pushes a fresh projection to every connected board on each
  pick; `/api/state` is the pull fallback. Chosen because WS is the only push channel through the
  proxy — building SSE now would mean ripping it out later.
- **Auth: server-side token exchange.** `POST /api/token` exchanges the SDK's OAuth code for an
  access token using `DISCORD_CLIENT_SECRET`, kept server-side. (Endpoint arrives in the SDK phase;
  the secret is a `type:manual` prerequisite.)
- **Reuse over rebuild.** The dashboard runs the same VBD engine as the Discord `/canon draft`
  commands: `buildAdviceView` (+ the view types and `AdpProvenance`) was **lifted from `apps/bot`
  into `packages/core`** in this change so the bot advisor and the Activity backend share one pure
  projection. Session + pick ingestion reuse the `core` `DraftSession` / `diffNewPicks` seam.
- **Pool: ADP-only.** The backend is a separate deploy that won't ship the `research/` archive, so it
  builds its board from the free FantasyFootballCalculator ADP feed alone — the ADP-only path [#156]
  proved yields a full-depth board with zero prep.
- **Read-only / manual-first, consistent with [ADR 0004].** The board never submits an ESPN pick.
  Input is manual entry (`POST /api/pick`) in this phase; wiring [#156]'s read-only capture as a feed
  is a later phase (see below). Nothing here automates a gameplay write.

### What this increment ships (Phase 1 — scaffold)

`apps/api` becomes a real backend, gates green:

- `node:http` server + a `ws` WebSocket server bound to `127.0.0.1` (dev host).
- Pure `routeRequest`: `GET /` (dashboard page), `GET /api/state` (envelope JSON), `POST /api/pick`
  (`{ playerName }` or an idempotent `{ picks: [...] }` board), `POST /api/reset`.
- An in-memory `DraftHub` (session + pool + subscribers) and a self-contained dev dashboard page that
  connects over WS (polling fallback) and has a manual-entry form, so the board is usable standalone
  for mock-draft testing today.
- Unit tests for every pure part (hub, routing, pick parsing, ADP normalize); the socket layer is
  deliberately kept out of Vitest (the Node-24 native-teardown crash from [#156]) and smoke-tested
  instead.

### Remaining phases

| Phase                    | Work                                                                                                                                                            | Blocked on                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **2 — SDK client**       | Bundle a browser client (esbuild) that runs the Embedded App SDK handshake, add `POST /api/token`, route API/WS calls through the `/.proxy` prefix.             | —                                           |
| **3 — Portal + hosting** | Register the Activity in the Discord Developer Portal, enable Activities, map the URL to the host, obtain `client_secret`, deploy the backend to an HTTPS host. | **`type:manual`** (portal + secrets + host) |
| **4 — Live feed**        | Bridge [#156]'s read-only capture into the backend so the Activity can show a real draft, not just typed picks (same `DraftSource` seam).                       | Phase 2/3                                   |

## Consequences

- The board lives **inside Discord**, where the league already is, and escapes the 15-minute
  interaction-token death that limits `/canon draft best|status`.
- Phase 1 is **usable and testable today** as a local manual-entry board; it does not depend on any
  Discord registration, so it can land and be iterated before the manual portal work.
- Going live needs **manual, human-only steps** (portal registration, `client_secret`, an HTTPS
  host) — captured as `type:manual` so they are not mistaken for agent-automatable work.
- The bot's localhost board ([#156]) and this Activity **coexist by design**: the former is a
  read-only capture of the user's own draft; the latter is the shareable, interactive surface. They
  share the `core` engine + projection, not a process.
- **Debt recorded:** the FFC ADP client is duplicated (a trimmed, uncached copy in `apps/api/pool.ts`
  vs the bot's cached `ffcAdp.ts`) — lift it to a shared package when Phase 2 lands. Introducing an
  esbuild client bundle in Phase 2 is a new, contained build step for the browser asset.

## Alternatives considered

- **Standalone `apps/api` website** (plain SSE + HTML, no Discord). Rejected per the user's choice: it
  is not where the league is, still needs hosting + a shared URL, and duplicates auth we would rather
  delegate to Discord. The Activity gets identity + distribution for free.
- **Components V2 message board.** Rejected: even CV2 is capped (40 components / 4000 chars) and is
  not a real-time, per-second interactive surface — the research's explicit "Activity only" case.
- **Keep the [#156] localhost board only.** Viable and zero-infra, but single-user and unshareable;
  it stays as the read-only capture tool, not the league-facing dashboard.
- **SSE for push.** Rejected: blocked by the proxy sandbox (WebSocket-only) — it would not survive the
  move into the iframe.

## References

- Epic [#118]; issues [#127] (this dashboard), [#156] (local read-only advisor, merged), [#59]
  (embeds-vs-CV2 + share).
- [ADR 0004] — automation posture (read-only / manual-first; the board never submits a pick to ESPN).
- Discord-surface research `wf_0bd161cf-25d`; `@discord/embedded-app-sdk` (MIT/TS/ESM); the
  [[discord-surface-constraints]] note.

[#59]: https://github.com/lucasklawrence/fantasy-canon/issues/59
[#118]: https://github.com/lucasklawrence/fantasy-canon/issues/118
[#127]: https://github.com/lucasklawrence/fantasy-canon/issues/127
[#156]: https://github.com/lucasklawrence/fantasy-canon/pull/156
[ADR 0004]: ./0004-espn-draft-data-and-automation.md
