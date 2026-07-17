---
date: 2026-07-17
topic: Discord Activities for a draft-order RNG reveal game — capabilities, build cost, and whether it's overkill
league: { sport: NFL, size: 12, type: snake, roster: redraft, scoring: full-PPR, season: 2026 }
workflow_run_id: wf_46a502c3-6b6
stats: { sources_fetched: 23, claims_extracted: 114, claims_verified: 25, confirmed: 22, refuted: 3 }
sources_trusted: [docs.discord.com, discord.com/developers, github.com/discord, support-dev.discord.com]
---

# Discord Activities for the draft-order RNG reveal
### Platform research (not player research) · run via /deep-research · all Discord doc quotes verified live 2026-07-17

## ⚡ Takeaway
An Activity (Embedded App SDK iframe web app) can absolutely host a lottery-machine/wheel-spin draft-order reveal that the whole league watches together on desktop and mobile — and our bot can launch it from a `/canon` subcommand via the `LAUNCH_ACTIVITY` (type 12) interaction response. But the decisive, verified constraint is **distribution**: an *unverified* Activity is playable **only by the dev team and explicitly invited App Testers** (each must accept an email invite and enable Application Test Mode). The popular belief that a <25-member server alone is enough was **refuted** — the small-server rule is an *additional* restriction on top of tester enrollment, not a substitute. So the full Activity path means enrolling all 12 league members as testers *plus* building hosting, OAuth, and our own state-sync backend for a once-a-year event. Recommended: ship the reveal on existing bot surfaces first (renderer PNG cards / sequential reveal messages + commit-reveal fairness), keep the Activity as the deluxe upgrade if tester enrollment proves painless.

## What an Activity is and where it runs
`confidence: high` (12-0 across 4 merged claims)
- Web app hosted in an **iframe inside the Discord client**; supported on **desktop, web, and mobile** — one web app reaches everyone in the league.
- Mobile availability is **per-app opt-in** (iOS/Android checkboxes in the Developer Portal); web/desktop launchable by default.
- SDK (`@discord/embedded-app-sdk`) actively maintained — v2.5.0, May 2026.

## What the SDK does (and does NOT do)
`confidence: high` (8-1 and 6-0 across merged claims)
- The SDK is the **RPC bridge** between the iframe and the Discord client — it manages the postMessage protocol (commands + event subscriptions); app logic runs after awaiting a `ready()` handshake.
- **No multiplayer game-state sync.** The SDK gives *participant awareness only*: `getInstanceConnectedParticipants()` returns `User[]`, and `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE` fires on join/leave. A shared reveal (everyone sees ball 12, then ball 11…) needs **our own state-sync backend** — Discord's official examples repo points to a **Colyseus** (Node.js WebSocket server) example as the pattern.
- No documented participant cap in the SDK reference; the practical limit per Discord's design-patterns page is voice-channel capacity (design for 25+). A 12-team league fits trivially.

## Participant auth: three-step OAuth2 inside the iframe
`confidence: high` (12-0 across 4 merged claims)
1. After `ready()`, call `discordSdk.commands.authorize()` → OAuth consent modal (tutorial scopes: `identify`, `guilds`, `applications.commands`).
2. Exchange the returned code for an access token **on your own backend** (client secret must stay server-side — no client-only shortcut exists; a search for 2025–2026 changes eliminating the exchange found none).
3. Call `commands.authenticate({access_token})`.
- Adding new scopes later re-prompts users with the OAuth modal.

## Distribution: the decisive constraint ⚠️
`confidence: high` (core claim 3-0; two popular interpretations refuted 1-2 and 0-3)
- Support article, verbatim: an unverified Activity *"is only playable by the team's developers and app testers who are explicitly invited to test it. It can also only be launched in servers with less than 25 members."*
- **Both conditions apply.** Dev team caps at 100, App Testers at 50; each tester must **accept an email invite and enable Application Test Mode** with the App ID.
- Every league member who should join the reveal needs tester or team enrollment. Multiple targeted searches found **no** real-world reports of non-tester server members joining an unverified Activity.
- Verification (which lifts the restriction) is aimed at discovery/App Directory apps; requirements/timeline for a single-server hobby app are an open question below.

## Hosting & networking behind Discord's proxy
`confidence: high` (15-0 across 5 merged claims)
- All Activity traffic routes through Discord's sandboxing proxy at `{clientId}.discordsays.com` (hides participant IPs, blocks known-malicious URLs).
- You must register **public URL mappings** in the Developer Portal to serve the app and reach external hosts. Unmapped external requests — **including those made by third-party npm dependencies** — fail with `blocked:csp`.
- `patchUrlMappings([{prefix:'/foo', target:'foo.com'}])` rewrites fetch/WebSocket/XHR/src to route through the proxy; the app calls its own backend via the `/.proxy/` path convention (e.g. `POST /.proxy/api/token`).
- **fantasy-canon implication:** any ESPN or backend call from the Activity client needs a mapping or must route through our own proxied backend (fits `apps/api`).
- Local dev: the official tutorial uses a `cloudflared` tunnel registered as the URL mapping.

## Launch flows — how the existing bot triggers it
`confidence: high` (6-0 across 2 merged claims)
- Enabling Activities **auto-creates a default Entry Point command named "Launch"** (type 4 `PRIMARY_ENTRY_POINT`, handler `DISCORD_LAUNCH_ACTIVITY`).
- Alternatively, the app can respond to **any command, button, or modal** with callback type **`LAUNCH_ACTIVITY` (type 12)** — so `/canon draftorder` or a "Start the lottery 🎱" button can open it. Confirmed in discord-api-types v10 (`InteractionResponseType.LaunchActivity = 12`) and discord.js core.
- ⚠️ **Deploy-script pitfall** (secondary source, WavePlay "Missing Launch Button"): a bulk command PUT overwrite — like `apps/bot run deploy` — can delete the auto-created Entry Point command. The deploy script must fetch-and-preserve it.

## Bootstrapping effort
`confidence: high` (3-0)
- Official examples repo `discord/embedded-app-sdk-examples` ships a supported **"Discord Activity Starter"**: Node.js (Express/TS) server + Vite client. (README says "React" but the starter is Vite vanilla TS with React/Svelte swappable — stale copy, verified in `packages/client/package.json`.)

## Recommendation (synthesis, not itself a verified claim)
`confidence: medium`
Full Activity path carries four verified costs — tester enrollment for all 12, hosted web app behind proxy/URL-mapping/CSP, OAuth backend with server-side token exchange, and a self-run state-sync server — for a once-a-year event. The minimal viable path (bot-posted animated/sequential reveal via the existing `renderer` package + message components, with a commit-reveal fairness scheme) requires none of them.
1. **Minimal path (build first):** bot-orchestrated reveal in-channel — commit phase (bot posts `sha256(seed)` before the draw), then sequential PNG reveal cards (12th pick → 1st) on regular channel messages (no 15-min token limit), then seed reveal so anyone can re-derive the order.
2. **Deluxe path (optional):** the Activity lottery-machine/wheel — only after confirming all 12 members will accept App Tester invites, and rechecking verification rules at build time.

## ❌ Refuted / killed claims (do NOT act on)
- **"A <25-member server can run an unverified Activity for its members (no tester enrollment needed)"** — vote 1-2. The <25-member rule is an additional restriction on top of the developer/App-Tester requirement. Source: support-dev.discord.com article 26576097154199.
- **"Verification only gates discovery/monetization; a private single-server app has no approval requirement"** — vote 0-3. An open in-server experience effectively requires verification; unverified = testers only. Same source.
- **"Existing draft-lottery tools (dynastylottery.com) omit provably-fair/commit-reveal features"** — vote 1-2. No conclusion about fairness-feature baselines survived.

## 🔴 Caveats
1. **Legs (3) and (4) of the question are thin:** RNG game concepts, commit-reveal schemes, and the head-to-head vs Components V2/GIF reveals produced **no surviving verified claims** — the recommendation rests on the verified cost side plus the repo's existing constraints notes, hence medium confidence.
2. **Platform is actively evolving** (SDK v2.5.0 May 2026, GDC 2026 announcements). Recheck verification-program rules and tester caps before implementation. All doc quotes verified live 2026-07-17 (discord.com URLs 301 → docs.discord.com).
3. "No participant cap" is scoped to the SDK reference; the design-patterns page treats voice-channel capacity as the practical limit.
4. The Colyseus example is community-curated and hosted by Discord, not a formal endorsement.
5. From the fetch pass (single-source, unverified): naive commit-reveal has a **last-revealer bias** attack (a16z) — for our case a single bot-side commit (hash posted before the draw) avoids multi-party reveal issues entirely.

## Open questions / follow-ups
- How much real-world friction is App Tester enrollment for 12 non-technical league members, and is the 50-tester list stable year over year?
- Current requirements/timeline/feasibility of Activity verification for a single-server hobby app — would it lift the tester restriction without discovery/monetization obligations?
- What commit-reveal or provably-fair presentation would league members actually trust, and how should the bot present it? (No claims survived verification.)
- Can a suspenseful multi-stage reveal live within simpler surfaces given the 15-minute interaction-token and ephemeral limits — where exactly do those force compromises? (Known fix from prior research: drive it from regular channel messages, not interaction responses.)

## Sources
**Primary (Discord official)**
- https://discord.com/developers/docs/activities/overview
- https://docs.discord.com/developers/activities/how-activities-work
- https://docs.discord.com/developers/activities/building-an-activity
- https://discord.com/developers/docs/developer-tools/embedded-app-sdk
- https://github.com/discord/embedded-app-sdk (+ patch-url-mappings.md)
- https://github.com/discord/embedded-app-sdk-examples
- https://docs.discord.com/developers/activities/development-guides/multiplayer-experience
- https://docs.discord.com/developers/activities/development-guides/networking
- https://support-dev.discord.com/hc/en-us/articles/26576097154199 (Verified vs Unverified Activities)
- https://support-dev.discord.com/hc/en-us/articles/30931736489623 (How users discover/play an Activity)
- https://docs.discord.com/developers/interactions/receiving-and-responding
- https://docs.discord.com/developers/components/reference

**Secondary / practitioner**
- https://robojs.dev/discord-activities/proxy
- https://colyseus.io/blog/discord-embedded-sdk/
- https://dev.to/waveplay/how-to-add-multiplayer-to-your-discord-activity-lo1
- https://blog.waveplay.com/discord-activity-entry-point-fix/
- https://chipsoffury.com/blog/discord-activity/
- https://discordjs.guide/slash-commands/response-methods

**Domain (draft lotteries / fairness)**
- https://www.footballguys.com/article/2024-draft-order-determination-commissioners-guide
- https://dynastylottery.com/ · https://www.fantasyleaguelottery.com/fantasy-football-draft-lottery · https://fandraft.com/blog/methods-to-determine-your-fantasy-football-draft-order
- https://a16zcrypto.com/posts/article/public-randomness-and-randomness-beacons/ · https://blockrand.net/
