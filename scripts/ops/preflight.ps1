<#
.SYNOPSIS
  Pre-departure check for an unattended lottery night / draft week (#246).

.DESCRIPTION
  Read-only. Starts nothing, changes nothing -- run it before you leave town, and again from
  anywhere with `-PublicUrl` alone to check the stack from the road.

  Every check answers a question you cannot answer remotely once something has already gone wrong.
  The ones that have actually bitten this project are marked in the output.

.PARAMETER PublicUrl
  The tunnel hostname registered as the Discord portal URL mapping, e.g. https://lottery.example.com.
  Omit to check only the local side.

.PARAMETER SkipLocal
  Only run the checks that work from away (the public URL). Use this from a phone or a laptop.

.PARAMETER LocalPort
  Port the api listens on. Defaults to 4610, the FANTASY_API_PORT default.

.EXAMPLE
  .\scripts\ops\preflight.ps1 -PublicUrl https://lottery.example.com

.EXAMPLE
  # From the road:
  .\scripts\ops\preflight.ps1 -PublicUrl https://lottery.example.com -SkipLocal
#>
[CmdletBinding()]
param(
    [string]$PublicUrl,
    [switch]$SkipLocal,
    [int]$LocalPort = 4610
)

$ErrorActionPreference = 'Continue'
$script:Failures = 0
$script:Warnings = 0

function Report {
    param(
        [ValidateSet('PASS', 'WARN', 'FAIL', 'SKIP')][string]$Status,
        [string]$Name,
        [string]$Detail
    )
    $colour = 'Gray'
    if ($Status -eq 'PASS') { $colour = 'Green' }
    if ($Status -eq 'WARN') { $colour = 'Yellow'; $script:Warnings++ }
    if ($Status -eq 'FAIL') { $colour = 'Red'; $script:Failures++ }
    Write-Host ('{0,-5} {1,-34} {2}' -f $Status, $Name, $Detail) -ForegroundColor $colour
}

function Get-Health {
    param([string]$BaseUrl)
    try {
        $r = Invoke-WebRequest -Uri "$BaseUrl/healthz" -UseBasicParsing -TimeoutSec 10
        return $r.Content | ConvertFrom-Json
    }
    catch {
        return $null
    }
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Write-Host ''
Write-Host "fantasy-canon preflight  ($RepoRoot)" -ForegroundColor Cyan
Write-Host ''

if (-not $SkipLocal) {

    # --- Toolchain -----------------------------------------------------------------------------
    # This one is not hypothetical: the repo declares engines >=24 and CI runs 24, but this machine
    # has run Node 20. Node-22+ globals typecheck, pass CI, and then throw at runtime (#228).
    $nodeRaw = (& node --version) 2>$null
    if (-not $nodeRaw) {
        Report FAIL 'node on PATH' 'not found'
    }
    else {
        $major = [int](($nodeRaw.TrimStart('v')).Split('.')[0])
        if ($major -ge 24) { Report PASS 'node version' "$nodeRaw" }
        else { Report FAIL 'node version' "$nodeRaw but package.json requires >=24 -- Node-22+ globals pass CI and throw at runtime (bit us in #228)" }
    }

    if ((Get-Command pnpm -ErrorAction SilentlyContinue)) {
        # stderr suppressed: pnpm warns about unrelated workspace config and it lands mid-report.
        Report PASS 'pnpm on PATH' (& pnpm --version 2>$null)
    }
    else { Report FAIL 'pnpm on PATH' 'not found -- the scheduled tasks invoke it' }

    # --- Secrets -------------------------------------------------------------------------------
    $envPath = Join-Path $RepoRoot '.env'
    if (-not (Test-Path $envPath)) {
        Report FAIL '.env' 'missing at the repo root'
    }
    else {
        $envText = Get-Content $envPath -Raw
        $required = @('DISCORD_TOKEN', 'DISCORD_APP_ID', 'ESPN_LEAGUE_ID', 'FANTASY_STAGE_KEY', 'FANTASY_STAGE_URL')
        $missing = @()
        foreach ($key in $required) {
            # Present AND non-empty: an empty FANTASY_STAGE_KEY leaves the stage unauthenticated
            # on a publicly reachable hostname.
            if ($envText -notmatch "(?m)^\s*$key\s*=\s*\S") { $missing += $key }
        }
        if ($missing.Count -eq 0) { Report PASS '.env required keys' ($required -join ', ') }
        else { Report FAIL '.env required keys' ("empty or missing: " + ($missing -join ', ')) }

        if ($envText -match '(?m)^\s*ESPN_S2\s*=\s*\S') { Report PASS 'ESPN cookies' 'ESPN_S2 set (private league)' }
        else { Report WARN 'ESPN cookies' 'ESPN_S2 empty -- fine for a public league, fatal for a private one' }
    }

    $apiEnv = Join-Path $RepoRoot 'apps\api\.env'
    if ((Test-Path $apiEnv) -and ((Get-Content $apiEnv -Raw) -match '(?m)^\s*DISCORD_CLIENT_SECRET\s*=\s*\S')) {
        Report PASS 'apps/api/.env secret' 'DISCORD_CLIENT_SECRET set'
    }
    else {
        Report FAIL 'apps/api/.env secret' 'DISCORD_CLIENT_SECRET missing -- the Activity handshake cannot exchange its code'
    }

    # --- Supervision ---------------------------------------------------------------------------
    foreach ($name in @('FantasyCanon-Bot', 'FantasyCanon-Api')) {
        $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        if (-not $task) {
            Report FAIL "task $name" 'not registered -- run scripts/ops/install-tasks.ps1 elevated'
        }
        elseif ($task.State -eq 'Running') {
            Report PASS "task $name" 'running'
        }
        else {
            Report FAIL "task $name" "state=$($task.State) -- expected Running"
        }
    }

    $tunnel = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
    if (-not $tunnel) { Report FAIL 'cloudflared service' 'not installed -- run: cloudflared service install' }
    elseif ($tunnel.Status -eq 'Running') { Report PASS 'cloudflared service' 'running' }
    else { Report FAIL 'cloudflared service' "status=$($tunnel.Status)" }

    # --- The app, locally ------------------------------------------------------------------------
    $local = Get-Health "http://127.0.0.1:$LocalPort"
    if (-not $local) {
        Report FAIL 'api /healthz (local)' "no answer on 127.0.0.1:$LocalPort"
    }
    else {
        Report PASS 'api /healthz (local)' "phase=$($local.stage.phase) uptime=$([int]$local.uptimeSec)s"
        # A missing bundle is this stack's quietest failure: the Activity loads and then 503s
        # fetching its own script, which from a phone looks exactly like a dead tunnel.
        if ($local.config.lotteryBundle) { Report PASS 'lottery client bundle' 'built' }
        else { Report FAIL 'lottery client bundle' 'missing -- run: pnpm -C apps/api run build:client, then restart the api' }
        if ($local.config.stageKey) { Report PASS 'stage key (api side)' 'configured' }
        else { Report FAIL 'stage key (api side)' 'EMPTY -- /api/lottery/* is unauthenticated on a public hostname' }
        if ($local.config.clientId) { Report PASS 'client id (api side)' 'configured' }
        else { Report FAIL 'client id (api side)' 'empty -- the Activity SDK handshake needs it' }
    }

    # --- State ------------------------------------------------------------------------------------
    $stateDir = $env:FANTASY_STATE_DIR
    if (-not $stateDir) { $stateDir = Join-Path $RepoRoot '.data' }
    $store = Join-Path $stateDir 'draftorder-ceremonies.json'
    if (Test-Path $store) {
        $records = 0
        try { $records = ((Get-Content $store -Raw | ConvertFrom-Json).PSObject.Properties | Measure-Object).Count } catch { $records = -1 }
        if ($records -gt 0) {
            Report WARN 'pending ceremony record' "$records committed-but-undisclosed seed(s) in $store -- the bot discloses these at boot (#176); expected to be empty before a fresh run"
        }
        else {
            Report PASS 'pending ceremony record' 'none'
        }
    }
    else {
        Report PASS 'pending ceremony record' 'no store yet'
    }

    $drive = Get-PSDrive -Name ($RepoRoot.Substring(0, 1)) -ErrorAction SilentlyContinue
    if ($drive) {
        $freeGb = [math]::Round($drive.Free / 1GB, 1)
        if ($freeGb -ge 2) { Report PASS 'disk free' "$freeGb GB" }
        else { Report WARN 'disk free' "$freeGb GB -- the seed store and logs need headroom" }
    }
}
else {
    Report SKIP 'local checks' '-SkipLocal'
}

# --- Through the tunnel ----------------------------------------------------------------------------
if ($PublicUrl) {
    $public = Get-Health ($PublicUrl.TrimEnd('/'))
    if (-not $public) {
        Report FAIL 'api /healthz (public)' "no answer at $PublicUrl/healthz -- tunnel down, or DNS not pointing at it"
    }
    else {
        Report PASS 'api /healthz (public)' "phase=$($public.stage.phase) uptime=$([int]$public.uptimeSec)s"
        # A doorbell nobody answered is the #250 failure mode: the Activity records the press and
        # the bot never acts, so the commissioner sees a stuck button and no explanation.
        $stuck = @()
        if ($public.stage.beginRequested) { $stuck += 'begin' }
        if ($public.stage.setupRequested) { $stuck += 'setup' }
        if ($public.stage.reimportRequested) { $stuck += 'reimport' }
        if ($stuck.Count -gt 0) { Report WARN 'unanswered doorbell' (($stuck -join ', ') + ' pending -- the bot has not picked it up') }
        else { Report PASS 'unanswered doorbell' 'none pending' }
    }
}
else {
    Report SKIP 'public URL checks' 'pass -PublicUrl https://your-hostname'
}

Write-Host ''
Write-Host 'Not checkable from here -- confirm by hand:' -ForegroundColor Cyan
Write-Host '  * Windows Update is paused for the draft window (a reboot is survivable, a 3am'
Write-Host '    feature update that waits at a login prompt is not).'
Write-Host '  * The Discord portal URL mapping still points at the hostname above.'
Write-Host '  * Sleep/hibernate disabled: powercfg /change standby-timeout-ac 0'
Write-Host ''

if ($script:Failures -gt 0) {
    Write-Host "$($script:Failures) failure(s), $($script:Warnings) warning(s)" -ForegroundColor Red
    exit 1
}
Write-Host "all clear ($($script:Warnings) warning(s))" -ForegroundColor Green
exit 0
