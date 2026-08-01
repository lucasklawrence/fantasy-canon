# 0007 — Commissioner writes from inside the Activity: identity, authority, and the bag drain

## Status

Accepted. Records the load-bearing decisions of #210 (review + adjust the imported field from
inside the Activity). Extends ADR 0005 (the Activity backend seam) and operates strictly inside the
fairness boundary ADR 0006 draws.

## Context

`/canon draftorder setup` already imports the league from ESPN and derives ball weights from last
season's standings (#164/#165), and #201 arms the Activity lobby from `setup` onward — so the
league can already _see_ the imported field in the Activity. What it could not do was change it:
fixing one team's ball count meant re-running `setup` with a `balls:` override string.

Making the lobby editable is a handful of steppers on rows that already render. The real work is
that it is the **first write path into the backend that does not come from the bot**, and it lands
on data a commitment is about to bind. Three problems had to be solved together:

1. **The existing auth path cannot be reused.** `POST /api/lottery/*` is guarded by `x-stage-key`
   (`FANTASY_STAGE_KEY`), a server-side shared secret. The Activity client is public code shipped
   to every viewer's browser; putting that key in it would hand every member the bot's write
   authority over the reveal.
2. **The api had no notion of identity.** The #187 handshake (`ready → authorize → POST /api/token
→ authenticate`) obtains a Discord access token with scope `identify`, but the backend handed it
   straight back to the client and never used it. Nothing server-side knew who was calling.
3. **The bot owns the authoritative bag.** The `CeremonySession` in the bot's memory is what
   `begin` commits. The api's stage is a presentation relay. An edit that changed only the stage
   would make the published odds diverge from the committed bag — the exact failure ADR 0006's
   "any bag change after a preview requires a fresh public preview" rule exists to prevent.

## Decision

### 1. Identity comes from Discord, server-side, per request

A commissioner write presents its Discord access token as `Authorization: Bearer …`. The backend
resolves it with `GET /users/@me` (`fetchDiscordUser`, injectable `fetch` like the rest of
`token.ts`) and derives the user id **from Discord's answer**. The client never supplies a user id
in a body or query — a public iframe supplying its own identity is a self-service commissioner
badge.

Successful lookups are cached for 60 seconds, bounded at 500 entries, in the server shell (not the
pure router). Each stepper tap is an authorized write, and re-asking Discord on every tap burns
rate limit for no new information; a minute is short enough that a revoked token stops working
promptly. Failures are never cached — a denial must be re-attempted, not remembered.

The two auth paths stay **disjoint**: a stage key is never accepted for a commissioner route, and a
bearer is never accepted for a bot route.

### 2. The commissioner is whoever ran `setup`

The bot stamps `commissionerIds: [interaction.user.id]` onto the lobby it arms. That member already
passed the `ManageGuild` gate on `/canon draftorder setup`, so the authority is derived from a
check Discord already made, in the process that can make it.

Rejected alternatives:

- **Any `ManageGuild` member.** Matches the slash-command gate exactly, but the api would need a
  bot token to read guild member permissions — a new capability, and a second copy of the bot's
  credentials in a publicly-reachable process.
- **A league-config allowlist.** `packages/db` is still a `NoopDbClient`, so this means inventing a
  new env var or file for a list that is one id long in practice.

The id list is **never broadcast**. It is stripped from the lobby before fan-out (the same
request-vs-broadcast split `LotteryAbortRequest` already uses), and the client learns its own
status from `GET /api/lottery/me` rather than by reading a list.

### 3. Authority is lobby-scoped, and edits die with the lobby

`isCommissioner` is false unless an armed lobby is on screen. Every transition that leaves the
lobby phase — `clear`, `start`, `beat`, `reveal`, `finish`, `abort` — drops the commissioner list
and any pending edits together. An adjustment that outlived its lobby could be drained into a bag
the commissioner never saw it against; a lingering id list would keep a write path open over a
committed run.

This is what keeps #210 inside ADR 0006's fairness argument: **everything editable here is
pre-commitment**, and the commitment binds at `begin`.

### 4. The bot drains; the api never calls the bot

The stage records each edit as a pending `{ teamId, balls }` delta and recomputes the odds table
with core's `computePickOdds` — the same function behind the bot's odds card, so the table the
league watches is arithmetically identical to what the bot would publish for that bag. The edit
fans out over the WebSocket that already carries lobby state.

The bot then **pulls** those deltas at `begin`, folds them into its session, and posts a fresh
public odds card naming each change before the commitment. HTTP stays one-directional (bot → api):
no listener on the bot, no port, no second shared secret.

Consequences of the pull model, accepted deliberately:

- **`begin` is the single drain point.** The mini-game's lobby re-arm therefore sends
  `keepAdjustments: true`, so rows derived from a not-yet-drained session don't silently revert the
  commissioner's edits in front of everyone watching. A plain `setup` re-arm drops them — a new bag
  makes old edits meaningless.
- **An edit landing between the drain and `start` is discarded**, not applied to a sealed bag.
  `start` clears pending edits, and its broadcast immediately repaints the Activity with the
  committed bag. The window is milliseconds and the commissioner is the one clicking both.
- **An unreachable stage does not block a ceremony.** `begin` commits the bag as `setup` left it
  and tells the commissioner — the one case where what they saw and what gets committed can differ.

### 5. The channel stays the audit trail

An in-Activity edit surfaces in Discord as the fresh odds preview posted at `begin`, listing each
change (`Bravo: 1 → 4 ball(s)`). This satisfies ADR 0006's post-change-preview rule exactly and
keeps "the Discord posts are the record" true without a live api → bot channel. Members who never
open the Activity still see the bag the commitment binds, named team by team, before it binds.

A per-edit live channel post would be a stronger trail but requires the bot to subscribe to the
stage — deferred, not dropped.

> **Amended by #220 (2026-07-31).** The gap this left — the channel showing the _original_ preview
> for however many days sit between an edit and `begin` — was judged worth closing, so the bot now
> does subscribe. `apps/bot/src/lib/lotteryStageWatcher.ts` opens an **outbound** WebSocket to
> `/api/lottery/ws` (backoff to a 60s ceiling; the bot still exposes no inbound surface) and posts
> one line per edit to the channel where `setup` ran.
>
> Two things did **not** change, deliberately. The watcher is **read-only**: it never touches a
> `CeremonySession`, so `begin` remains the single authoritative drain (Decision 4 stands, and
> `keepAdjustments` stays). And the `begin` preview still posts in full — the live lines are an
> addition to the audit trail, not a replacement, so a ceremony whose socket was down the whole
> time still commits a bag published in-channel first.
>
> The edit detail rides on the existing `lottery-lobby` broadcast as an `adjusted` field rather
> than a new event type: the bot needs to tell a human edit from a bot-driven re-arm, and diffing
> two lobbies to recover that is both fragile and unable to name the previous ball count. Routing
> is guarded twice — the stage stamps the lobby's `guildId` onto the detail, and the bot only posts
> if _this_ process holds a `GAME_OPEN` ceremony for that guild, so a stale lobby on the shared
> process-wide stage (#191) can never make the bot post into a league it isn't running.

## Consequences

- `LotteryOddsRow` gains an optional `teamId`. A lobby armed without ids is not editable: display
  names are renameable, so targeting an edit by name is ambiguous the moment two rows collide.
- The per-team ball cap moved to `packages/core` as `MAX_TEAM_BALLS`. The bot's `balls:` override
  and the in-Activity stepper are two surfaces onto the same domain rule and must not drift.
- `handleDraftOrderBeginSubcommand` takes an injectable stage, matching
  `recoverInterruptedCeremonies` — the drain is an awaited network read, and tests must not open a
  socket.
- Editing is scoped to ball counts. Renaming a team and re-importing from ESPN both need paths the
  api does not have (name propagation into `session.names`; ESPN league config and cookies) and are
  tracked separately.
- Nothing here touches a committed or live run, so the epic's fairness story (ADR 0006) is
  unchanged: the commitment still binds a bag that was published in the channel first.
