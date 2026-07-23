---
date: 2026-07-23
topic: policy decision — rookie / young-TE ADP (trust vs. deliberate fade)
league: { sport: NFL, size: 12, type: snake, roster: redraft, scoring: full-PPR, season: 2026 }
workflow_run_id: n/a (synthesis of prior reports, not a new deep-research run)
stats: { sources_fetched: 0, claims_extracted: 0, claims_verified: 0, confirmed: 0, refuted: 0 }
sources_trusted: [internal research archive]
---

# Rookie / young-TE ADP policy — trust vs. deliberate fade (#152)

### 12-team snake · redraft · full-PPR · a decision record, not new web research

## ⚡ Decision

**Deliberately fade hype-driven early-career TE ADP; trust it only for a locked every-down role.**
Fades are display-only FADE chips on `/canon draft cheatsheet` — this does **not** change the
ADP-faithful `bestAvailable` ranking (per #152's design), it just warns the human drafter not to
pay the market's round for an unproven tight end.

## Why (synthesis of the existing archive — no new sources)

- **Early-career TEs underperform their draft cost, and TE is a stream-late position on our board.**
  The mid-round report's takeaway is explicit: "stream QB and TE late." Paying a mid-round pick for
  a young TE's upside fights that.
- **We already fade one young TE on exactly this logic.** [Colston Loveland](2026-07-12-2026-midround-tiers-rookies-fades.md)
  (TE, ADP ~33 / TE3) is an adversarially-confirmed fade (vote 3-0): target competition unpriced at
  his cost, boom/bust median. The policy generalizes that one-off into a rule.
- **True 2026 rookie TEs are not an early-round consideration** — the mid-round report's rookie
  pecking order finds the only true 2026 rookie worth an early pick is Jeremiyah Love (an RB); no
  rookie TE is priced as a startable asset. The market already prices them out, so there is nothing
  to fade there; "trust the market" = don't draft them.
- **The #152 trigger — Harold Fannin Jr. (TE, CLE)** — is on the board at ADP ~78 as a "streaming
  tier" talent (his market ADP has ranged ~68–78). He is not a bust to avoid; he is a streamer whose
  ADP occasionally creeps into startable-TE range. A **medium-confidence** FADE chip says exactly
  that: take him at true streaming cost, not the Rounds 6–7 (picks ~68–78) market price.

## What changed

- Added **Harold Fannin (TE, ADP 78, medium)** to the Fades table in
  [`2026-07-12-2026-midround-tiers-rookies-fades.md`](2026-07-12-2026-midround-tiers-rookies-fades.md)
  — the single canonical Fades table the engine reads (fades only surface from a report that also
  carries a draft board, so the entry lives there, not here).
- **Kept** the Loveland fade; **left `bestAvailable` unchanged.**

## Scope / caveats

- **Do not fade proven young TEs with a locked role** (Brock Bowers / Sam LaPorta tier) — that ADP
  is earned, not hype.
- ADP is time-sensitive; Fannin's market has moved ~68→78. Re-pull before the draft — if he settles
  clearly into streaming range on its own, the chip is redundant but harmless.
- This is a **synthesis of the existing archive**, not a fresh fact-checked deep-research run. If the
  league wants current, verified rookie-TE numbers, run `/fantasy-research` scoped to tight ends.

## Sources

Internal research archive (no new web sources):

- [`2026-07-12-2026-midround-tiers-rookies-fades.md`](2026-07-12-2026-midround-tiers-rookies-fades.md) — the confirmed Loveland fade, the rookie pecking order, and the Fannin board row
