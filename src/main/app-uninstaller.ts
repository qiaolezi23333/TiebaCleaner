import { execFile, spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { CoreError } from './core/errors'

const PRODUCT_CODE_PATTERN = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/iu

export interface MsiRegistration {
  productCode: string
  version: string
  installLocation: string
}

type ScriptRunner = (script: string) => Promise<string>

export async function findMsiRegistration(
  appVersion: string,
  executablePath: string,
  runScript: ScriptRunner = runPowerShell
): Promise<MsiRegistration | null> {
  if (process.platform !== 'win32' && runScript === runPowerShell) return null
  let output: string
  try {
    output = await runScript(registrationLookupScript())
  } catch {
    return null
  }
  const registrations = parseMsiRegistrations(output)
  if (!registrations.length) return null

  const executableDirectory = normalizePath(dirname(executablePath))
  const matchingLocation = registrations.find(
    (item) => item.installLocation && normalizePath(item.installLocation) === executableDirectory
  )
  if (matchingLocation) return matchingLocation

  const matchingVersion = registrations.find(
    (item) => normalizeVersion(item.version) === normalizeVersion(appVersion)
  )
  return matchingVersion ?? null
}

export function parseMsiRegistrations(output: string): MsiRegistration[] {
  const unique = new Map<string, MsiRegistration>()
  for (const line of output.split(/\r?\n/gu)) {
    const [rawCode = '', rawVersion = '', ...locationParts] = line.trim().split('\t')
    const productCode = rawCode.trim()
    if (!PRODUCT_CODE_PATTERN.test(productCode)) continue
    unique.set(productCode.toUpperCase(), {
      productCode: productCode.toUpperCase(),
      version: rawVersion.trim(),
      installLocation: locationParts.join('\t').trim()
    })
  }
  return [...unique.values()]
}

export function launchMsiUninstaller(registration: MsiRegistration, parentPid: number): void {
  if (process.platform !== 'win32')
    throw new CoreError('INVALID_INPUT', '仅 Windows 安装版支持卸载')
  if (!PRODUCT_CODE_PATTERN.test(registration.productCode) || !Number.isInteger(parentPid)) {
    throw new CoreError('INVALID_INPUT', '安装信息无效，无法启动卸载')
  }
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Wait-Process -Id ${parentPid} -Timeout 30`,
    `$msiexec = Join-Path $env:SystemRoot 'System32\\msiexec.exe'`,
    `Start-Process -FilePath $msiexec -ArgumentList @('/x${registration.productCode}', '/passive', '/norestart')`
  ].join('; ')
  const child = spawn(powerShellPath(), encodedPowerShellArguments(script), {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
}

function registrationLookupScript(): string {
  return String.raw`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$records = @()
foreach ($path in @('HKCU:\Software\TiebaCleaner', 'HKLM:\Software\TiebaCleaner')) {
  $item = Get-ItemProperty -LiteralPath $path -ErrorAction SilentlyContinue
  if ($item -and $item.ProductCode) {
    $records += [PSCustomObject]@{ ProductCode = [string]$item.ProductCode; Version = [string]$item.Version; InstallLocation = [string]$item.InstallLocation }
  }
}
if ($records.Count -eq 0) {
  foreach ($path in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    $records += Get-ItemProperty -Path $path -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq '贴吧清理助手' -and $_.PSChildName -match '^\{[0-9A-Fa-f-]+\}$' } |
      ForEach-Object { [PSCustomObject]@{ ProductCode = [string]$_.PSChildName; Version = [string]$_.DisplayVersion; InstallLocation = [string]$_.InstallLocation } }
  }
}
foreach ($record in $records) {
  Write-Output ($record.ProductCode + [char]9 + $record.Version + [char]9 + $record.InstallLocation)
}`
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      powerShellPath(),
      encodedPowerShellArguments(script),
      { encoding: 'utf8', timeout: 10_000, windowsHide: true, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) reject(error)
        else resolveOutput(stdout)
      }
    )
  })
}

function encodedPowerShellArguments(script: string): string[] {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
}

function powerShellPath(): string {
  return join(
    process.env['SystemRoot'] || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
}

function normalizeVersion(value: string): string {
  const parts = value
    .trim()
    .split('.')
    .map((part) => Number.parseInt(part, 10))
  while (parts.length > 3 && parts.at(-1) === 0) parts.pop()
  return parts.join('.')
}

function normalizePath(value: string): string {
  return resolve(value)
    .replace(/[\\/]+$/u, '')
    .toLowerCase()
}
