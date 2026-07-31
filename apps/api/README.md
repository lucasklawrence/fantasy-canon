# `@fantasy-canon/api` — draft dashboard backend

The real-time web draft dashboard ([#127]), built to run as a **Discord Activity** with this app as
the Activity's mapped backend + static host. See [ADR 0005](../../docs/decisions/0005-web-draft-dashboard-as-discord-activity.md)
for the host decision and the phased plan.

It runs the **same VBD engine** as the Discord `/canon draft` commands (`buildAdviceView` in
`@fantasy-canon/core`), holds a live draft session, and pushes the best-available projection to the
board over a WebSocket as picks are entered. It is **read-only against ESPN** — it never submits a
pick to ESPN (ADR 0004); manual entry (`POST /api/pick`) only advances the in-memory board.

## Run it (dev / Phase 1)

```bash
pnpm -C apps/api run dev        # loads ADP-only pool, serves http://127.0.0.1:4610
```

Open the printed URL and enter picks in the page, or drive it over HTTP:

```bash
curl -X POST localhost:4610/api/pick -H 'content-type: application/json' -d '{"playerName":"Bijan Robinson"}'
curl -X POST localhost:4610/api/pick -H 'content-type: application/json' \
  -d '{"picks":[{"overall":1,"playerName":"Ja’Marr Chase"},{"overall":2,"playerName":"Bijan Robinson"}]}'
curl localhost:4610/api/state       # current projection (the WS pushes the same shape)
curl -X POST localhost:4610/api/reset
```

Config (env): `FANTASY_LEAGUE_SIZE` (12), `FANTASY_MY_SLOT` (1), `FANTASY_API_PORT` (4610),
`FANTASY_SEASON` (calendar year, for the ADP feed).

## Endpoints

| Route             | Purpose                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `GET /`           | The dashboard page (served inside the Activity iframe in production).                    |
| `GET /api/state`  | Current envelope: `{ view, status, updatedAt }`.                                         |
| `POST /api/pick`  | Enter a pick — `{ playerName }` (next overall) or `{ picks: [...] }` (idempotent board). |
| `POST /api/reset` | Clear the board.                                                                         |
| `WS /api/ws`      | Push channel — a fresh envelope on connect and on every pick.                            |

The lottery-machine stage (#169) adds `/api/lottery/*`. Its POSTs are **bot-only**, guarded by the
`FANTASY_STAGE_KEY` shared secret (`x-stage-key`) — except the two commissioner routes, which take
the Activity's own Discord access token as `Authorization: Bearer …` and resolve it server-side
(ADR 0007). The stage key is never accepted for those, and a bearer is never accepted for a bot route.

| Route                      | Auth                  | Purpose                                                       |
| -------------------------- | --------------------- | ------------------------------------------------------------- |
| `GET /api/lottery/state`   | public                | The shared presentation snapshot; also pushed on WS connect.  |
| `GET /api/lottery/me`      | bearer                | Whether the caller may edit the armed lobby.                  |
| `POST /api/lottery/adjust` | bearer (commissioner) | Nudge one team's ball count in a pre-commitment lobby (#210). |
| `POST /api/lottery/*`      | `x-stage-key`         | `lobby`/`clear`/`start`/`beat`/`reveal`/`finish`/`abort`.     |
| `WS /api/lottery/ws`       | public                | Reveal beats and lobby updates, fanned out to every viewer.   |

## Layout

- `hub.ts` — in-memory `DraftHub` (session + pool + subscribers); the reusable core, no transport.
- `routes.ts` — pure `routeRequest` + `parsePickBody` (unit-tested, no socket).
- `board.ts` — the self-contained dashboard page (WS + polling fallback + manual-entry form).
- `server.ts` — the `node:http` + `ws` shell that applies the routes and broadcasts.
- `pool.ts` — ADP-only pool loader (thin FFC fetch + `core`'s `mergeAdpIntoPool`).
- `index.ts` — entrypoint.

## Not yet wired (see ADR 0005)

Phase 2: the Embedded App SDK handshake + `POST /api/token` (server-side OAuth) + `/.proxy` routing
and an esbuild client bundle. Phase 3 (`type:manual`): Discord Developer Portal registration, URL
mapping, `client_secret`, and an HTTPS host. Phase 4: bridge [#156]'s read-only live capture as a
feed so the board can show a real draft, not just typed picks.

[#127]: https://github.com/lucasklawrence/fantasy-canon/issues/127
[#156]: https://github.com/lucasklawrence/fantasy-canon/pull/156
