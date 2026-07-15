# 0004 — ESPN live-draft data strategy & automation posture

## Status

**Proposed.** Drafted alongside the draft-assistant epic ([#118]); records the data strategy and the
automation/ToS risk posture **before** the risky tiers (#126 live capture, #128 auto-pick) are built.
To be moved to **Accepted** once the mock-draft capture spike (#126) is formalized and any findings are
folded in. Gates #126 and #128; referenced by #128 (auto-pick) and #126 (capture).

## Context

The draft assistant surfaces the **best available player** during a live ESPN draft, laddered as
cheat-sheet → live session → grade → live board → post-draft import (all shipped) → live auto-ingestion
(#126) → auto-pick (#128). Two load-bearing facts shape every tier and must not have to be
rediscovered:

**1. There is no live ESPN draft API.** (Research run `wf_178b6f25-c34`, 25/25 claims confirmed;
corroborated by the `espn-api` project, issue #558.)

- `mDraftDetail` populates **only after the draft finishes** — it is a post-draft record, not a live
  feed.
- The live draft room uses a **separate, undocumented push transport** (a WebSocket opened at page
  load), not the public read endpoints.
- The only **proven** live read is **DOM scraping** of the draft-room page.
- There is **no known pick-submission endpoint** — submitting a pick programmatically would mean
  reverse-engineering the socket protocol.

**2. Automating a real ESPN account is a Terms-of-Use risk.** ESPN is a Disney property; the Disney/ESPN
Terms of Use prohibit automated access ("no bots / automated means") and reverse-engineering. Acting on
a real account through automation therefore risks **account-level suspension** — which would take the
user's league membership, history, and standing with it.

**Enforcement evidence is thinner than the policy, and worth recording honestly** so future
contributors calibrate correctly rather than over- or under-reacting:

- Documented ESPN fantasy bans are for **conduct** (threatening/offensive messages to other managers),
  **not** for automation. No documented case of a ban specifically for scripting/API/automation was
  found.
- **Read-only** automation is openly tolerated in practice: widely-used third-party bots (scoreboards,
  power rankings, trade alerts posted to Discord/Slack/GroupMe) hit the same unofficial endpoints
  without a visible pattern of bans.
- ESPN itself ships an official autopick ("Auto Control (AI)"), so autodrafting is not inherently
  forbidden — doing it via **your own** automation/reverse-engineering is what the ToU targets.
- Risk **scales with how write-like and bot-like** the action is: reading data ESPN already exposes is
  low practical risk; a script that _makes picks_ is the exposed end, and the transport (REST vs. a
  browser clicking DOM buttons) does not change the ToU category — only how detectable it is.

## Decision — data strategy

The engine's value inputs and live inputs are decoupled from the risky transport:

- **Value inputs:** our `research/*.md` ranking tiers (a derived `## Draft board` table per report) +
  FantasyFootballCalculator free ADP, merged into one pool (`core/rankings/`, ADR-independent, shipped).
- **Real-draft import & validation:** post-draft **`mDraftDetail`** ingestion (#125, shipped) — fetch a
  finished draft, resolve player names, and replay it through the session to validate best-available
  end-to-end. Reads data ESPN already exposes; **no automation of gameplay**.
- **Live MVP input: manual pick entry.** `/canon draft start | pick | best | status` already gives live
  best-available by typing picks as they land — **zero ToS risk**, works with any draft (mock or real,
  ESPN or elsewhere).
- **Live auto-ingestion is deferred to #126** and, when built, is **read-only DOM observation** (or a
  page-injected WebSocket tap) that feeds the advisor — it never submits a pick.

## Decision — automation posture

A three-tier ladder with **one hard line**:

> **Never automate a gameplay write-action (submitting a pick, roster move, or message) against a real
> ESPN account.** A human makes every real-account gameplay action.

| Tier                                   | What it does                                                                                                                             | ToS risk                          | Where it runs                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **A — Advisor (default, the product)** | Compute + display best-available; **the human clicks**. Input via manual entry or data ESPN already exposes (post-draft import).         | **None**                          | Any account, real or mock                                                                                                   |
| **B — Read-only live capture**         | Observe the live board (DOM scrape / injected WS read) to feed the advisor so the user doesn't type picks. **Reads only, never writes.** | **Low / grey** (automated _read_) | Mock drafts by default; real league only behind explicit user opt-in                                                        |
| **C — Auto-pick**                      | The tool _makes_ picks (browser-driven clicks or a reverse-engineered submit).                                                           | **Higher, contained**             | **Mock drafts only, on a throwaway ESPN account, behind explicit per-run opt-in.** Never the user's real league or account. |

Constraints that make the ladder concrete:

- **Tier A is the product.** Everything the assistant is _for_ — value-based best-available, reach/wait,
  grading — lives here and carries no ToS risk.
- **Tier B stays read-only.** The capture adapter is interchangeable with `ManualDraftSource` behind the
  `DraftSource` seam; it emits picks it _observed_, never picks it _made_.
- **Tier C is opt-in, mock-only, throwaway-account-only.** Rationale: it exercises the auto-pick loop
  and lets us measure it against our **own** self-computed grade (ESPN mocks show no grade — see #128),
  while isolating any ban to a disposable account with nothing real attached. Account creation is the
  **user's** manual step (the assistant never creates accounts or handles credentials). Keep the
  throwaway genuinely separate (distinct email, no shared payment) since account linking by
  device/IP/email is possible in principle.
- **No reverse-engineered writes against a real account, ever** — not behind a flag, not "just once."

## Consequences

- The shipped assistant (Tiers A + post-draft import) is **fully usable on the user's real league today**
  with zero ToS exposure — the safe path is not a degraded path.
- #126 (capture) is scoped as **read-only** work; #128 (auto-pick) inherits a hard "mocks + throwaway +
  opt-in" boundary and cannot be pointed at a real account by design/review.
- Contributors have a written line to hold: PRs that would submit a real-account gameplay action are
  rejected on posture, not re-litigated.
- The assistant's success metric for auto-pick is our **own** value/grade engine, not an ESPN grade
  (mocks don't grade) — which is the more reproducible artifact anyway.

## Alternatives considered

- **Reverse-engineer the live socket + pick-submit for a real account** (full autonomy). Rejected as the
  default: highest ToS/ban exposure, most brittle (undocumented protocol), and unnecessary — the advisor
  delivers the value without it.
- **DOM observation on the real league by default** (Tier B always-on). Rejected as a default: an
  automated read is still a grey area; make it opt-in and mock-first, so the zero-risk manual path is
  always the fallback.
- **Manual entry only, drop capture/auto-pick entirely.** Viable and safest, but forecloses the
  learning value of the (contained, mock-only) auto-pick experiment; kept as Tier C behind strong
  guardrails rather than banned outright.

## References

- Epic [#118]; issues #125 (post-draft import, shipped), #126 (capture spike), #128 (auto-pick).
- Research run `wf_178b6f25-c34` (no-live-API constraint, 25/25 confirmed); `espn-api` issue #558.
- ESPN Terms of Use / Fan Support (conduct-based enforcement); "Auto Control (AI)" official autopick.

[#118]: https://github.com/lucasklawrence/fantasy-canon/issues/118
