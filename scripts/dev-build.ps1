#!/usr/bin/env pwsh

<#
.SYNOPSIS
    Build a standalone gjc.exe from this checkout and copy it into ./bin/,
    leaving the global `gjc` command untouched (always points to published).

.DESCRIPTION
    Why a separate build dir? Because the global `gjc` resolves to the
    published `@gajae-code/coding-agent` (kept on purpose so it never drifts),
    and `bun link` to this checkout's source confused the runtime and the
    user's terminal sessions. This script isolates dev builds:

      1) `bun run build` in packages/coding-agent  ->  packages/coding-agent/dist/gjc.exe
      2) Copy that binary to ./bin/gjc.exe (next to this script's parent).
      3) Run the requested gjc args against the copied binary.

    Link stays untouched: `gjc` from anywhere = published, `./bin/gjc.exe`
    from this checkout = local build.

.PARAMETER BuildOnly
    Only run the build + copy, do not run the binary.

.PARAMETER Run
    Run the copied binary with the supplied args (default behaviour when
    no switch is provided).

.PARAMETER Clean
    Remove ./bin/ contents before building.

.PARAMETER GjcArgs
    Arguments forwarded to the built binary. Always pass via -GjcArgs
    (PowerShell binds `--` ambiguously).

.EXAMPLE
    pwsh scripts/dev-build.ps1                          # build + copy
    pwsh scripts/dev-build.ps1 -GjcArgs --help          # build + run --help
    pwsh scripts/dev-build.ps1 -GjcArgs "C:/some/dir"   # build + run with cwd
    pwsh scripts/dev-build.ps1 -BuildOnly               # build, no run
    pwsh scripts/dev-build.ps1 -Clean -BuildOnly        # clean + build
#>

[CmdletBinding()]
param(
    [switch]$BuildOnly,
    [switch]$Clean,
    [switch]$SkipBuild,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$GjcArgs
)

$ErrorActionPreference = 'Stop'

$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$PkgDir     = Join-Path $RepoRoot 'packages/coding-agent'
$BuiltExe   = Join-Path $PkgDir 'dist/gjc.exe'
$BinDir     = Join-Path $RepoRoot 'bin'
$LocalExe   = Join-Path $BinDir 'gjc.exe'

if (-not (Test-Path $PkgDir)) { throw "Not a gjc checkout: $RepoRoot" }

# --- clean ----------------------------------------------------------------
if ($Clean -and (Test-Path $BinDir)) {
    Write-Host "==> Removing $BinDir" -ForegroundColor Cyan
    Remove-Item -Recurse -Force $BinDir
}

# --- build ----------------------------------------------------------------
if ($Clean) {
    $distDir = Join-Path $PkgDir 'dist'
    if (Test-Path $distDir) {
        Write-Host "==> Removing $distDir" -ForegroundColor Cyan
        Remove-Item -Recurse -Force $distDir
    }
}

if (-not $SkipBuild) {
    Write-Host "==> Building standalone binary (this may take ~15s)" -ForegroundColor Cyan
    Push-Location $PkgDir
    try {
        & bun scripts/build-binary.ts 2>&1 | Write-Host
        if ($LASTEXITCODE -ne 0) { throw "bun scripts/build-binary.ts failed (exit $LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
} else {
    Write-Host "==> Skipping build (using existing dist/gjc.exe)" -ForegroundColor DarkYellow
}

if (-not (Test-Path $BuiltExe)) {
    throw "Build did not produce $BuiltExe"
}

if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir | Out-Null }
Copy-Item -Force $BuiltExe $LocalExe
Write-Host "==> Built: $LocalExe" -ForegroundColor Green

if ($BuildOnly) { exit 0 }

# --- run ------------------------------------------------------------------
$argLine = if ($GjcArgs) { $GjcArgs -join ' ' } else { '(no args)' }
Write-Host "==> Running: $LocalExe $argLine" -ForegroundColor Cyan
& $LocalExe @GjcArgs
exit $LASTEXITCODE