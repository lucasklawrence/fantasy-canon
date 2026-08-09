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

# Reads one key out of a dotenv file, or $null when absent/empty.
#
# `[^\S\r\n]` is "whitespace except newlines", and the distinction is load-bearing: .NET's `\s`
# matches `\r\n`, so the obvious `KEY\s*=\s*\S` happily runs past the line break and treats a blank
# `KEY=` followed by any non-empty line as a filled value -- reporting PASS for exactly the empty
# secret the check exists to catch.
function Get-EnvValue {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path $Path)) { return $null }
    $pattern = "(?m)^[^\S\r\n]*" + [regex]::Escape($Key) + "[^\S\r\n]*=[^\S\r\n]*(\S[^\r\n]*)"
    $m = [regex]::Match((Get-Content $Path -Raw), $pattern)
    if ($m.Success) { return $m.Groups[1].Value.Trim() }
    return $null
}

function Test-EnvFile {
    param([string]$Path, [string]$Label, [string[]]$Required)
    if (-not (Test-Path $Path)) {
        Report FAIL $Label "missing at $Path"
        return
    }
    $missing = @()
    foreach ($key in $Required) {
        if (-not (Get-EnvValue $Path $key)) { $missing += $key }
    }
    if ($missing.Count -eq 0) { Report PASS $Label ($Required -join ', ') }
    else { Report FAIL $Label ("empty or missing: " + ($missing -join ', ')) }
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

# Config is checked on whichever side answered. Both are worth running: the local check proves the
# process is configured, the public one proves the tunnel is reaching THAT process and not a stale
# instance left over from an earlier session.
function Test-HealthConfig {
    param($Health, [string]$Label)
    # A missing bundle is this stack's quietest failure: the Activity loads and then 503s fetching
    # its own script, which from a phone looks exactly like a dead tunnel.
    if ($Health.config.lotteryBundle) { Report PASS "lottery bundle ($Label)" 'built' }
    else { Report FAIL "lottery bundle ($Label)" 'missing -- run: pnpm -C apps/api run build:client, then restart the api' }
    # The dashboard bundle is not cosmetic either: the Activity opens at the root, which serves the
    # dashboard while the stage is idle, and that page carries the "Start a lottery" doorway (#253).
    if ($Health.config.dashboardBundle) { Report PASS "dashboard bundle ($Label)" 'built' }
    else { Report FAIL "dashboard bundle ($Label)" 'missing -- the idle Activity, and #253 start-from-idle, land on a 503' }
    if ($Health.config.stageKey) { Report PASS "stage key ($Label)" 'configured' }
    else { Report FAIL "stage key ($Label)" 'EMPTY -- /api/lottery/* is unauthenticated on a public hostname' }
    if ($Health.config.clientId) { Report PASS "client id ($Label)" 'configured' }
    else { Report FAIL "client id ($Label)" 'empty -- the Activity SDK handshake needs it' }
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Write-Host ''
Write-Host "fantasy-canon preflight  ($RepoRoot)" -ForegroundColor Cyan
Write-Host ''

# Refuse the combination that checks nothing. `-SkipLocal` with no `-PublicUrl` would otherwise run
# zero checks and print a green "all clear" -- the most dangerous output this script could produce,
# since it is the exact invocation someone reaches for from the road.
if ($SkipLocal -and -not $PublicUrl) {
    Write-Host '-SkipLocal needs -PublicUrl, or there is nothing left to check.' -ForegroundColor Red
    exit 2
}

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
    # PER-PACKAGE, not the repo root. The scheduled tasks run `pnpm -C apps/<pkg> run dev`, and -C
    # re-roots the script's cwd to that package -- so the bot's dotenv lookup lands on
    # apps/bot/.env and the api's on apps/api/.env. A root .env is not read by either, and an
    # earlier revision of this script failed a perfectly healthy machine over its absence.
    $botEnv = Join-Path $RepoRoot 'apps\bot\.env'
    $apiEnv = Join-Path $RepoRoot 'apps\api\.env'

    # FANTASY_STAGE_URL is deliberately absent from both lists: the bot falls back to
    # http://127.0.0.1:4610, which is exactly right when the api is on the same box.
    Test-EnvFile $botEnv 'apps/bot/.env' @('DISCORD_TOKEN', 'DISCORD_APP_ID', 'ESPN_LEAGUE_ID', 'FANTASY_STAGE_KEY')
    Test-EnvFile $apiEnv 'apps/api/.env' @('DISCORD_APP_ID', 'DISCORD_CLIENT_SECRET', 'FANTASY_STAGE_KEY')

    # The two halves of the shared secret have to agree or every stage POST 401s and the Activity
    # sits empty while the in-channel ceremony runs on regardless -- a confusing way to lose a night.
    # Compared, never printed.
    $botKey = Get-EnvValue $botEnv 'FANTASY_STAGE_KEY'
    $apiKey = Get-EnvValue $apiEnv 'FANTASY_STAGE_KEY'
    if ($botKey -and $apiKey) {
        if ($botKey -eq $apiKey) { Report PASS 'stage key agreement' 'bot and api match' }
        else { Report FAIL 'stage key agreement' 'bot and api FANTASY_STAGE_KEY DIFFER -- every stage POST will 401' }
    }
    else {
        Report SKIP 'stage key agreement' 'one side missing (see above)'
    }

    if ((Get-EnvValue $botEnv 'ESPN_S2') -and (Get-EnvValue $botEnv 'ESPN_SWID')) {
        Report PASS 'ESPN cookies' 'ESPN_S2 + ESPN_SWID set'
    }
    else {
        Report WARN 'ESPN cookies' 'ESPN_S2/ESPN_SWID incomplete -- fine for a public league, fatal for a private one'
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
        Test-HealthConfig $local 'local'
    }

    # --- State ------------------------------------------------------------------------------------
    # Same cwd story as the .env files: ceremonyStore defaults to `<cwd>/.data`, and the bot's cwd
    # under `pnpm -C apps/bot run dev` is apps/bot. Checking the repo root instead finds either
    # nothing or a stale artifact from a run started by hand, and reports "none" while a real
    # undisclosed seed sits in the file that matters.
    $stateDir = $env:FANTASY_STATE_DIR
    if (-not $stateDir) { $stateDir = Join-Path $RepoRoot 'apps\bot\.data' }
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
        # Re-checked through the tunnel, not just locally: this is the only evidence that the
        # hostname reaches the process you think it does. It is also the ONLY config check that
        # runs under -SkipLocal, which is how you check from the road.
        Test-HealthConfig $public 'public'
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
