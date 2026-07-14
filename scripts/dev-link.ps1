#!/usr/bin/env pwsh

<#
.SYNOPSIS
    Toggle the global `gjc` CLI between this checkout's source and the
    published install. Once linked, every `gjc` invocation runs the current
    source from packages/coding-agent/src/cli.ts — no rebuild required.

.DESCRIPTION
    Windows cannot use scripts/dev-link.ts (it targets Unix ~/.local/bin).
    Instead this script uses bun's package linking on the single package the
    global gjc.exe wrapper invokes:

      1) `dev-link.ps1`              -> link this checkout to the global bin
      2) `dev-link.ps1 -DoctorOnly`  -> verify the link is in place
      3) `dev-link.ps1 -RestoreOnly` -> put the published install back

    After running (1), just call `gjc` from anywhere — your edits to
    packages/coding-agent/src/** take effect on the next invocation.

    The link is sticky: it stays in place until you explicitly -RestoreOnly.

.PARAMETER RestoreOnly
    Restore the published @gajae-code/coding-agent install. Uses `bun remove -g`
    + `bun add -g` to do a clean swap.

.PARAMETER DoctorOnly
    Only verify the link via `gjc --smoke-test` and exit.

.EXAMPLE
    powershell scripts/dev-link.ps1                 # link this checkout
    powershell scripts/dev-link.ps1 -DoctorOnly     # check link
    powershell scripts/dev-link.ps1 -RestoreOnly    # restore published install
    gjc --help                                      # run after linking
#>

[CmdletBinding()]
param(
    [switch]$RestoreOnly,
    [switch]$DoctorOnly
)

$ErrorActionPreference = 'Stop'

# --- paths ----------------------------------------------------------------
$RepoRoot      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$PkgCliDir     = Join-Path $RepoRoot 'packages/coding-agent'
$CliEntry      = Join-Path $PkgCliDir 'bin/gjc.js'
$CliSource     = Join-Path $PkgCliDir 'src/cli.ts'
$HomeBunBin    = Join-Path $env:USERPROFILE '.bun/bin'

if (-not (Test-Path $HomeBunBin)) {
    throw "Bun bin directory not found at $HomeBunBin. Install bun first."
}

# --- helpers --------------------------------------------------------------
function Write-Step($msg) {
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Test-Link {
    try {
        $out = & gjc --smoke-test 2>&1 | Out-String
        $ok = ($LASTEXITCODE -eq 0) -and ($out -match 'smoke-test: ok')
        if (-not $ok) { Write-Host $out -ForegroundColor DarkYellow }
        return $ok
    } catch {
        Write-Host $_ -ForegroundColor Red
        return $false
    }
}

# --- restore-only ---------------------------------------------------------
if ($RestoreOnly) {
    Write-Step "Restoring published @gajae-code/coding-agent"
    & bun remove -g @gajae-code/coding-agent 2>&1 | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "bun remove failed (exit $LASTEXITCODE)" }
    & bun add -g @gajae-code/coding-agent 2>&1 | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "bun add failed (exit $LASTEXITCODE)" }
    if (Test-Link) {
        Write-Step "Restored. gjc now runs the published install."
        exit 0
    } else {
        Write-Error "Published install did not pass smoke-test."
        exit 1
    }
}

# --- doctor-only ----------------------------------------------------------
if ($DoctorOnly) {
    if (Test-Link) {
        Write-Step "gjc is wired to this checkout's source (smoke-test: ok)."
        exit 0
    } else {
        Write-Error "gjc smoke-test failed. Run without -DoctorOnly to relink."
        exit 1
    }
}

# --- sanity ---------------------------------------------------------------
if (-not (Test-Path $CliEntry))  { throw "Missing CLI entry: $CliEntry" }
if (-not (Test-Path $CliSource)) { throw "Missing CLI source: $CliSource" }

# If already linked to this checkout, just verify.
$resolved = & cmd /c 'for %I in ("%~dpnx..\..\..\..\packages\coding-agent") do @echo %~sI' 2>$null
# The cheap check: does `gjc --version` actually come from our CLI source?
if (Test-Link) {
    # Probe the symlink target on disk.
    $pkgLink = Join-Path $env:USERPROFILE '.bun/install/global/node_modules/@gajae-code/coding-agent'
    $target = $null
    try { $target = (Get-Item $pkgLink).Target } catch { }
    if ($target -and ($target -like "*$RepoRoot*")) {
        Write-Step "Already linked to this checkout: $target"
        Write-Step "Source edits take effect on the next `gjc` run."
        exit 0
    }
}

# --- fresh link -----------------------------------------------------------
Write-Step "Removing any existing @gajae-code/coding-agent install"
& bun remove -g @gajae-code/coding-agent 2>&1 | Write-Host
# ignore failure here — package may not be installed yet.

Write-Step "Registering packages/coding-agent as linkable"
Push-Location $PkgCliDir
try {
    & bun link 2>&1 | Write-Host
    if ($LASTEXITCODE -ne 0) { throw "bun link failed (exit $LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Step "Linking @gajae-code/coding-agent into global bin"
& bun link @gajae-code/coding-agent 2>&1 | Write-Host
if ($LASTEXITCODE -ne 0) { throw "bun link install failed (exit $LASTEXITCODE)" }

# --- verify ---------------------------------------------------------------
Write-Step "Verifying via gjc --smoke-test"
if (-not (Test-Link)) {
    throw "smoke-test failed. Try: bun run build:native"
}
Write-Step "Link OK. Source edits will be picked up on the next `gjc` run."
exit 0