# GJC Coding Agent Installer for Windows (standalone binary, no Bun required)
# Usage: irm https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.ps1)))
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.ps1))) -Channel nightly
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.ps1))) -Ref v0.15.0
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.ps1))) -Source
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Yeachan-Heo/gajae-code/main/scripts/install.ps1))) -Source -Ref main

param(
    [switch]$Source,
    [switch]$Binary,
    [ValidateSet("stable", "nightly")]
    [string]$Channel = "stable",
    [string]$Ref
)

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 runs on .NET Framework, which may still default to
# TLS 1.0; GitHub requires TLS 1.2+, so opt in explicitly.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

$Repo = "Yeachan-Heo/gajae-code"
$Package = "@gajae-code/coding-agent"
$InstallDir = if ($env:GJC_INSTALL_DIR) { $env:GJC_INSTALL_DIR } else { "$env:LOCALAPPDATA\gjc" }
$GithubApi = if ($env:GJC_GITHUB_API) { $env:GJC_GITHUB_API } else { "https://api.github.com" }
$GithubReleases = if ($env:GJC_GITHUB_RELEASES) { $env:GJC_GITHUB_RELEASES } else { "https://github.com/$Repo/releases/download" }
$MinimumBunVersion = "1.3.14"
$BinarySha256Asset = "gajae-release-binaries.sha256"
$BinaryManifestAsset = "gajae-release-binaries-v1.json"
$UserAgent = "gjc-install"

function Test-TrustedGithubUri {
    param([string]$Uri)
    try {
        $parsed = [Uri]$Uri
        return $parsed.Scheme -eq "https" -and ($parsed.Host -eq "api.github.com" -or $parsed.Host -eq "github.com")
    } catch {
        return $false
    }
}

function Assert-OfficialGithubOrigins {
    $api = $GithubApi.TrimEnd("/")
    $releases = $GithubReleases.TrimEnd("/")
    $expectedReleases = "https://github.com/$Repo/releases/download"
    if ($api -ne "https://api.github.com") {
        throw "GJC_GITHUB_API must be https://api.github.com (got $GithubApi)."
    }
    if ($releases -ne $expectedReleases) {
        throw "GJC_GITHUB_RELEASES must be $expectedReleases (got $GithubReleases)."
    }
}

function Get-GithubHeaders {
    param([string]$Uri)
    $headers = @{
        "User-Agent" = $UserAgent
        "Accept" = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
    }
    $token = $env:GITHUB_TOKEN
    if (-not $token) { $token = $env:GH_TOKEN }
    if ($token -and (Test-TrustedGithubUri $Uri)) {
        $headers["Authorization"] = "Bearer $token"
    }
    return $headers
}

function Test-SafeReleaseTag {
    param([string]$Tag)
    if (-not $Tag) { return $false }
    if ($Tag -match '[/\\;|&`$]|(\.\.)') { return $false }
    return $Tag -match '^v[A-Za-z0-9][A-Za-z0-9._-]*$'
}

function Test-StableReleaseTag {
    param([string]$Tag)
    return $Tag -match '^v\d+\.\d+\.\d+$'
}

function Test-NightlyReleaseTag {
    param([string]$Tag)
    return $Tag -match '^v\d+\.\d+\.\d+-nightly\.\d+\.\d+\.g[0-9a-f]+$'
}

function Test-ReleaseTag {
    param([string]$Tag)
    return (Test-StableReleaseTag $Tag) -or (Test-NightlyReleaseTag $Tag)
}

function Get-WindowsBinaryName {
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    if ($arch -eq "ARM64") {
        throw "Unsupported architecture: ARM64. Prebuilt Windows binaries are published for x64 only."
    }
    if ($arch -eq "x86") {
        throw "Unsupported architecture: x86. Prebuilt Windows binaries are published for x64 only."
    }
    if ($arch -and $arch -ne "AMD64") {
        throw "Unsupported architecture: $arch. Prebuilt Windows binaries are published for x64 only."
    }
    return "gjc-windows-x64.exe"
}

function Test-BunInstalled {
    try {
        $null = Get-Command bun -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-BunVersion {
    try {
        $versionText = (bun --version 2>$null)
        if (-not $versionText) {
            return $null
        }

        $clean = $versionText.Trim().Split("-")[0]
        return [version]$clean
    } catch {
        return $null
    }
}

function Test-BunVersion {
    param([string]$MinimumVersion)

    $currentVersion = Get-BunVersion
    if (-not $currentVersion) {
        return $false
    }

    return $currentVersion -ge [version]$MinimumVersion
}

function Assert-BunVersion {
    param([string]$MinimumVersion)

    if (-not (Test-BunVersion $MinimumVersion)) {
        $current = Get-BunVersion
        $currentText = if ($current) { $current.ToString() } else { "unknown" }
        throw @"
Bun $MinimumVersion or newer is required for -Source. Current version: $currentText.
Install or upgrade Bun yourself: https://bun.sh/docs/installation
This installer never downloads Bun.
"@
    }
}

function Test-GitInstalled {
    try {
        $null = Get-Command git -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-GitLfsInstalled {
    try {
        $null = Get-Command git-lfs -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Find-BashShell {
    $gitBash = "C:\Program Files\Git\bin\bash.exe"
    if (Test-Path $gitBash) {
        return $gitBash
    }

    try {
        $bashCmd = Get-Command bash.exe -ErrorAction Stop
        return $bashCmd.Source
    } catch {
        return $null
    }
}

function Configure-BashShell {
    try {
        $settingsDir = Join-Path $env:USERPROFILE ".gjc\agent"
        $settingsFile = Join-Path $settingsDir "settings.json"

        if (Test-Path $settingsFile) {
            try {
                $existingSettings = Get-Content $settingsFile -Raw | ConvertFrom-Json
                if ($existingSettings.shellPath) {
                    Write-Host "Bash shell already configured: $($existingSettings.shellPath)" -ForegroundColor Cyan
                    return
                }
            } catch {
                # Invalid JSON, we'll overwrite it
            }
        }

        $bashPath = Find-BashShell

        if ($bashPath) {
            Write-Host "Found bash shell: $bashPath" -ForegroundColor Cyan

            if (-not (Test-Path $settingsDir)) {
                New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
            }

            $settings = @{}
            if (Test-Path $settingsFile) {
                try {
                    $parsed = Get-Content $settingsFile -Raw | ConvertFrom-Json
                    if ($parsed) {
                        foreach ($prop in $parsed.PSObject.Properties) {
                            $settings[$prop.Name] = $prop.Value
                        }
                    }
                } catch {
                    $settings = @{}
                }
            }

            $settings["shellPath"] = $bashPath
            $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile -Encoding UTF8
            Write-Host "Configured shell path in $settingsFile" -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "No bash shell found." -ForegroundColor Yellow
            Write-Host "  GJC requires a bash shell on Windows. Options:" -ForegroundColor Yellow
            Write-Host "    1. Install Git for Windows: https://git-scm.com/download/win" -ForegroundColor Yellow
            Write-Host "    2. Use WSL, Cygwin, or MSYS2" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "  After installing, you can set a custom path in:" -ForegroundColor Yellow
            Write-Host "    $settingsFile" -ForegroundColor Yellow
            Write-Host '    { "shellPath": "C:\\path\\to\\bash.exe" }' -ForegroundColor Yellow
        }
    } catch {
        Write-Host "Could not configure bash shell: $_" -ForegroundColor Yellow
    }
}

function Get-FileSha256Lower {
    param([string]$Path)
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-ChecksumForAsset {
    param(
        [string]$SumsPath,
        [string]$AssetName
    )
    foreach ($line in Get-Content -Path $SumsPath) {
        $parts = $line.Trim() -split '\s+'
        if ($parts.Count -ge 2) {
            $name = $parts[1].TrimStart('*').TrimStart('.', '\', '/')
            $name = Split-Path -Leaf $name
            if ($name -eq $AssetName) {
                return $parts[0].ToLowerInvariant()
            }
        }
    }
    return $null
}

function Resolve-ReleaseTag {
    $headers = Get-GithubHeaders -Uri "$GithubApi/"
    if ($Ref) {
        if (-not (Test-ReleaseTag $Ref)) {
            throw "Invalid -Ref '$Ref'. Expected a GitHub release tag like v0.15.0 or v0.15.0-nightly.1.1.gabc."
        }
        Write-Host "Fetching release $Ref..."
        try {
            $Release = Invoke-RestMethod -Uri "$GithubApi/repos/$Repo/releases/tags/$Ref" -Headers $headers
        } catch {
            throw "Release tag not found: $Ref`nFor branch/commit source installs, use -Source with -Ref and an existing Bun."
        }
        return $Release.tag_name
    }

    if ($Channel -eq "nightly") {
        Write-Host "Fetching latest nightly GitHub prerelease..."
        $releases = Invoke-RestMethod -Uri "$GithubApi/repos/$Repo/releases?per_page=40" -Headers $headers
        foreach ($candidate in $releases) {
            if ($candidate.prerelease -eq $true -and $candidate.draft -eq $false -and (Test-SafeReleaseTag $candidate.tag_name) -and $candidate.tag_name -match '^v\d+\.\d+\.\d+-nightly\.\d+\.\d+\.g[0-9a-f]+$') {
                return $candidate.tag_name
            }
        }
        throw "The nightly channel has no published GitHub prerelease yet; it is populated by the scheduled nightly workflow."
    }

    Write-Host "Fetching latest stable GitHub release..."
    $Release = Invoke-RestMethod -Uri "$GithubApi/repos/$Repo/releases/latest" -Headers $headers
    return $Release.tag_name
}

function Get-WebExceptionStatus {
    param($ErrorRecord)
    try {
        if ($ErrorRecord.Exception.Data.Contains("HttpStatus")) { return [int]$ErrorRecord.Exception.Data["HttpStatus"] }
        return [int]$ErrorRecord.Exception.Response.StatusCode
    } catch {
        return 0
    }
}

function Get-DefaultProxyUri {
    param([string]$Uri)
    # The proxy Invoke-WebRequest would use for $Uri ([WebRequest]::DefaultWebProxy: the system setting
    # plus any session override), or $null for a direct connection. It is resolved once for the first
    # URL, so a PAC with different rules for the redirect host is not honoured by curl.exe.
    $target = [System.Uri]$Uri
    $proxy = [System.Net.WebRequest]::DefaultWebProxy
    if (-not $proxy -or $proxy.IsBypassed($target)) { return $null }
    $proxyUri = $proxy.GetProxy($target)
    if ($proxyUri -and $proxyUri.AbsoluteUri -ne $target.AbsoluteUri) { return $proxyUri.AbsoluteUri }
    return $null
}

function Save-ReleaseAsset {
    param(
        [string]$Uri,
        [string]$OutFile,
        [switch]$ShowProgress
    )
    # curl.exe, not powershell.exe, downloads: on one machine (AhnLab V3 installed; link unproven) every
    # download from the powershell.exe process was 0.3-0.55 MB/s while curl.exe ran at 46-84 MB/s.
    $curl = Join-Path $env:SystemRoot "System32\curl.exe"
    if (Test-Path -LiteralPath $curl) {
        $arguments = @("--location", "--show-error", "--connect-timeout", "30", "--speed-limit", "1024", "--speed-time", "120", "--user-agent", $UserAgent, "--output", $OutFile, "--write-out", "%{http_code}")
        $arguments += if ($ShowProgress) { "--progress-bar" } else { "--silent" }
        $proxyUri = Get-DefaultProxyUri -Uri $Uri
        $arguments += if ($proxyUri) { @("--proxy", $proxyUri, "--proxy-anyauth", "--proxy-user", ":") } else { @("--noproxy", "*") }
        # curl writes progress and errors to stderr. Hosts that turn native stderr into error records
        # (ISE, remoting, PSNativeCommandUseErrorActionPreference) would throw under the script's Stop
        # preference before the exit code is read, so both preferences are relaxed around the call only.
        $previousErrorAction = $ErrorActionPreference
        $previousNativeErrorAction = $PSNativeCommandUseErrorActionPreference
        $ErrorActionPreference = "Continue"
        $PSNativeCommandUseErrorActionPreference = $false
        try {
            $statusText = & $curl @arguments $Uri
            $curlExit = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorAction
            $PSNativeCommandUseErrorActionPreference = $previousNativeErrorAction
        }
        $status = 0
        [void][int]::TryParse([string]($statusText | Where-Object { $_ -is [string] } | Select-Object -Last 1), [ref]$status)
        if ($curlExit -eq 0 -and $status -ge 200 -and $status -lt 300) { return }
        Remove-Item -Force -LiteralPath $OutFile -ErrorAction SilentlyContinue
        $reason = "HTTP $status, curl exit $curlExit"
        if ($status -ge 400) {
            $failure = New-Object System.Exception "Download failed ($reason): $Uri"
            $failure.Data["HttpStatus"] = $status
            throw $failure
        }
        Write-Warning "curl.exe could not download $Uri ($reason); retrying with Invoke-WebRequest."
    }
    if ($ShowProgress) { Write-Host "Downloading with Invoke-WebRequest, which shows no progress; this can take several minutes." }
    $previousProgress = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $OutFile -Headers @{ "User-Agent" = $UserAgent }
    } finally {
        $ProgressPreference = $previousProgress
    }
}

function Get-IOErrorCode {
    param($ErrorRecord)
    $exception = $ErrorRecord.Exception
    while ($exception.InnerException) { $exception = $exception.InnerException }
    return $exception.HResult -band 0xFFFF
}

function Move-InstallFile {
    param(
        [string]$Source,
        [string]$Destination
    )
    # No-overwrite rename: fails if $Destination exists. Windows refuses to delete a running exe
    # but allows renaming it.
    [System.IO.File]::Move($Source, $Destination)
}

function Stop-OnUpdaterLockDirectory {
    param([string]$LockPath)
    # `gjc update` locks with a directory holding an `info` record (JSON with the owner pid). It
    # has no DeleteOnClose, so a killed update leaves it behind. Only the updater's identity-
    # checked removal may reclaim it; the installer reports who holds it and how to clear it.
    $ownerPid = 0
    $infoPath = Join-Path $LockPath "info"
    try {
        $stream = New-Object System.IO.FileStream($infoPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
        try {
            $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
            $record = $reader.ReadToEnd() | ConvertFrom-Json
            if ($record -and $record.pid) { [void][int]::TryParse([string]$record.pid, [ref]$ownerPid) }
        } finally {
            $stream.Dispose()
        }
    } catch {}
    if ($ownerPid -gt 0) {
        $state = if (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue) { "is still running" } else { "has exited" }
        $owner = "'gjc update' (pid $ownerPid, which $state)"
    } else {
        $owner = "'gjc update' (owner unreadable)"
    }
    throw "The GJC install lock in $InstallDir is held by $owner (lock directory: $LockPath). Wait for that update to finish and retry. If no gjc update is running, close every gjc process, delete the directory $LockPath yourself, and retry; this installer never removes it."
}

function Enter-InstallLock {
    param(
        [string]$LockFile,
        [string]$LockLine
    )
    # The lock is an open handle, not just a file. FileShare.None makes a second installer's open
    # fail while this one runs, and DeleteOnClose makes Windows remove the file whenever the handle
    # closes, including when the window is closed or the process is killed mid-download. So an
    # interrupted install never strands a lock that blocks every later install.
    $ERROR_FILE_NOT_FOUND = 2
    $ERROR_SHARING_VIOLATION = 32
    $ERROR_FILE_EXISTS = 80
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $stream = New-Object System.IO.FileStream($LockFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::DeleteOnClose)
            $bytes = [System.Text.Encoding]::UTF8.GetBytes($LockLine + "`n")
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush()
            return $stream
        } catch {
            # `gjc update`'s lock is a directory at this path; creating a file there fails with access
            # denied. Classify after the failure rather than checking beforehand, so a directory
            # created at any moment is reported instead of surfacing as a raw .NET error.
            if ([System.IO.Directory]::Exists($LockFile)) { Stop-OnUpdaterLockDirectory -LockPath $LockFile }
            $code = Get-IOErrorCode $_
            if ($code -ne $ERROR_FILE_EXISTS -and $code -ne $ERROR_SHARING_VIOLATION) { throw }
        }
        # A lock file exists. Installers that hold it keep it unopenable; a file this one can open
        # was left by an installer that published its lock and closed the handle (releases before
        # this lock format). Reclaim it only when its recorded PID is no longer running: a live PID
        # may still be such an installer, so that case fails closed as before.
        $legacy = $null
        try {
            $legacy = New-Object System.IO.FileStream($LockFile, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Delete)
        } catch {
            if ([System.IO.Directory]::Exists($LockFile)) { Stop-OnUpdaterLockDirectory -LockPath $LockFile }
            if ((Get-IOErrorCode $_) -eq $ERROR_FILE_NOT_FOUND) { continue }
            throw "Another GJC installer is already running in $InstallDir (lock: $LockFile). Wait for it to finish, then retry."
        }
        try {
            $reader = New-Object System.IO.StreamReader($legacy, [System.Text.Encoding]::UTF8, $false, 1024, $true)
            $ownerLine = $reader.ReadLine()
            $ownerPid = 0
            if (-not ($ownerLine -match '^(\d+) [0-9a-f]{32}$') -or -not [int]::TryParse($Matches[1], [ref]$ownerPid)) {
                throw "Unrecognized GJC installer lock in $InstallDir (lock: $LockFile). Remove it only after confirming no installer is running."
            }
            if (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue) {
                throw "Another GJC installer (pid $ownerPid) may still be running in $InstallDir (lock: $LockFile). Wait for it to finish, or remove the lock after confirming that process is not an installer."
            }
            # $legacy is open without Read/Write sharing, so no other installer can open this file
            # during the PID check. The delete itself is by path; it cannot remove a lock a
            # successor created, because that lock is DeleteOnClose and held with FileShare.None.
            [System.IO.File]::Delete($LockFile)
            Write-Host "Removed a stale installer lock left by exited pid $ownerPid"
        } finally {
            $legacy.Dispose()
        }
    }
    throw "Another GJC installer is already running in $InstallDir (lock: $LockFile). Wait for it to finish, then retry."
}

function Assert-Checksum {
    param(
        [string]$Tag,
        [string]$AssetName,
        [string]$DownloadedPath
    )

    $sumsUrl = "$GithubReleases/$Tag/$BinarySha256Asset"
    $sumsTmp = Join-Path $InstallDir (".gjc.sha256." + [System.Guid]::NewGuid().ToString("N"))
    $manifestUrl = "$GithubReleases/$Tag/$BinaryManifestAsset"
    $manifestTmp = Join-Path $InstallDir (".gjc.manifest." + [System.Guid]::NewGuid().ToString("N"))
    try {
        $sumsMissing = $false
        try {
            Save-ReleaseAsset -Uri $sumsUrl -OutFile $sumsTmp
            $expected = Get-ChecksumForAsset -SumsPath $sumsTmp -AssetName $AssetName
            if (-not $expected -or $expected -notmatch '^[0-9a-f]{64}$') {
                throw "Release checksum file $BinarySha256Asset did not list $AssetName"
            }
            $actual = Get-FileSha256Lower $DownloadedPath
            if ($actual -ne $expected) {
                throw "Checksum mismatch for ${AssetName}: expected $expected, got $actual. Existing install was not changed."
            }
            Write-Host "Verified SHA-256 for $AssetName"
            return
        } catch {
            if ($_.Exception.Message -match "Checksum mismatch|did not list") { throw }
            $status = Get-WebExceptionStatus $_
            if ($status -eq 404) { $sumsMissing = $true }
            else { throw "Integrity asset $BinarySha256Asset could not be fetched (HTTP $status): $_. Existing install was not changed." }
        }

        try {
            Save-ReleaseAsset -Uri $manifestUrl -OutFile $manifestTmp
            $manifest = Get-Content $manifestTmp -Raw | ConvertFrom-Json
            foreach ($entry in $manifest.binaries) {
                if ($entry.name -eq $AssetName) {
                    $expected = [string]$entry.sha256
                    if ($expected -notmatch '^[0-9a-f]{64}$') {
                        throw "Release manifest listed an invalid checksum for $AssetName"
                    }
                    $actual = Get-FileSha256Lower $DownloadedPath
                    if ($actual -ne $expected) {
                        throw "Checksum mismatch for ${AssetName}: expected $expected, got $actual. Existing install was not changed."
                    }
                    Write-Host "Verified SHA-256 for $AssetName from $BinaryManifestAsset"
                    return
                }
            }
            throw "Release manifest $BinaryManifestAsset did not list $AssetName"
        } catch {
            if ($_.Exception.Message -match "Checksum mismatch|invalid checksum|did not list") { throw }
            $status = Get-WebExceptionStatus $_
            if ($status -eq 404 -and $sumsMissing) {
                throw "Release $Tag has no checksum assets. Existing install was not changed."
            }
            throw "Integrity asset $BinaryManifestAsset could not be fetched (HTTP $status): $_. Existing install was not changed."
        }
    } finally {
        Remove-Item -Force $sumsTmp -ErrorAction SilentlyContinue
        Remove-Item -Force $manifestTmp -ErrorAction SilentlyContinue
    }
}

function Assert-InstalledBinary {
    param(
        [string]$ExePath,
        [string]$ExpectedVersion
    )
    if (-not (Test-Path $ExePath)) {
        throw "Installed file is missing: $ExePath"
    }
    $versionOutput = & $ExePath --version 2>$null
    $escaped = [regex]::Escape($ExpectedVersion)
    if (-not $versionOutput -or ($versionOutput -notmatch "(?m)^gjc/$escaped(\s|$)")) {
        throw "Installed binary --version mismatch (expected gjc/$ExpectedVersion, got: $versionOutput)"
    }
    & $ExePath --smoke-test | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Installed binary --smoke-test failed"
    }
}

function Restore-PreviousBinary {
    param(
        [string]$BackupPath,
        [string]$TargetPath
    )
    try {
        Move-InstallFile -Source $BackupPath -Destination $TargetPath
        Write-Host "Restored previous gjc binary at $TargetPath"
        return $true
    } catch {
        Write-Warning "Could not restore the previous gjc binary. It is preserved at $BackupPath; delete $TargetPath if it exists, then rename $BackupPath to $TargetPath to restore it. Restore error: $($_.Exception.Message)"
        return $false
    }
}

function Remove-OwnedFile {
    param([string]$Path)
    # Deletes a file if present and reports whether it is gone; callers pass only paths they created.
    try {
        if ([System.IO.File]::Exists($Path)) { [System.IO.File]::Delete($Path) }
        return $true
    } catch {
        return $false
    }
}

function Publish-Binary {
    param(
        [string]$SourcePath,
        [string]$TargetPath,
        [string]$BackupPath,
        [string]$RejectedPath,
        [string]$ExpectedVersion
    )
    # Replace by rename, never by delete: Windows refuses to delete a running gjc.exe (another
    # terminal, the daemon, a bash tool) but allows renaming it. The old binary is renamed aside,
    # the new one is moved in with no-overwrite semantics, and a failure at any point renames the
    # old one back. A kill between the two renames leaves the old binary at $BackupPath.
    $hadExisting = [System.IO.File]::Exists($TargetPath)
    $restoreFailed = $false
    try {
        if ($hadExisting) {
            try {
                Move-InstallFile -Source $TargetPath -Destination $BackupPath
            } catch {
                throw "Could not move the existing $TargetPath aside; it was not changed. $($_.Exception.Message)"
            }
        }
        try {
            Move-InstallFile -Source $SourcePath -Destination $TargetPath
        } catch {
            $publishError = $_.Exception.Message
            if ($hadExisting) { $restoreFailed = -not (Restore-PreviousBinary -BackupPath $BackupPath -TargetPath $TargetPath) }
            throw "Failed to publish the downloaded binary. Existing install was preserved if one existed. $publishError"
        }
        try {
            Assert-InstalledBinary -ExePath $TargetPath -ExpectedVersion $ExpectedVersion
        } catch {
            $verifyError = $_.Exception.Message
            $retired = $false
            try {
                Move-InstallFile -Source $TargetPath -Destination $RejectedPath
                $retired = $true
            } catch {
                $retired = Remove-OwnedFile -Path $TargetPath
            }
            if ($hadExisting) {
                if ($retired) {
                    $restoreFailed = -not (Restore-PreviousBinary -BackupPath $BackupPath -TargetPath $TargetPath)
                } else {
                    $restoreFailed = $true
                    Write-Warning "Could not retire the rejected binary at $TargetPath. The previous gjc binary is preserved at $BackupPath; delete $TargetPath, then rename $BackupPath to $TargetPath, after closing gjc."
                }
            } elseif (-not $retired) {
                Write-Warning "The binary that failed verification is still at $TargetPath; delete it after closing gjc."
            }
            throw "Verification failed; existing install was preserved if one existed. $verifyError"
        }
    } finally {
        [void](Remove-OwnedFile -Path $RejectedPath)
        if (-not $restoreFailed -and [System.IO.File]::Exists($BackupPath)) {
            if (-not (Remove-OwnedFile -Path $BackupPath)) {
                Write-Host "The previous binary is still in use and was kept at $BackupPath; delete it after closing gjc."
            }
        }
    }
}

function Install-ViaBun {
    Write-Host "Installing from source via existing bun..."
    if ($Ref) {
        if (-not (Test-GitInstalled)) {
            throw "git is required for -Source -Ref"
        }

        $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("gjc-install-" + [System.Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

        try {
            $repoUrl = "https://github.com/$Repo.git"
            $cloneOk = $false
            try {
                git clone --depth 1 --branch $Ref $repoUrl $tmpRoot | Out-Null
                $cloneOk = $true
            } catch {
                $cloneOk = $false
            }

            if (-not $cloneOk) {
                git clone $repoUrl $tmpRoot | Out-Null
                Push-Location $tmpRoot
                try {
                    git checkout $Ref | Out-Null
                } finally {
                    Pop-Location
                }
            }

            if (Test-GitLfsInstalled) {
                Push-Location $tmpRoot
                try {
                    git lfs pull | Out-Null
                } finally {
                    Pop-Location
                }
            }

            $packagePath = Join-Path $tmpRoot "packages\coding-agent"
            if (-not (Test-Path $packagePath)) {
                throw "Expected package at $packagePath"
            }

            bun install -g $packagePath
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to install from $packagePath via bun"
            }
        } finally {
            Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
        }
    } else {
        bun install -g $Package
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install $Package via bun"
        }
    }

    Write-Host ""
    Write-Host "Installed gjc via bun (development/source mode)" -ForegroundColor Green
    Configure-BashShell
    Write-Host "Run 'gjc' to get started!"
}

function Install-Binary {
    Assert-OfficialGithubOrigins
    $BinaryName = Get-WindowsBinaryName
    $Latest = Resolve-ReleaseTag
    if ($Ref) {
        if (-not (Test-ReleaseTag $Latest)) { throw "Refusing unsafe release tag: $Latest" }
    } elseif ($Channel -eq "nightly") {
        if (-not (Test-NightlyReleaseTag $Latest)) { throw "Refusing non-nightly release tag: $Latest" }
    } else {
        if (-not (Test-StableReleaseTag $Latest)) { throw "Refusing non-stable release tag: $Latest" }
    }
    $ExpectedVersion = $Latest.TrimStart("v")
    Write-Host "Using version: $Latest"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $lockFile = Join-Path $InstallDir ".gjc-install.lock"
    $lockLine = "$PID $([guid]::NewGuid().ToString('N'))"
    $lockStream = Enter-InstallLock -LockFile $lockFile -LockLine $lockLine
    $OutPath = Join-Path $InstallDir "gjc.exe"
    $DownloadTmp = Join-Path $InstallDir (".gjc.download." + [System.Guid]::NewGuid().ToString("N"))
    $BackupPath = Join-Path $InstallDir (".gjc.bak." + [System.Guid]::NewGuid().ToString("N"))
    $RejectedPath = Join-Path $InstallDir (".gjc.rejected." + [System.Guid]::NewGuid().ToString("N"))
    try {
        $existing = Get-Item -LiteralPath $OutPath -Force -ErrorAction SilentlyContinue
        $isReparse = $false
        if ($existing) {
            $isReparse = [bool]($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
            if (-not $isReparse -and $existing.LinkType) { $isReparse = $true }
        }
        if ($isReparse) {
            throw "Refusing to replace symlink $OutPath with a regular binary. Remove the symlink or set GJC_INSTALL_DIR."
        }
        $BinaryUrl = "$GithubReleases/$Latest/$BinaryName"
        Write-Host "Downloading $BinaryName..."
        try {
            Save-ReleaseAsset -Uri $BinaryUrl -OutFile $DownloadTmp -ShowProgress
        } catch {
            Remove-Item -Force $DownloadTmp -ErrorAction SilentlyContinue
            throw "Could not download the prebuilt GJC binary for windows-x64 in $Latest.`nExpected asset URL: $BinaryUrl`nCause: $($_.Exception.Message)`nRe-run with -Source only if you are developing GJC and already have Bun."
        }

        if (-not (Test-Path $DownloadTmp) -or ((Get-Item $DownloadTmp).Length -le 0)) {
            Remove-Item -Force $DownloadTmp -ErrorAction SilentlyContinue
            throw "Downloaded file was empty: $BinaryUrl. Existing install was not changed."
        }

        Assert-Checksum -Tag $Latest -AssetName $BinaryName -DownloadedPath $DownloadTmp

        Publish-Binary -SourcePath $DownloadTmp -TargetPath $OutPath -BackupPath $BackupPath -RejectedPath $RejectedPath -ExpectedVersion $ExpectedVersion

        Write-Host ""
        Write-Host "Installed gjc $ExpectedVersion to $OutPath" -ForegroundColor Green

        $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if (-not $UserPath) { $UserPath = "" }
        $pathParts = @()
        foreach ($part in $UserPath.Split(";")) {
            if ($part -and $part -ne $InstallDir) { $pathParts += $part }
        }
        $newUserPath = (@($InstallDir) + $pathParts) -join ";"
        if ($newUserPath -ne $UserPath) {
            Write-Host "Putting $InstallDir first on PATH..."
            [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
            $env:Path = "$InstallDir;" + $env:Path
            $needsRestart = $true
        }

        Configure-BashShell

        if ($needsRestart) {
            Write-Host "Restart your terminal, then run 'gjc' to get started!"
        } else {
            Write-Host "Run 'gjc' to get started!"
        }
    } finally {
        Remove-Item -Force $DownloadTmp -ErrorAction SilentlyContinue
        # DeleteOnClose removes the lock file as the handle closes.
        $lockStream.Dispose()
    }
}

if ($Source -and $Binary) {
    throw "Specify only one of -Source or -Binary."
}

if ($Source) {
    if (-not (Test-BunInstalled)) {
        throw @"
-Source requires an existing Bun $MinimumBunVersion+ on PATH.
This installer never downloads Bun. Install it from https://bun.sh/docs/installation
Ordinary installs should omit -Source and use the prebuilt binary.
"@
    }
    Assert-BunVersion $MinimumBunVersion
    Install-ViaBun
} else {
    Install-Binary
}
