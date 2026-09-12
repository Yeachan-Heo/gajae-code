param(
    [Parameter(Mandatory)][string]$SourcePath,
    [Parameter(Mandatory)][string]$HeadSha,
    [Parameter(Mandatory)][string]$EvidencePath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Every native invocation is checked, including provisioning and cleanup.
function Invoke-Native([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program exited with $LASTEXITCODE" }
}
function Get-LinuxPath([string]$WindowsPath) {
    $value = Invoke-Native wsl.exe @('--distribution', $distro, '--user', 'root', '--exec', 'wslpath', '-u', $WindowsPath)
    return ($value -join "`n").Trim()
}
function Get-Download([string]$Url, [string]$Destination) {
    Invoke-Native curl.exe @('--fail', '--location', '--proto', '=https', '--proto-redir', '=https', '--retry', '2', '--connect-timeout', '30', '--max-time', '600', '--output', $Destination, $Url)
}

if ($HeadSha -cnotmatch '^[0-9a-f]{40}$') { throw 'Expected lowercase 40-hex source SHA' }
$SourcePath = (Resolve-Path -LiteralPath $SourcePath).Path
New-Item -ItemType Directory -Force -Path $EvidencePath | Out-Null
$EvidencePath = (Resolve-Path -LiteralPath $EvidencePath).Path
$distro = 'gjc-drvfs-' + [Guid]::NewGuid().ToString('N')
$ownedRoot = Join-Path $env:RUNNER_TEMP $distro
New-Item -ItemType Directory -Path $ownedRoot | Out-Null
$fixtureParent = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Temp'
$testRoot = Join-Path $fixtureParent ($distro + '-fixtures')
$importAttempted = $false
Start-Transcript -Path (Join-Path $EvidencePath 'host-transcript.txt') | Out-Null
try {
    Get-Volume | Select-Object DriveLetter, FileSystem, FileSystemLabel, HealthStatus | ConvertTo-Json | Set-Content (Join-Path $EvidencePath 'host-volumes.json')
    $fixtureDriveRoot = [IO.Path]::GetPathRoot($testRoot)
    if ($fixtureDriveRoot -cnotmatch '^[A-Za-z]:\\$') { throw 'Fixture temp directory must be on a local Windows drive' }
    $fixtureVolume = Get-Volume -DriveLetter ($fixtureDriveRoot.Substring(0, 1))
    if ($fixtureVolume.FileSystem -cne 'NTFS') { throw 'This qualification requires an NTFS-backed DrvFS fixture' }
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    "distro=$distro`nrunner_image=$env:ImageOS`nrunner_image_version=$env:ImageVersion`nsource=$SourcePath`nwindows_test_root=$testRoot" | Set-Content (Join-Path $EvidencePath 'host.txt')
    Invoke-Native wsl.exe @('--version')
    Invoke-Native wsl.exe @('--status')
    $actualHead = (Invoke-Native git @('-C', $SourcePath, 'rev-parse', 'HEAD')).Trim()
    if ($actualHead -cne $HeadSha) { throw "Source SHA mismatch: $actualHead != $HeadSha" }
    $tree = (Invoke-Native git @('-C', $SourcePath, 'rev-parse', 'HEAD^{tree}')).Trim()
    "head=$actualHead`ntree=$tree" | Set-Content (Join-Path $EvidencePath 'source.txt')
    $bundle = Join-Path $ownedRoot 'source.bundle'
    Invoke-Native git @('-C', $SourcePath, 'bundle', 'create', $bundle, 'HEAD')
    Get-FileHash -Algorithm SHA256 -LiteralPath $bundle | Format-List | Out-File (Join-Path $EvidencePath 'bundle-sha256.txt')

    # Dated official Ubuntu WSL image; never resolve the moving current alias.
    $imageBase = 'https://cloud-images.ubuntu.com/wsl/releases/22.04/20240304'
    $imageName = 'ubuntu-jammy-wsl-amd64-wsl.rootfs.tar.gz'
    $expectedImageHash = 'de9f6149da07b90350a3ccd94b4858b82fef71f0ec2982acb93de583c4c87585'
    $sums = Join-Path $EvidencePath 'ubuntu-SHA256SUMS'
    Get-Download "$imageBase/SHA256SUMS" $sums
    $officialLines = @(Get-Content -LiteralPath $sums | Where-Object { $_ -cmatch ('^[0-9a-f]{64}  ' + [Regex]::Escape($imageName) + '$') })
    if ($officialLines.Count -ne 1 -or $officialLines[0].Substring(0, 64) -cne $expectedImageHash) { throw 'Official image checksum does not match pinned image' }
    $image = Join-Path $ownedRoot $imageName
    Get-Download "$imageBase/$imageName" $image
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $image).Hash.ToLowerInvariant() -cne $expectedImageHash) { throw 'Ubuntu rootfs checksum mismatch' }
    "url=$imageBase/$imageName`nsha256=$expectedImageHash" | Set-Content (Join-Path $EvidencePath 'ubuntu-image.txt')
    $importAttempted = $true
    Invoke-Native wsl.exe @('--import', $distro, (Join-Path $ownedRoot 'distro'), $image, '--version', '1')
    Invoke-Native wsl.exe @('--list', '--verbose')

    # Normalize only the trusted harness copy; target bytes come from git bundle.
    $harness = Join-Path $ownedRoot 'qualify-wsl-drvfs.sh'
    $script = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'qualify-wsl-drvfs.sh')).Replace("`r`n", "`n")
    [IO.File]::WriteAllText($harness, $script, [Text.UTF8Encoding]::new($false))
    Get-FileHash -Algorithm SHA256 -LiteralPath $harness | Format-List | Out-File (Join-Path $EvidencePath 'harness-sha256.txt')
    $linuxHarness = Get-LinuxPath $harness
    $linuxBundle = Get-LinuxPath $bundle
    $linuxEvidence = Get-LinuxPath $EvidencePath
    $linuxRoot = Get-LinuxPath $testRoot
    $drive = [IO.Path]::GetPathRoot($testRoot).TrimEnd('\')
    if ($drive -cnotmatch '^[A-Za-z]:$') { throw 'Test root must be on a Windows drive' }
    Invoke-Native wsl.exe @('--distribution', $distro, '--user', 'root', '--exec', 'cp', '--', $linuxHarness, '/root/qualify-wsl-drvfs.sh')
    Invoke-Native wsl.exe @('--distribution', $distro, '--user', 'root', '--exec', 'env', '-i', 'HOME=/root', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG=C.UTF-8', 'CI=true', 'timeout', '--signal=TERM', '--kill-after=30s', '70m', 'bash', '/root/qualify-wsl-drvfs.sh', $linuxBundle, $HeadSha, $tree, $linuxEvidence, $linuxRoot, $drive)
} finally {
    try {
        # Unique job-owned name only: no global reset, shutdown, or default change.
        if ($importAttempted) { Invoke-Native wsl.exe @('--unregister', $distro) }
    } finally {
        Stop-Transcript | Out-Null
    }
}
