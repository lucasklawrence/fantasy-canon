<#
.SYNOPSIS
  Register (or remove) Scheduled Tasks that keep the bot and api running unattended (#246).

.DESCRIPTION
  The commissioner is away from this machine for the draft window, so the two processes have to
  come back on their own after a crash and after a reboot -- Windows Update reboots being the
  realistic threat, not application crashes (the app already recovers its own state: #176 discloses
  an interrupted ceremony's seed at boot, #205 reconciles a stranded stage).

  Deliberate choices:

  * Runs the SAME `pnpm run dev` commands used day to day. The bot has no `start` script and its
    dist entry has never been exercised; introducing an unproven runtime path days before the draft
    would trade a known-good setup for an untested one. tsx in production is fine for a hobby bot.
  * LogonType S4U -- "run whether the user is logged on or not" WITHOUT storing a password and
    WITHOUT enabling auto-login. The tasks get the user profile (so corepack/pnpm resolve) but no
    interactive desktop, which is all a Node process needs.
  * Restart-on-failure plus StartWhenAvailable, so a task whose trigger was missed while the
    machine was off still starts on the next boot.

  This script only creates Scheduled Tasks. It does not install cloudflared, touch the Discord
  portal, or start anything -- see scripts/ops/cloudflared-config.example.yml and
  docs/15-draft-day-run-of-show.md.

.PARAMETER Uninstall
  Remove the tasks instead of creating them.

.PARAMETER WhatIf
  Show what would change without changing it.

.EXAMPLE
  # From an ELEVATED PowerShell, at the repo root:
  .\scripts\ops\install-tasks.ps1

.EXAMPLE
  .\scripts\ops\install-tasks.ps1 -Uninstall
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$BotTask = 'FantasyCanon-Bot'
$ApiTask = 'FantasyCanon-Api'

function Assert-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this from an elevated PowerShell (Scheduled Task registration needs admin).'
    }
}

Assert-Elevated

if ($Uninstall) {
    foreach ($name in @($BotTask, $ApiTask)) {
        if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
            if ($PSCmdlet.ShouldProcess($name, 'Unregister scheduled task')) {
                Unregister-ScheduledTask -TaskName $name -Confirm:$false
                Write-Host "removed $name"
            }
        }
        else {
            Write-Host "$name not present"
        }
    }
    return
}

# Repo root = two levels up from this script (scripts/ops/install-tasks.ps1).
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not (Test-Path (Join-Path $RepoRoot 'pnpm-workspace.yaml'))) {
    throw "Expected the repo root at $RepoRoot but found no pnpm-workspace.yaml there."
}

$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source
if (-not $pnpm) { throw 'pnpm is not on PATH for this account. Install it, then re-run.' }
# Scheduled Tasks need a real executable, not a shim resolved through the shell.
if ($pnpm -notmatch '\.(cmd|bat|exe)$') { $pnpm = "$pnpm.cmd" }
if (-not (Test-Path $pnpm)) { throw "Resolved pnpm to $pnpm, which does not exist." }

if (-not (Test-Path (Join-Path $RepoRoot '.env'))) {
    Write-Warning '.env is missing at the repo root -- the bot will not start until it exists.'
}

$user = "$env:USERDOMAIN\$env:USERNAME"

# Restart forever rather than a bounded count: nobody is here to re-arm it, and a task that has
# exhausted its retries looks identical to a healthy one in the UI.
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited

# AtStartup covers an unattended reboot; AtLogOn covers the case where you reboot it yourself and
# log in. MultipleInstances IgnoreNew makes the overlap a no-op rather than a second process.
$triggers = @(
    New-ScheduledTaskTrigger -AtStartup
    New-ScheduledTaskTrigger -AtLogOn -User $user
)

$jobs = @(
    @{ Name = $BotTask; Args = '-C apps/bot run dev'; Desc = 'Fantasy Canon Discord bot (#246 unattended draft window)' }
    @{ Name = $ApiTask; Args = '-C apps/api run dev'; Desc = 'Fantasy Canon Activity api + lottery stage (#246 unattended draft window)' }
)

foreach ($job in $jobs) {
    $action = New-ScheduledTaskAction -Execute $pnpm -Argument $job.Args -WorkingDirectory $RepoRoot
    $task = New-ScheduledTask -Action $action -Principal $principal -Trigger $triggers -Settings $settings -Description $job.Desc

    if (Get-ScheduledTask -TaskName $job.Name -ErrorAction SilentlyContinue) {
        if ($PSCmdlet.ShouldProcess($job.Name, 'Replace existing scheduled task')) {
            Unregister-ScheduledTask -TaskName $job.Name -Confirm:$false
            Register-ScheduledTask -TaskName $job.Name -InputObject $task | Out-Null
            Write-Host "replaced $($job.Name)"
        }
    }
    else {
        if ($PSCmdlet.ShouldProcess($job.Name, 'Register scheduled task')) {
            Register-ScheduledTask -TaskName $job.Name -InputObject $task | Out-Null
            Write-Host "registered $($job.Name)"
        }
    }
}

Write-Host ''
Write-Host 'Next:'
Write-Host "  Start-ScheduledTask -TaskName $ApiTask"
Write-Host "  Start-ScheduledTask -TaskName $BotTask"
Write-Host '  .\scripts\ops\preflight.ps1 -PublicUrl https://your-hostname'
