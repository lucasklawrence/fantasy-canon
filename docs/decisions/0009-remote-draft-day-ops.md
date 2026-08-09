# 0009 — Remote draft-day ops: named tunnel on the host PC, not a cloud host

Status: accepted (2026-08-09) · Issue: #246 · Related: #168 Phase B, ADR 0005, ADR 0006

## Context

Learned 2026-08-05: the commissioner will **not be at the host PC** during the late-August draft
window. Until now every piece ran there under direct supervision — bot, api, and a **cloudflared
quick tunnel** started by hand.

Quick tunnels are disqualifying for an unattended window on their own merits: the hostname is a
random `*.trycloudflare.com` that changes on every restart, and they die silently. The Discord
portal URL mapping is set once and cannot be edited from a phone, so a rotating hostname means the
Activity is dead the first time the tunnel blinks. That has already happened once — a morning
hostname simply stopped resolving (2026-08-01 debugging session).

So "stable host" moved from nice-to-have to required, and the real question is _where the stack
lives_.

## Decision

**Keep bot and api on the host PC. Make the host PC survivable.**

1. **Ingress: a named cloudflared tunnel.** Stable hostname, mapped once in the portal, reconnects
   by itself, and runs as a Windows service so it comes back after a reboot. Requires a domain on
   Cloudflare — that is what a public hostname attaches to.
2. **Supervision: Windows Scheduled Tasks** (`scripts/ops/install-tasks.ps1`), triggered `AtStartup`
   and `AtLogOn`, restart-on-failure, `LogonType S4U` so they run without a stored password and
   without enabling auto-login.
3. **Observability: `GET /healthz`** on the api — unauthenticated, side-effect free, and readable
   from a phone. Reports liveness, uptime, stage phase, unanswered in-Activity doorbells, and
   whether the client bundles and config are present.
4. **A written run-of-show** ([`docs/15-draft-day-run-of-show.md`](../15-draft-day-run-of-show.md))
   and a **preflight script** (`scripts/ops/preflight.ps1`) that checks the whole chain before
   departure and again from the road.

The tasks run the same `pnpm run dev` commands used day to day. The bot has no `start` script and
its `dist` entry has never been exercised; adopting an unproven runtime path days before the draft
would trade a known-good setup for an untested one.

## Alternatives considered

**Move bot + api to a cloud host** (fly.io gives a free stable `*.fly.dev` hostname, no domain
purchase). Rejected for this window, not on the merits of hosting but on blast radius:

- The Discord token and the ESPN `ESPN_S2`/`ESPN_SWID` cookies would have to leave the machine and
  become cloud secrets.
- The **pre-reveal seed store** (#176, `.data/draftorder-ceremonies.json`) would need a persistent
  volume. That file holds an undisclosed seed mid-ceremony — it is the one piece of state where
  losing or leaking it has _fairness_ consequences, not just availability ones.
- It is the largest change of the three options, arriving with the least time to shake out, against
  a fixed calendar date and thirteen features already awaiting live validation.

Worth revisiting in the off-season, when a mistake costs nothing. The api is already the easy half:
it holds no ESPN credentials by construction (ADR 0007) and its stage is in-memory with a boot
reconcile (#205).

**ngrok static domain** (~$8/mo, no domain purchase). Equivalent in every operational respect to the
named tunnel, so the deciding factor was cost shape and one fewer vendor in the ceremony's critical
path.

## Consequences

- **The home PC's power and internet are now a single point of failure**, and nothing in this repo
  mitigates that. Supervision covers crashes and reboots; it does not cover an outage. This is
  accepted explicitly rather than papered over.
- **The mitigation is a fallback, not redundancy.** The Tier 1 in-channel ceremony (#164) needs no
  api and no tunnel, and is fully fair on its own — same commitment, same seed disclosure, same
  board. The run-of-show names it as the answer when the host is unreachable. The Activity is the
  deluxe presentation, never the source of truth.
- **Remote access is a prerequisite the repo does not provide.** RDP/Tailscale/similar must be set
  up before departure; without it, a process that supervision cannot recover means falling back.
- **A new unauthenticated route exists.** `/healthz` is deliberately reachable without the stage
  key, because it has to answer precisely when auth or config is broken. It exposes nothing that is
  not already public on the wire: phase and reveal count are in `/api/lottery/state`, and config is
  reported as booleans so a value can never leak through it.
- **`engines: >=24` is now load-bearing.** Preflight fails loudly on an older Node, because
  Node-22+ globals typecheck, pass CI on 24, and throw at runtime on an older host (#228).
