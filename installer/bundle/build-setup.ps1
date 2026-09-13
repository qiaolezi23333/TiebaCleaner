[CmdletBinding()]
param(
    [string]$MsiPath,
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$bundleRoot = $PSScriptRoot
$desktopRoot = (Resolve-Path (Join-Path $bundleRoot '..\..')).Path
$package = Get-Content (Join-Path $desktopRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version

function Get-Sha256Hex([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '')
        }
        finally {
            $algorithm.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

if ([string]::IsNullOrWhiteSpace($MsiPath)) {
    $releaseRoot = Join-Path $desktopRoot 'release'
    $msiCandidates = @(Get-ChildItem -LiteralPath $releaseRoot -File | Where-Object { $_.Name -like "*-$version-win-x64.msi" })
    if ($msiCandidates.Count -ne 1) {
        throw "Expected exactly one MSI for version $version, found $($msiCandidates.Count)."
    }
    $MsiPath = $msiCandidates[0].FullName
}
$resolvedMsi = (Resolve-Path -LiteralPath $MsiPath).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $desktopRoot 'release\setup'
}
$resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($resolvedOutput) | Out-Null

# Refuse to wrap an MSI that lost the native Windows 10/11 build gate.
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($resolvedMsi, 0))
$view = $database.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $database, @('SELECT `Condition` FROM `LaunchCondition`'))
$view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null)
$hasWindowsGate = $false
while ($record = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)) {
    $condition = $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @(1))
    if ($condition -match 'WINDOWS_BUILD_NUMBER' -and $condition -match '10240') {
        $hasWindowsGate = $true
    }
}
if (-not $hasWindowsGate) {
    throw 'The MSI is missing the native Windows 10 Build 10240 LaunchCondition.'
}

# The installed app uses this MSI-owned registration to target exactly its own
# product code when the user starts uninstall from the About page.
$registryView = $database.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $database, @('SELECT `Key`, `Name`, `Value` FROM `Registry`'))
$registryView.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $registryView, $null)
$hasAppUninstallRegistration = $false
while ($record = $registryView.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $registryView, $null)) {
    $key = $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @(1))
    $name = $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @(2))
    $value = $record.GetType().InvokeMember('StringData', 'GetProperty', $null, $record, @(3))
    if ($key -eq 'Software\TiebaCleaner' -and $name -eq 'ProductCode' -and $value -eq '[ProductCode]') {
        $hasAppUninstallRegistration = $true
    }
}
if (-not $hasAppUninstallRegistration) {
    throw 'The MSI is missing the application uninstall registration.'
}

$payloadHash = Get-Sha256Hex $resolvedMsi
$project = Join-Path $bundleRoot 'TiebaCleaner.Bootstrapper\TiebaCleaner.Bootstrapper.csproj'
$publishDirectory = Join-Path $bundleRoot 'artifacts\publish'
$artifactsRoot = [IO.Path]::GetFullPath((Join-Path $bundleRoot 'artifacts'))
$publishFullPath = [IO.Path]::GetFullPath($publishDirectory)
if (-not $publishFullPath.StartsWith($artifactsRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to clean a path outside the bundle artifacts directory.'
}
if (Test-Path -LiteralPath $publishFullPath) {
    Remove-Item -LiteralPath $publishFullPath -Recurse -Force
}

dotnet publish $project `
    --configuration $Configuration `
    --runtime win-x64 `
    --self-contained true `
    --output $publishFullPath `
    --source https://api.nuget.org/v3/index.json `
    -p:MsiPath=$resolvedMsi `
    -p:PayloadSha256=$payloadHash `
    -p:SetupVersion=$version
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed: $LASTEXITCODE" }

$publishedExe = Join-Path $publishFullPath 'TiebaCleaner.Setup.exe'
$artifactName = [IO.Path]::GetFileName($resolvedMsi) -replace '-win-x64\.msi$', '-Setup-x64.exe'
if ($artifactName -eq [IO.Path]::GetFileName($resolvedMsi)) {
    throw 'The MSI file name must end with -win-x64.msi.'
}
$artifactPath = Join-Path $resolvedOutput $artifactName

# The delivery directory contains one distributable file only. Preserve custom
# output directories, but clean our dedicated default directory before copying.
$defaultOutput = [IO.Path]::GetFullPath((Join-Path $desktopRoot 'release\setup'))
if ($resolvedOutput.Equals($defaultOutput, [StringComparison]::OrdinalIgnoreCase)) {
    Get-ChildItem -LiteralPath $resolvedOutput -Force | Remove-Item -Recurse -Force
}
Copy-Item -LiteralPath $publishedExe -Destination $artifactPath -Force

& $artifactPath --self-test
if ($LASTEXITCODE -ne 0) { throw "Setup.exe self-test failed: $LASTEXITCODE" }

$deliveryFiles = @(Get-ChildItem -LiteralPath $resolvedOutput -File -Force)
if ($resolvedOutput.Equals($defaultOutput, [StringComparison]::OrdinalIgnoreCase) -and
    ($deliveryFiles.Count -ne 1 -or $deliveryFiles[0].FullName -ne $artifactPath)) {
    throw 'The Setup delivery directory must contain exactly one EXE.'
}

$artifactHash = (Get-Sha256Hex $artifactPath).ToLowerInvariant()

Write-Host "Setup: $artifactPath"
Write-Host "SHA-256: $artifactHash"
