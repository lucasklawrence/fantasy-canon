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

> **Amended again by #219 (2026-07-31).** Editing now covers display names and an ESPN re-import,
> which forces two refinements.
>
> **Renaming needs no new fairness argument.** `commitmentPreimage` hashes the algorithm tag, the
> seed, `baseBallCount`, and per-team `{ teamId, balls }` — display names are absent. A rename
> therefore cannot change what a commitment binds, so it rides the same pending-delta channel as the
> ball edits and drains at the same `begin`. Uniqueness is enforced twice, because the two sides
> know different things: the stage rejects a name another _row_ already holds (so the league never
> sees a name the ceremony would choke on), and `applyLobbyRenames` re-checks against the _session_
> and refuses the batch atomically, since that map is the authority `createCeremony` validates.
>
> **Re-import is the one place the watcher mutates, and that is deliberate.** The api has no league
> config and no ESPN cookies, so `POST /api/lottery/reimport` can only raise a flag; the bot's
> watcher performs the refetch, publishes a fresh public odds preview, and re-arms the lobby. That
> makes #220's "read-only" claim precise rather than absolute: the watcher is read-only **for
> edits**, and re-import is a second, named responsibility. It stays outside the fairness path for
> the same reason `setup` does — the bag it produces is published in-channel and then drained at
> `begin` like any other.
>
> Consequences accepted: a re-import **discards every pending edit**, because a ball count or a
> rename made against the roster it replaces is stale; the re-arm therefore carries no
> `keepAdjustments`. The league id and season are stamped onto the session at `setup` and re-used
> verbatim, so a re-import can never silently retarget a different league than the one the ceremony
> opened — and a manual `teams:` setup, which has no league id, is refused outright. The watcher
> guards one in-flight import per guild so a broadcast storm or a reconnect snapshot cannot launch
> a second ESPN refetch.
>
> Finally, the client's ball cap is now **injected by the page shell** from core's `MAX_TEAM_BALLS`
> rather than hand-copied. The bundle cannot import core (it reaches `node:crypto` — see the
> `lotteryTypes.ts` note), and a second literal would drift silently from the value the server
> enforces.

> **Amendment (#253, 2026-08-08) — setup from a dead-idle stage.** The one press §3's
> lobby-scoped authority cannot cover: at idle there is no lobby and therefore nobody stamped.
> The anchor becomes the slash command's own gate, relocated: `POST /api/lottery/setup-request`
> records verified identity (§1's bearer flow) plus intent — the SDK-reported guild and a season
> — and the **bot** verifies that the presser holds _Manage Server in that guild_ against
> Discord before running the exact slash-`setup` flow (ESPN import, standings weights, public
> odds preview, lobby arm — which stamps the presser as commissioner per §2 and answers the
> doorbell). A forged guildId buys nothing: it only redirects the permission check to a guild
> where the presser must genuinely hold Manage Server, and the ceremony then belongs there.
>
> The doorbell has no channel of its own, so the bot anchors the preview to the guild's
> **remembered lottery channel** (`draftorder-channels.json`, written on every successful setup);
> with no memo the press is refused with guidance to run the slash setup once. Every refusal
> **releases** the request with a reason the idle screens show one time (`setupDenied`) — the
> #236 rule, extended: a denied press must never strand every viewer's start button. One press
> may be pending at a time (a second 409s), and the watcher single-flights per guild, which
> bounds the Discord permission checks a spammer can induce.

> **Amendment (#250, 2026-08-08) — a doorbell nobody answers must still ring back.** The #236
> release rule now covers all three request flags, and re-import completes the set:
> `POST /api/lottery/reimport-release` (bot-keyed, like `setup-release`) clears the flag and
> carries a reason the lobby shows once as `reimportDenied`. Crucially it is **not** a re-arm —
> the refetch never happened, so the bag and its pending edits must survive. The "a re-import
> discards every pending edit" consequence above only ever applied to an import that _succeeded_.
> The bot releases on every refusal it can name (no ESPN league behind the ceremony, an
> unreachable channel, an ESPN failure, a roster that cannot produce exact odds, a preview that
> would not post) and also when the import landed but the re-arm did not — the one case where the
> channel line must not claim the bag is unchanged.
>
> The remaining gap is the one the live incident actually hit: a press the **bot never heard**,
> because its stage watcher was disconnected. Nothing bot-side can release that, so two cheap
> signals cover it instead. The request carries a **stamp** (`reimportRequestedAt`) that changes
> per press; a client measures elapsed time from when _it_ first saw that token — never by
> subtracting the server's clock from its own, since a phone and the host can disagree by minutes
> — and after ~25s says "no response from the bot" and hands back that one button so a retry is
> possible. The rest of the lobby stays frozen on server truth, because a slow import is
> indistinguishable from an absent one, and a `begin` recorded while `reimportRequested` still
> stands is suppressed watcher-side with nothing to release it. Bot-side, the watcher now logs on
> socket drop (naming the retry delay) and on recovery: while it is down every in-Activity press
> goes unheard, and that silence was previously invisible from every surface.
