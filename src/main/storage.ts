import { app } from 'electron'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AccountSummary, AppSettings, TaskLogEntry } from '../shared/types'

export const DEFAULT_SETTINGS: AppSettings = {
  proxyMode: 'system',
  manualProxyUrl: '',
  requestTimeoutMs: 15_000,
  scanIntervalMs: 350,
  deleteIntervalMs: 1_200,
  maxPages: 20
}

function dataPath(fileName: string): string {
  return join(app.getPath('userData'), fileName)
}

async function ensureParent(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
}

export class SettingsStore {
  private readonly filePath: string

  constructor(filePath = dataPath('settings.json')) {
    this.filePath = filePath
  }

  async get(): Promise<AppSettings> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      return normalizeSettings(JSON.parse(stripBom(raw)))
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return { ...DEFAULT_SETTINGS }
      throw error
    }
  }

  async save(settings: AppSettings): Promise<AppSettings> {
    await ensureParent(this.filePath)
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    const backupPath = `${this.filePath}.${process.pid}.bak`
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    await rm(backupPath, { force: true })
    let hasBackup = false
    try {
      await rename(this.filePath, backupPath)
      hasBackup = true
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    try {
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      if (hasBackup) await rename(backupPath, this.filePath)
      throw error
    } finally {
      await rm(temporaryPath, { force: true })
    }
    if (hasBackup) await rm(backupPath, { force: true }).catch(() => undefined)
    return settings
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true })
  }
}

export interface StoredAccountRecord {
  accountId: string
  partition: string
  summary: AccountSummary
}

export interface StoredAccountRegistry {
  accounts: StoredAccountRecord[]
  selectedAccountId: string | null
}

export class AccountRegistryStore {
  private readonly filePath: string

  constructor(filePath = dataPath('accounts.json')) {
    this.filePath = filePath
  }

  async get(): Promise<StoredAccountRegistry> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      return normalizeAccountRegistry(JSON.parse(stripBom(raw)))
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) return emptyAccountRegistry()
      throw error
    }
  }

  async save(registry: StoredAccountRegistry): Promise<StoredAccountRegistry> {
    const normalized = normalizeAccountRegistry(registry)
    await ensureParent(this.filePath)
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    const backupPath = `${this.filePath}.${process.pid}.bak`
    await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    await rm(backupPath, { force: true })
    let hasBackup = false
    try {
      await rename(this.filePath, backupPath)
      hasBackup = true
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    try {
      await rename(temporaryPath, this.filePath)
    } catch (error) {
      if (hasBackup) await rename(backupPath, this.filePath)
      throw error
    } finally {
      await rm(temporaryPath, { force: true })
    }
    if (hasBackup) await rm(backupPath, { force: true }).catch(() => undefined)
    return normalized
  }
}

function emptyAccountRegistry(): StoredAccountRegistry {
  return { accounts: [], selectedAccountId: null }
}

function normalizeAccountRegistry(value: unknown): StoredAccountRegistry {
  if (!value || typeof value !== 'object') return emptyAccountRegistry()
  const input = value as Record<string, unknown>
  const entries = Array.isArray(input.accounts) ? input.accounts : []
  const accounts = entries.flatMap((entry): StoredAccountRecord[] => {
    if (!entry || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    const accountId = typeof record.accountId === 'string' ? record.accountId : ''
    const partition = typeof record.partition === 'string' ? record.partition : ''
    if (!isSafeAccountId(accountId) || !isSafePartition(partition, accountId)) return []
    const summary = normalizeAccountSummary(record.summary, accountId)
    return [{ accountId, partition, summary }]
  })
  const uniqueAccounts = [
    ...new Map(accounts.map((account) => [account.accountId, account])).values()
  ]
  const selected = typeof input.selectedAccountId === 'string' ? input.selectedAccountId : null
  return {
    accounts: uniqueAccounts,
    selectedAccountId: uniqueAccounts.some((account) => account.accountId === selected)
      ? selected
      : (uniqueAccounts[0]?.accountId ?? null)
  }
}

function normalizeAccountSummary(value: unknown, accountId: string): AccountSummary {
  const input = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const optionalString = (field: string): string | null => {
    const candidate = input[field]
    return typeof candidate === 'string' && candidate.length <= 2_048 ? candidate : null
  }
  const avatarUrl = optionalString('avatarUrl')
  return {
    accountId,
    loggedIn: input.loggedIn === true,
    uid: optionalString('uid'),
    username: optionalString('username'),
    displayName: optionalString('displayName'),
    avatarUrl: avatarUrl && /^https:\/\/himg\.bdimg\.com\//iu.test(avatarUrl) ? avatarUrl : null,
    verifiedAt: optionalString('verifiedAt')
  }
}

function isSafeAccountId(value: string): boolean {
  return (
    value === 'legacy' ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  )
}

function isSafePartition(value: string, accountId: string): boolean {
  return accountId === 'legacy'
    ? value === 'persist:tieba-account'
    : value === `persist:tieba-account-${accountId}`
}

function normalizeSettings(value: unknown): AppSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS }
  const input = value as Record<string, unknown>
  let proxyMode = ['system', 'direct', 'manual'].includes(String(input.proxyMode))
    ? (input.proxyMode as AppSettings['proxyMode'])
    : DEFAULT_SETTINGS.proxyMode
  const manualProxyUrl =
    typeof input.manualProxyUrl === 'string' &&
    input.manualProxyUrl.length <= 2_048 &&
    !/\s/u.test(input.manualProxyUrl)
      ? input.manualProxyUrl
      : DEFAULT_SETTINGS.manualProxyUrl
  if (proxyMode === 'manual' && !manualProxyUrl) proxyMode = 'system'
  return {
    proxyMode,
    manualProxyUrl,
    requestTimeoutMs: safeInteger(
      input.requestTimeoutMs,
      3_000,
      120_000,
      DEFAULT_SETTINGS.requestTimeoutMs
    ),
    scanIntervalMs: safeInteger(input.scanIntervalMs, 0, 10_000, DEFAULT_SETTINGS.scanIntervalMs),
    deleteIntervalMs: safeInteger(
      input.deleteIntervalMs,
      350,
      60_000,
      DEFAULT_SETTINGS.deleteIntervalMs
    ),
    maxPages: safeInteger(input.maxPages, 1, 100, DEFAULT_SETTINGS.maxPages)
  }
}

function safeInteger(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback
}

export class TaskLogStore {
  private readonly filePath: string

  constructor(filePath = dataPath('task-history.jsonl')) {
    this.filePath = filePath
  }

  async append(record: TaskLogEntry): Promise<void> {
    await ensureParent(this.filePath)
    const safeRecord = sanitizeRecord(record)
    await appendFile(this.filePath, `${JSON.stringify(safeRecord)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
  }

  async list(limit = 500): Promise<TaskLogEntry[]> {
    try {
      const text = await readFile(this.filePath, 'utf8')
      return text
        .split(/\r?\n/u)
        .filter(Boolean)
        .slice(-limit)
        .reverse()
        .flatMap((line) => {
          try {
            return [sanitizeRecord(JSON.parse(line) as TaskLogEntry)]
          } catch {
            return []
          }
        })
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true })
  }
}

const SENSITIVE_KEY = /cookie|tbs|token|authorization|headers?|password/i
const COOKIE_VALUE = /(?:^|[;\s])(?:BDUSS|STOKEN|BAIDUID|PTOKEN|PASSID|COOKIE|TBS)\s*=\s*[^;\s]+/gi
const LONG_TOKEN = /\b[A-Za-z0-9_%+/=-]{48,}\b/g

export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(COOKIE_VALUE, ' [已脱敏]').replace(LONG_TOKEN, '[已脱敏]')
  }
  if (Array.isArray(value)) return value.map(sanitizeForLog)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? '[已脱敏]' : sanitizeForLog(item)
      ])
    )
  }
  return value
}

function sanitizeRecord(record: TaskLogEntry): TaskLogEntry {
  return sanitizeForLog(record) as TaskLogEntry
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
