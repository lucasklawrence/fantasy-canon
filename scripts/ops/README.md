# `scripts/ops` — unattended draft-window operations

Everything here exists because the commissioner is **away from the host PC** during the draft
window (#246). The procedure these support is
[`docs/15-draft-day-run-of-show.md`](../../docs/15-draft-day-run-of-show.md); the reasoning is
[ADR 0009](../../docs/decisions/0009-remote-draft-day-ops.md).

| File                             | What it is                                                                | Who runs it                                      |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| `cloudflared-config.example.yml` | Named-tunnel config template — stable hostname for the portal URL mapping | You, once, copied to `~/.cloudflared/config.yml` |
| `install-tasks.ps1`              | Registers the `FantasyCanon-Bot` / `FantasyCanon-Api` Scheduled Tasks     | You, once, **elevated**                          |
| `preflight.ps1`                  | Read-only check of the whole chain                                        | Before you leave, and again from the road        |

## Quick reference

```powershell
# Once, elevated, from the repo root:
.\scripts\ops\install-tasks.ps1
Start-ScheduledTask -TaskName FantasyCanon-Api
Start-ScheduledTask -TaskName FantasyCanon-Bot

# Before leaving town:
.\scripts\ops\preflight.ps1 -PublicUrl https://<hostname>

# From the road (or just open /healthz on your phone):
.\scripts\ops\preflight.ps1 -PublicUrl https://<hostname> -SkipLocal

# Undo:
.\scripts\ops\install-tasks.ps1 -Uninstall
```

`preflight.ps1` exits non-zero if anything failed, so it can be scheduled too.

## Notes

- `install-tasks.ps1` supports `-WhatIf`. It only creates Scheduled Tasks — it never installs
  cloudflared, touches the Discord portal, or starts a process.
- These are PowerShell 5.1 scripts (Windows 10) and are deliberately **ASCII-only**: `.ps1` files
  are read as ANSI unless they carry a BOM, and a stray em dash breaks the parser with an error
  that points at the wrong line.
- The health endpoint they poll is `GET /healthz` on the api. It is safe to expose: unauthenticated
  by design, side-effect free, and config is reported as booleans only.
