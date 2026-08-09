# Draft-day run-of-show — remote commissioner ops

**The constraint this document exists for:** the commissioner is **not at the host PC** during the
draft window. Everything runs on that machine — bot, api, tunnel — and the only interfaces available
from away are Discord (phone), the Activity (phone), and a health URL.

See [ADR 0009](decisions/0009-remote-draft-day-ops.md) for why the stack stays on the home PC rather
than moving to a cloud host.

---

## 0. One-time setup

Do this once, well before the window. Details in
[`scripts/ops/cloudflared-config.example.yml`](../scripts/ops/cloudflared-config.example.yml).

1. **Named tunnel.** `cloudflared tunnel login` → `tunnel create fantasy-canon` →
   `tunnel route dns fantasy-canon <hostname>` → `cloudflared service install`. A named tunnel keeps
   its hostname across restarts; a quick tunnel does not, and the portal mapping cannot be changed
   from a phone.
2. **Portal URL mapping** → `https://<hostname>`, root mapping. Set once, then leave it.
3. **Supervision.** From an elevated PowerShell at the repo root:
   ```powershell
   .\scripts\ops\install-tasks.ps1
   Start-ScheduledTask -TaskName FantasyCanon-Api
   Start-ScheduledTask -TaskName FantasyCanon-Bot
   ```
4. **Uptime monitor** (optional, recommended): point any free monitor at
   `https://<hostname>/healthz` with a 5-minute interval and alerts to your phone. That is the
   difference between finding out at 8:01pm and finding out when twelve people are waiting.

---

## 1. Before you leave town

```powershell
.\scripts\ops\preflight.ps1 -PublicUrl https://<hostname>
```

Everything must be `PASS`. The script explains each failure; the three it cannot check are printed
at the end and are the ones that most often cause an unattended outage:

- **Pause Windows Update** for the whole window. A reboot is survivable — the scheduled tasks bring
  both processes back. A feature update that sits at a "restart to finish" prompt is not.
- **Disable sleep**: `powercfg /change standby-timeout-ac 0`. A sleeping PC is a dead tunnel.
- **Confirm the portal mapping** still points at your hostname.

Then do one **live rehearsal from your phone**, on the couch, with the laptop shut:

- [ ] Open the Activity from Discord mobile — lobby renders, team logos load
- [ ] Commissioner controls appear (you are whoever ran `setup`)
- [ ] Adjust one team's balls, confirm the audit line lands in the channel, then re-import to reset
- [ ] **Seal and start from the phone** (#233), watch a full reveal in both machine and race visuals
- [ ] Replay the finished ceremony
- [ ] Run a `/canon draft` cheat-sheet command from the phone

If the rehearsal works end to end from a phone, lottery night will work.

---

## 2. Lottery night

Everything below is doable from a phone.

| Step | What you do                                                                                                                                     | What to expect                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | Post the launch button — `/canon draftorder setup season:2025` in the lottery channel, or press **Start a lottery** in the idle Activity (#253) | Odds card + `Launch` button post in-channel                                                 |
| 2    | Members open the Activity and gather in the lobby (#198)                                                                                        | Lobby shows every team, ball counts, live odds                                              |
| 3    | Review the bag. Adjust balls / fix names in the commissioner panel (#252) if needed                                                             | Each edit posts an audit line in-channel (or is batched, if you set `auditMode: seal-only`) |
| 4    | **Seal and start** from the commissioner panel — pick delay, direction, visual, ball faces                                                      | Bot posts the commitment, then the full odds card **before** the first ball moves           |
| 5    | Watch                                                                                                                                           | Machine or race reveal, pick by pick, ending with the pick-#1 envelope                      |
| 6    | Bot posts the sealed board + the seed reveal                                                                                                    | Anyone can verify the draw against the commitment                                           |

**The fairness guarantee, in one line:** the commitment is posted before any ball is drawn, and the
seed is disclosed after. Nothing you do from the Activity can change the bag after the commitment —
edits are drained at `begin`, and the bot re-posts the full odds card at that moment (ADR 0006/0007).

---

## 3. When something goes wrong

Diagnose in this order. `https://<hostname>/healthz` answers the first three questions at once.

| Symptom                                 | Check                                                                                     | Fix                                                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activity won't open at all              | `/healthz` unreachable                                                                    | Tunnel or PC is down — see below                                                                                                                          |
| Activity opens, then goes blank         | `/healthz` → `config.lotteryBundle: false`                                                | The client bundle is missing. Someone must run `pnpm -C apps/api run build:client` and restart the api                                                    |
| Buttons do nothing, "not commissioner"  | You are not whoever ran `setup`                                                           | Run `setup` again yourself, from the phone                                                                                                                |
| A button spins then gives up            | `/healthz` → `stage.beginRequested` / `setupRequested` / `reimportRequested` still `true` | The bot isn't answering the doorbell. Its watcher socket is down — restart the bot task. The Activity releases the button with a reason after ~25s (#250) |
| Reveal froze mid-ceremony               | `/healthz` → `stage.phase`                                                                | If the api restarted, the stage is gone; the bot's ceremony continues and re-arms. If the bot died, see below                                             |
| Ceremony interrupted, seed never posted | —                                                                                         | The bot discloses it automatically on next boot (#176). Just get the bot back up                                                                          |

**Getting a process back without being there.** You need remote access to the host (RDP, Tailscale,
Chrome Remote Desktop — set one up _before_ you leave; nothing in this repo provides it). Then:

```powershell
Restart-ScheduledTask -TaskName FantasyCanon-Api    # or -Bot
.\scripts\ops\preflight.ps1 -PublicUrl https://<hostname>
```

If you have no remote access and the PC is unreachable, the ceremony cannot run in the Activity.
**Fall back to the in-channel ceremony** — it needs no api and no tunnel at all:

```
/canon draftorder begin delay:10
```

This is the Tier 1 surface (#164) and it is fully fair on its own: same commitment, same seed
disclosure, same board. The Activity is the deluxe presentation, never the source of truth. Knowing
this is the fallback is the single most useful thing in this document.

**Aborting.** `/canon draftorder abort` before the commitment simply cancels. After the commitment,
the bot still discloses the seed — that is deliberate: a committed draw is public whether or not it
finished, so nobody can re-roll a result they did not like.

---

## 4. ESPN draft day

The lottery decides the order; the draft itself happens in the ESPN app. This stack is a
**second screen** — it never submits a pick (ADR 0004).

- Cheat sheets from the phone: `/canon draft` commands work anywhere Discord does.
- The draft dashboard is the Activity's idle mode — open it and it serves the board (#192).
- Before leaving: confirm `ESPN_LEAGUE_ID` is the current season's league and that `ESPN_S2` /
  `ESPN_SWID` have not expired. ESPN cookies expire; a preflight `PASS` only proves they are _set_,
  not that they still work. Run one real command against the league the day before.

---

## 5. Known gaps

- **Everything depends on the home PC having power and internet.** Supervision handles crashes and
  reboots; it cannot handle an outage. Accepted tradeoff — see ADR 0009.
- **No remote-access tooling ships in this repo.** Set up RDP/Tailscale yourself beforehand.
- **`/healthz` reports the api only.** A dead bot with a live api looks healthy on the health URL;
  the giveaway is a doorbell that stays pending, or reveals that stop arriving.
- **Node version.** The repo declares `engines: >=24` and CI runs 24. If the host is on an older
  Node, preflight fails loudly — fix it before the window, not during it (#228).
