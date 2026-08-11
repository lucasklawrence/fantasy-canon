# Lottery night — rehearsal and run-of-show

**The constraint this document exists for:** the draft-order lottery is a **live, one-shot event**
with the whole league watching, and its fairness story depends on things happening in a particular
order. Unlike the draft ([`15-draft-day-run-of-show.md`](15-draft-day-run-of-show.md)), the
commissioner is _at the machine_ — so this is about getting the ceremony right, not about surviving
being away from it.

See [ADR 0006](decisions/0006-draft-order-lottery-fairness-and-surfaces.md) for the fairness model
and [ADR 0007](decisions/0007-activity-commissioner-writes.md) for who is allowed to change what.

---

## 1. Two surfaces, and choosing between them

|                         | Needs                                                             | Everyone sees it?     |
| ----------------------- | ----------------------------------------------------------------- | --------------------- |
| **In-channel** (Tier 1) | nothing beyond the bot                                            | yes                   |
| **Activity** (Tier 3)   | every member enrolled as an App Tester, plus a public URL mapping | only enrolled members |

The Activity is the deluxe surface, and its gate is human, not technical: an unverified Discord
Activity is playable **only by the dev team and explicitly invited App Testers**, and each member
must accept an email invite _and_ enable Application Test Mode with the App ID. That is days of
chasing people, not an afternoon — see [#168](https://github.com/lucasklawrence/fantasy-canon/issues/168).

The in-channel ceremony needs none of it and is fully shipped. **If enrollment is not already done,
run in-channel.** The Activity is not worth a scramble; the channel record is the audit trail either
way.

---

## 2. Rehearsing without spamming the league

`/canon draftorder setup` anchors the whole ceremony to **the channel it is invoked in** —
commitment, previews, audit lines, seal post, seed disclosure. So a rehearsal is just a setup run in
a test channel. No flag, no code change.

Use a manual roster so the rehearsal touches nothing real:

```
/canon draftorder setup teams: Alpha, Bravo, Charlie, Delta
```

Four teams finishes in under a minute, and `leagueId` stays unset so no ESPN call is made (an
in-Activity re-import correctly refuses for the same reason).

### Two things that bite

**A rehearsal repoints the doorbell.** Every setup calls `memo.remember(guildId, channelId)`, writing
`draftorder-channels.json`. That is the channel the Activity's "start a lottery" button uses when the
stage is idle — a doorbell press has no channel of its own. Rehearse in `#lottery-test` and
`#lottery-test` becomes the guild's lottery channel.

> **Always run one setup in the real channel last**, so it is the remembered one.

**There is only one stage.** The api holds a single lottery stage, guild-guarded — a second guild's
`start` is refused while one is armed or live, and within a guild a new setup replaces the existing
session. You cannot hold a rehearsal lobby and the real lobby at the same time. Finish or
`/canon draftorder abort` the rehearsal before arming the real ceremony, and do the rehearsing well
ahead of the night rather than an hour before.

### Rehearsing with someone else

Enrollment friction is **per-application, not per-server** — a tester does not need to be in the
league's server. Inviting one friend who administers some other server tests three things at once:
how long enrollment actually takes a non-technical person, whether the Activity opens for someone
who is not you, and the commissioner path from an account that has never used it. The bot has to be
in their server for the launch button.

---

## 3. Season, and what it actually means

`season` on `setup` defaults to the current year, matching the Activity's own picker. It is the
**draft's** season — `applyStandingsWeights` reads `season - 1`, so a 2026 lottery is seeded by the
2025 final standings. Pass it explicitly only when running a lottery for a year that is not this one.

---

## 4. The order that matters

The fairness story is the sequence, and the bot enforces it:

1. **setup** — freezes the bag and posts the public odds preview. Nothing is committed yet.
2. Any edits (ball counts, renames, re-import) — each one re-posts, and `begin` publishes a fresh
   odds card naming every change **before** the commitment.
3. **begin** — seals the bag, posts the commitment, then reveals.
4. The seed is disclosed in-channel at the end, so anyone can verify the draw against the
   commitment.

The one rule worth memorising: **nothing may change the bag after the commitment is posted.** Every
guard in the code exists to make that true; do not go looking for a way around it on the night.

---

## 5. Escape hatches

- `/canon draftorder abort` — stops a ceremony. Past the last reveal it deliberately does _not_
  stop: every pick is already public, and finishing discloses more than aborting.
- **Bot restart mid-ceremony** — a committed-but-unfinalised seed is disclosed automatically on the
  next boot, to the channel the ceremony started in. It fails closed: if the seed cannot be
  persisted, the ceremony refuses to start rather than run undisclosed.
- **Activity broken on the night** — fall back to the in-channel ceremony. It needs `setup` to have
  run **before** `begin`, because `begin` requires a `GAME_OPEN` session in bot memory.
- **api restarts mid-ceremony** — the stage resets to idle and the bot does _not_ re-arm it. Viewers
  keep a dead screen; the channel record stays correct. Do not restart the api during a draw.

---

## 6. Before the night

- [ ] Decide in-channel vs Activity — enrollment is the deciding factor, not preference
- [ ] Rehearse with a manual roster in a test channel, end to end
- [ ] Run one real-channel `setup` afterwards, so the doorbell is anchored correctly
- [ ] `node -v` on the machine that will run the bot — the repo wants **>= 24**, and a Node 22+
      global passes CI and crashes at runtime
- [ ] Pick the visual: **machine** and **race** are validated live; the wheel's labels are not yet
      legible
- [ ] If using the Activity: tunnel up _before_ anything else, hostname pasted into the portal URL
      mapping, and then leave it alone
