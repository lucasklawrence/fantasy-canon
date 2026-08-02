# 0008 — The race visual rides `start`; the reveal order never rides the wire

Date: 2026-08-02 · Status: accepted · Relates to: [0006](0006-draft-order-lottery-fairness-and-surfaces.md), #235, #200

## Context

#235 adds a second ceremony visualization — a 12-lane race over the same sealed draw — beside the
ball machine. Two wire-contract questions had answers that weren't obvious:

1. Where does the mode choice live? It's picked at `begin` (slash option or Activity picker), but
   the thing it configures is what every viewer renders for the whole ceremony.
2. The race's choreography _looks_ direction-dependent (#200): worst-to-first plays as stragglers
   falling off the pace until the winner crosses; first-to-last plays as winners crossing in
   order. `direction` has always been bot-only — does it now have to reach the client?

## Decision

**`visual: 'machine' | 'race'` rides `LotteryStart`**, not per-viewer state: the ceremony is a
shared spectacle (one stage, one crowd), so the choice is part of what the bot opens the stage
with. The begin request carries it as a closed vocabulary (absent ⇒ `machine`, junk ⇒ rejected),
the bot echoes it onto `start`, and an older bot that never sends it degrades to the machine.

**`direction` still never rides the wire.** The race derives each reveal's choreography from
public data alone: a reveal whose pick is the **lowest still-open pick** is a winner crossing the
line; anything else is a racer falling to the back (`raceLanes.lockKind`). Applied per event, this
reproduces both #200 orders with no new wire field — and keeps the ADR 0006 posture exactly:
the client consumes published beats and reveals, and nothing about the presentation requires it
to know anything sooner.

The renderer follows the #211 split: pure, tested lane policy (`raceLanes.ts`) beside an untested
canvas sim (`raceSim.ts`, sprite-cached, rAF-parking, reduced-motion aware — the `hopperSim`
discipline).

## Consequences

- A third visualization is one renderer module plus one vocabulary entry in the parsers and
  pickers; the event stream, playback, catch-up, snapshot, and audio layers are untouched.
- Every viewer renders the same ceremony; per-viewer visual choice stays out (revisit only if
  requested — the issue's "shared spectacle first").
- The client can never diverge by reveal order: any consumer that respects `reveal.pick` renders
  correctly under both directions, including replays and catch-ups that re-run the same events.
