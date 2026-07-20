<!-- draft-archive-summary: {"date":"YYYY-MM-DD","source":"espn-autopick","team":"","slot":0,"leagueId":"","grade":"","score":0,"valueScore":0,"gradedCount":0,"positions":{}} -->

<!--
Entries are generated, not hand-written — run the CLI so the grade, roster table, and the
machine-readable summary comment above stay consistent:

  pnpm archive:draft -- add \
    --date 2026-07-12 --source espn-autopick --team "Lucas's Loud Team" \
    --slot 7 --league 79246808 --season 2026 \
    --players "Amon-Ra St. Brown:WR, Saquon Barkley:RB, …, Eddy Pineiro:K, Seahawks D/ST:DST"

- Players go in draft order (round 1..N); overalls are derived from --slot and league size (snake).
- Label every player's position (Name:POS). It's required for K/DST (never on the research board)
  and keeps the positional-balance + starters report accurate even for players our board doesn't cover.
- --source is one of: espn-autopick | engine | manual (the axis we A/B).
- The value-vs-ADP grade is computed against the committed research boards (no network), so a
  committed entry is reproducible; players off the board show "—" for ADP/value.

Compare all archived drafts:

  pnpm archive:draft -- compare
-->

# <Team> — <YYYY-MM-DD> draft

_<size>-team snake · full-PPR · slot <n> · <source>_

## Grade

**<letter>** (score <n>, value <n> over <n> graded picks)

- Positional balance: WR n · RB n · …
- Starters: n/n starting slots filled
- League: id `<leagueId>` · season <year> · board as-of <date>

## Roster by round

| Rd  | Overall | Player | Pos | ADP | Value | Verdict |
| --- | ------- | ------ | --- | --- | ----- | ------- |

## Steals

## Reaches

## Notes
