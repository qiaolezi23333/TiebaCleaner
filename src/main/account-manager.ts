import {
  BrowserWindow,
  session,
  type BrowserWindowConstructorOptions,
  type Session
} from 'electron'
import { randomUUID } from 'node:crypto'
import type {
  AccountState,
  AccountSummary,
  AppSettings,
  CookieFieldInput,
  CookieImportInput
} from '../shared/types'
import { CoreError } from './core/errors'
import { AccountSession } from './account-session'
import {
  AccountRegistryStore,
  type StoredAccountRecord,
  type StoredAccountRegistry
} from './storage'

const LEGACY_ACCOUNT_ID = 'legacy'
const LEGACY_PARTITION = 'persist:tieba-account'
const ACCOUNT_PARTITION_PREFIX = 'persist:tieba-account-'

type SessionFactory = (partition: string) => Session
type LoginWindowFactory = (options: BrowserWindowConstructorOptions) => BrowserWindow

export interface AccountSessionManagerOptions {
  store?: Pick<AccountRegistryStore, 'get' | 'save'>
  createSession?: SessionFactory
  createLoginWindow?: LoginWindowFactory
}

interface ManagedAccount {
  partition: string
  session: AccountSession
}

/**
 * Owns the public account registry and one isolated persistent Chromium session
 * per account. Credentials remain inside Electron's cookie stores and are never
 * serialized into the registry or returned over IPC.
 */
export class AccountSessionManager {
  private readonly store: Pick<AccountRegistryStore, 'get' | 'save'>
  private readonly createSession: SessionFactory
  private readonly createLoginWindow: LoginWindowFactory
  private readonly accounts = new Map<string, ManagedAccount>()
  private selectedAccountId: string | null = null
  private settings: AppSettings | null = null

  constructor(options: AccountSessionManagerOptions = {}) {
    this.store = options.store ?? new AccountRegistryStore()
    this.createSession = options.createSession ?? ((partition) => session.fromPartition(partition))
    this.createLoginWindow =
      options.createLoginWindow ?? ((windowOptions) => new BrowserWindow(windowOptions))
  }

  async initialize(settings: AppSettings): Promise<AccountState> {
    this.settings = { ...settings }
    const registry = await this.store.get()
    for (const record of registry.accounts) {
      const managed = this.createManaged(record.accountId, record.partition, record.summary)
      this.accounts.set(record.accountId, managed)
      await managed.session.applySettings(settings)
    }
    this.selectedAccountId = this.accounts.has(registry.selectedAccountId ?? '')
      ? registry.selectedAccountId
      : (this.accounts.keys().next().value ?? null)

    if (this.accounts.size === 0) {
      await this.migrateLegacyAccount(settings)
    } else if (this.selectedAccountId) {
      try {
        await this.getAccount(this.selectedAccountId).verify()
        await this.persist()
      } catch {
        // Keep the last verified public summary during a transient startup outage.
      }
    }
    return this.getState()
  }

  getState(): AccountState {
    return {
      accounts: [...this.accounts.values()].map(({ session: account }) =>
        account.getCachedStatus()
      ),
      selectedAccountId: this.selectedAccountId
    }
  }

  getAccount(accountId: string): AccountSession {
    const account = this.accounts.get(accountId)?.session
    if (!account) throw new CoreError('INVALID_INPUT', '所选账号不存在，请重新选择')
    return account
  }

  async select(accountId: string): Promise<AccountState> {
    const account = this.getAccount(accountId)
    this.selectedAccountId = accountId
    try {
      await account.verify()
    } catch {
      // Selection is local and remains available during a temporary network outage.
    }
    await this.persist()
    return this.getState()
  }

  async openLogin(
    parent: BrowserWindow,
    onStatus: (status: AccountSummary) => void,
    accountId?: string
  ): Promise<AccountState> {
    const candidate = accountId ? this.getManaged(accountId) : await this.createCandidate()
    try {
      const status = await candidate.session.openLogin(parent, onStatus)
      if (!status.loggedIn) {
        if (accountId) await this.persist()
        else await candidate.session.logout()
        return this.getState()
      }
      this.accounts.set(status.accountId, candidate)
      this.selectedAccountId = status.accountId
      await this.persist()
      return this.getState()
    } catch (error) {
      if (!accountId) await candidate.session.logout().catch(() => undefined)
      throw error
    }
  }

  async importCookie(input: CookieImportInput): Promise<AccountState> {
    const candidate = input.accountId
      ? this.getManaged(input.accountId)
      : await this.createCandidate()
    try {
      const status = input.fields
        ? await candidate.session.importCookies(normalizeCookieFields(input.fields))
        : await candidate.session.importCookie(input.rawCookie ?? '')
      if (!status.loggedIn) throw new CoreError('AUTH_EXPIRED')
      this.accounts.set(status.accountId, candidate)
      this.selectedAccountId = status.accountId
      await this.persist()
      return this.getState()
    } catch (error) {
      if (input.accountId) await this.persist().catch(() => undefined)
      else await candidate.session.logout().catch(() => undefined)
      throw error
    }
  }

  async verify(accountId?: string): Promise<AccountState> {
    const targetId = accountId ?? this.selectedAccountId
    if (!targetId) return this.getState()
    await this.getAccount(targetId).verify()
    await this.persist()
    return this.getState()
  }

  async logout(accountId: string): Promise<AccountState> {
    const account = this.getAccount(accountId)
    await account.logout()
    this.accounts.delete(accountId)
    if (this.selectedAccountId === accountId) {
      this.selectedAccountId = this.accounts.keys().next().value ?? null
    }
    await this.persist()
    return this.getState()
  }

  async logoutAll(): Promise<AccountState> {
    let firstError: unknown
    for (const { session: account } of this.accounts.values()) {
      try {
        await account.logout()
      } catch (error) {
        firstError ??= error
      }
    }
    this.accounts.clear()
    this.selectedAccountId = null
    await this.persist()
    if (firstError) throw firstError
    return this.getState()
  }

  async applySettings(settings: AppSettings): Promise<void> {
    await Promise.all(
      [...this.accounts.values()].map(({ session: account }) => account.applySettings(settings))
    )
    this.settings = { ...settings }
  }

  private getManaged(accountId: string): ManagedAccount {
    const account = this.accounts.get(accountId)
    if (!account) throw new CoreError('INVALID_INPUT', '所选账号不存在，请重新选择')
    return account
  }

  private async createCandidate(): Promise<ManagedAccount> {
    const accountId = randomUUID()
    const managed = this.createManaged(accountId, `${ACCOUNT_PARTITION_PREFIX}${accountId}`)
    if (this.settings) await managed.session.applySettings(this.settings)
    return managed
  }

  private createManaged(
    accountId: string,
    partition: string,
    initialStatus?: AccountSummary
  ): ManagedAccount {
    return {
      partition,
      session: new AccountSession(
        this.createSession(partition),
        this.createLoginWindow,
        accountId,
        initialStatus
      )
    }
  }

  private async migrateLegacyAccount(settings: AppSettings): Promise<void> {
    const legacy = this.createManaged(LEGACY_ACCOUNT_ID, LEGACY_PARTITION)
    await legacy.session.applySettings(settings)
    if (!(await legacy.session.hasCredentials())) return
    this.accounts.set(LEGACY_ACCOUNT_ID, legacy)
    this.selectedAccountId = LEGACY_ACCOUNT_ID
    try {
      await legacy.session.verify()
    } catch {
      // Preserve the legacy partition even while offline so it can be verified later.
    }
    await this.persist()
  }

  private async persist(): Promise<void> {
    const registry: StoredAccountRegistry = {
      accounts: [...this.accounts.entries()].map(([accountId, managed]): StoredAccountRecord => ({
        accountId,
        partition: managed.partition,
        summary: managed.session.getCachedStatus()
      })),
      selectedAccountId: this.selectedAccountId
    }
    await this.store.save(registry)
  }
}

function normalizeCookieFields(fields: CookieFieldInput[]): CookieFieldInput[] {
  const unique = new Map<string, CookieFieldInput>()
  for (const field of fields) unique.set(field.name, { ...field })
  return [...unique.values()]
}
