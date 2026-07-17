# 0006 — Draft-order lottery: commit-reveal fairness, ceremony surface, and MVP audit stance

## Status

Accepted. Records the load-bearing decisions of the draft-order lottery epic (#160) so its child
issues cite this ADR instead of re-quoting the research report. Numbered 0006 because 0004 and 0005
are claimed on the unmerged `feat/127-draft-activity` branch (#127). This ADR also **corrects a
claim in ADR 0005** (see Decision 4); a follow-up comment on #127 tracks amending that ADR when its
branch merges.

## Context

The league determines draft order once a year. Epic #160 turns that into a ritual: a
**ping-pong-ball lottery ceremony** run by the bot in the league's channel — odds published ahead,
a suspenseful worst-to-first reveal, and a result every member can verify. The product vision comes
from the stale `draftOrder` branch (`docs/draftOrder/00`–`09`, condensed here so those docs can
retire with the branch):

- Every team holds at least one ball; weighting (more balls for a worse finish) and optional
  **mini-games that award bonus balls** (reaction-time MVP: rank 1 → +2, rank 2 → +1) happen
  **before** the draw.
- Draws are **deterministic**: `sha256(seed:drawIndex)` → first 4 digest bytes as a big-endian
  uint32 → `% bagSize`, over a ball bag encoded as `teamId:ballNumber` — fully replayable from the
  seed (branch `packages/core/src/draftOrder/rng.ts`, ported by #162).
- A ceremony session walks a small state machine (`CREATED → GAME_OPEN → LOTTERY_RUNNING →
FINALIZED`, with `CANCELLED`/`EXPIRED` exits).

Three hard constraints shape where and how this runs, established by the 2026-07-17 deep-research
report ([`research/2026-07-17-discord-activities-draft-order-rng.md`](../../research/2026-07-17-discord-activities-draft-order-rng.md),
run `wf_46a502c3-6b6`, 22/25 claims confirmed) and the earlier Discord-surface research:

1. **Interaction limits.** Interaction tokens die after 15 minutes (initial ack within 3 s), and an
   ephemeral message can never become public. A paced multi-message ceremony cannot live on
   interaction responses.
2. **Activity distribution.** An unverified Discord Activity is playable **only by the app's dev
   team and explicitly invited App Testers** (each must accept an email invite and enable
   Application Test Mode). All 12 league members would need enrollment before an Activity reveal is
   usable (verified 3-0; see also the refuted-claims section below).
3. **No live database.** `packages/db` on `main` is a `NoopDbClient` placeholder — the branch's
   event-sourced Postgres design cannot be a hard dependency.

## Decision

### 1. Fairness: single bot-side commit-reveal

The bot generates a secret seed, posts its **`sha256(seed)` commitment publicly before any draw**
(locking the ball bag and the published odds), runs the deterministic draw, and **reveals the seed
after the final pick** together with plain-language verification instructions. Anyone can recompute
the full order from the revealed seed and the committed configuration (`verifyDraw` in #162).

A **single committer** is deliberate: multi-party commit-reveal schemes suffer last-revealer bias
(the final revealer can withhold to abort an unfavorable outcome — a16z, single-source caveat in
the report). With one committer that commits before anything is drawn, there is nothing to withhold
and no party to bias the result after the commitment. The scheme is research **synthesis** (medium
confidence), but each component — the deterministic draw, the hash commitment — is simple, and the
whole protocol is auditable by any league member. Bonus-ball results (mini-games, #166) must be
posted publicly **before** the commitment so the hash commits to the final bag.

### 2. Surface: regular channel messages now; the Activity is an optional, gated deluxe tier

The ceremony runs on **regular bot-token channel messages** (postable and editable indefinitely);
slash commands and buttons only acknowledge and hand off. This is forced by constraint 1 and is the
MVP for the whole epic: renderer PNG cards on channel posts (#163, #164), presentation informed by
the embeds-vs-Components-V2 decision in #59.

The Embedded App SDK "lottery machine" Activity (#169) is a **presentation-only deluxe tier**,
gated on the App-Tester go/no-go in #168 (constraint 2) and on #127's `apps/api` Activity backend
seam. It renders server-pushed reveal beats over WebSocket and never draws anything itself; the
bot's in-channel commitment, board, and seed-reveal posts happen regardless, so members not in the
Activity audit the same draw. For a once-a-year event, enrollment friction may legitimately kill
this tier — the ceremony must never depend on it.

### 3. MVP audit trail: the public Discord posts

The commitment post, the sequential reveal posts, and the seed-reveal post **are** the audit trail:
public, timestamped, ordered, and verifiable against the revealed seed. No database writes in the
MVP (constraint 3). The branch's event-sourced design (`packages/db/src/draftOrder`, migration
`20260125_draft_order.sql`) is **deferred, not dropped** — it becomes worthwhile only when a real
db client replaces the Noop placeholder, and is recorded in the epic as future work.

### 4. Correction of ADR 0005's verification claim

ADR 0005 (on `feat/127-draft-activity`) asserts that Activity _"verification only gates servers
with >25 members"_ and that an unverified Activity is therefore _"viable for our league without
Discord app review."_ The 2026-07-17 research **refuted** this interpretation: the sub-25-member
rule is an _additional_ restriction on top of the dev-team/App-Tester requirement, not a substitute
for it. The corrected reality is constraint 2 above. ADR 0005 should be amended when its branch
merges (tracked as a follow-up on #127); its architectural decisions (WebSocket-only push,
server-side OAuth token exchange, `apps/api` as the mapped backend) are unaffected and remain the
seam #169 reuses.

## Refuted claims — do not act on these

From the research report's verification pass. Listed so no future issue re-imports them:

1. **"A <25-member server can run an unverified Activity for its members."** Refuted — App Tester
   (or dev-team) enrollment is required for every participant; the small-server rule is an
   additional restriction.
2. **"Verification only gates discovery/monetization; a private single-server app has no approval
   requirement."** Refuted — an open in-server experience effectively requires verification;
   unverified means testers only.
3. **"Existing draft-lottery tools omit provably-fair/commit-reveal features."** Did not survive
   verification — no conclusion about fairness-feature baselines in existing tools.

## Consequences

- Tier 0/1 of #160 (#162 engine port, #163 cards, #164 ceremony) ship with **zero** Activity
  infrastructure, no OAuth, no hosting, and no database — the fairness story is complete without
  them.
- The seed is secret until reveal and **never reused**: a crashed or aborted ceremony re-runs with
  a fresh commitment; a committed seed is never carried into a second attempt after a partial
  reveal.
- Publishing odds (hype posts, #165) is safe only if the published bag is byte-identical to the bag
  the commitment locks; any bag change after a preview requires a fresh public preview before the
  commit post.
- The Activity tier's fate is an ops outcome (#168), not an engineering one; if it is a no-go, #169
  closes with a pointer to the epic, and nothing else in the epic changes.
- When `feat/127-draft-activity` merges, ADR 0005 gets a correction note referencing this ADR
  (follow-up tracked on #127).
