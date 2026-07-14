#!/usr/bin/env pwsh

<#
.SYNOPSIS
    Build gjc.exe (or reuse existing build), run it with --tmux against an
    optional session name, and restore the published install on exit.

.DESCRIPTION
    Wraps the build + run + cleanup cycle into one command. The global `gjc`
    is left untouched (still points to published @gajae-code/coding-agent).
    Only the locally built copy is used:

      1) `bun scripts/build-binary.ts` (or `-SkipBuild` to reuse dist/)
      2) Copy the resulting gjc.exe to a staging path under $env:TEMP
      3) Run `staged-gjc.exe --tmux` (forward any extra args via -GjcArgs)
      4) Restore the original bin/gjc.exe (if it existed) and clean staging

.PARAMETER SkipBuild
    Skip the build step and use the existing dist/gjc.exe.

.PARAMETER GjcArgs
    Arguments forwarded after `--tmux`. Pass via -GjcArgs to avoid PowerShell
    binding `--` ambiguously.

.PARAMETER NoRestore
    Do not restore the original bin/gjc.exe on exit (useful when you want
    the freshly-built binary to remain in place).

.EXAMPLE
    pwsh scripts/dev-tmux.ps1                                # build + run --tmux (no extra args)
    pwsh scripts/dev-tmux.ps1 -SkipBuild                    # reuse existing build
    pwsh scripts/dev-tmux.ps1 -GjcArgs "C:/Users/.../proj"  # build + run --tmux "C:/..."
    pwsh scripts/dev-tmux.ps1 -NoRestore                    # leave bin/gjc.exe as-is
#>

[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$NoRestore,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$GjcArgs
)

$ErrorActionPreference = 'Stop'

# --- paths ----------------------------------------------------------------
$RepoRoot      = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$PkgDir        = Join-Path $RepoRoot 'packages/coding-agent'
$BuiltExe      = Join-Path $PkgDir 'dist/gjc.exe'
$BinDir        = Join-Path $RepoRoot 'bin'
$BinExe        = Join-Path $BinDir 'gjc.exe'
$BinBackup     = Join-Path $BinDir 'gjc.exe.bak'
$StagingRoot   = Join-Path $env:TEMP "gjc-dev-tmux-$PID"
$StagedExe     = Join-Path $StagingRoot 'gjc.exe'
$StagedNative  = Join-Path $StagingRoot 'pi_natives.win32-x64-baseline.node'

# --- build ---------------------------------------------------------------
if (-not $SkipBuild) {
    Write-Host "==> Building standalone gjc.exe" -ForegroundColor Cyan
    Push-Location $PkgDir
    try {
        & bun scripts/build-binary.ts 2>&1 | Write-Host
        if ($LASTEXITCODE -ne 0) { throw "build-binary.ts failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path $BuiltExe)) {
    throw "Build artifact missing: $BuiltExe (run without -SkipBuild)"
}

# --- back up the user's bin/gjc.exe if present ---------------------------
if (Test-Path $BinExe) {
    Write-Host "==> Backing up $BinExe -> $BinBackup" -ForegroundColor DarkYellow
    if (Test-Path $BinBackup) { Remove-Item -Force $BinBackup }
    Move-Item -Force $BinExe $BinBackup
}

# --- stage a copy under TEMP so the user-facing bin/ is never half-baked --
if (Test-Path $StagingRoot) { Remove-Item -Recurse -Force $StagingRoot }
New-Item -ItemType Directory -Path $StagingRoot | Out-Null
Copy-Item -Force $BuiltExe $StagedExe

# Carry along the native addon next to the staged exe so any code path that
# resolves it via CWD still finds it.
$nativeSrc = Join-Path $PkgDir 'dist/pi_natives.win32-x64-baseline.node'
if (Test-Path $nativeSrc) {
    Copy-Item -Force $nativeSrc $StagedNative
}

Write-Host "==> Staged build: $StagedExe" -ForegroundColor Green

# --- restore helper ------------------------------------------------------
function Restore-Bin {
    if ($NoRestore) {
        Write-Host "==> -NoRestore set; leaving $BinExe in place" -ForegroundColor DarkYellow
        return
    }
    if (Test-Path $BinBackup) {
        if (Test-Path $BinExe) { Remove-Item -Force $BinExe }
        Move-Item -Force $BinBackup $BinExe
        Write-Host "==> Restored $BinExe from backup" -ForegroundColor Cyan
    } else {
        Write-Host "==> No bin/gjc.exe backup to restore" -ForegroundColor DarkGray
    }
}

trap {
    Write-Host "`nERROR: $_" -ForegroundColor Red
    try { Restore-Bin } catch { Write-Host "Restore failed: $_" -ForegroundColor Red }
    if (Test-Path $StagingRoot) { Remove-Item -Recurse -Force $StagingRoot }
    exit 1
}

# --- run ------------------------------------------------------------------
$argLine = if ($GjcArgs) { $GjcArgs -join ' ' } else { '(no extra args)' }
Write-Host "==> Running: $StagedExe --tmux $argLine" -ForegroundColor Cyan
try {
    & $StagedExe --tmux @GjcArgs
    $code = $LASTEXITCODE
} finally {
    Restore-Bin
    if (Test-Path $StagingRoot) {
        Remove-Item -Recurse -Force $StagingRoot
        Write-Host "==> Cleaned staging: $StagingRoot" -ForegroundColor DarkGray
    }
}
exit $code