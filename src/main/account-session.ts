import {
  BrowserWindow,
  session,
  type BrowserWindowConstructorOptions,
  type Cookie,
  type Session
} from 'electron'
import { createHash } from 'node:crypto'
import type { AccountSummary, AppSettings } from '../shared/types'
import { signClientParams } from './core/client-sign'
import { CoreError, toCoreError } from './core/errors'
import { parseCookieHeader } from './cookie'

const ACCOUNT_PARTITION = 'persist:tieba-account'
const TBS_URL = 'https://tieba.baidu.com/dc/common/tbs'
const PROFILE_URL = 'https://tieba.baidu.com/f/user/json_userinfo'
const MODERN_PROFILE_URL =
  'https://tieba.baidu.com/c/u/pc/homeSidebarRight?subapp_type=pc&_client_type=20'
const CLIENT_LOGIN_URL = 'https://tiebac.baidu.com/c/s/login'
const CLIENT_VERSION = '22.6.5.1'
const LOGIN_URL = 'https://passport.baidu.com/v2/?login&tpl=tb&u=https%3A%2F%2Ftieba.baidu.com%2F'
const CREDENTIAL_COOKIE_NAMES = ['BDUSS', 'BDUSS_BFESS', 'STOKEN', 'PTOKEN', 'PASSID'] as const
const LOGIN_POLL_INTERVAL_MS = 2_000

type LoginWindowFactory = (options: BrowserWindowConstructorOptions) => BrowserWindow

interface TbsResponse {
  is_login?: number | boolean
  tbs?: string
}

interface ProfileResponse {
  no?: number
  data?: {
    user_id?: number | string
    user_name?: string
    user_name_show?: string
    portrait?: string
  }
}

interface ModernProfileResponse {
  error_code?: number | string
  data?: {
    user?: {
      id?: number | string
      name?: string
      name_show?: string
      portrait?: string
      user_show_info?: {
        feed_head?: {
          image_data?: {
            img_url?: string
          }
        }
      }
    }
  }
}

interface ClientLoginResponse {
  error_code?: number | string
  user?: {
    id?: number | string
    name?: string
    portrait?: string
  }
}

export class AccountSession {
  readonly session: Session
  private loginWindow: BrowserWindow | null = null
  private loginCompletion: Promise<AccountSummary> | null = null
  private status: AccountSummary
  private timeoutMs = 15_000
  private revision = 0

  constructor(
    accountSession: Session = session.fromPartition(ACCOUNT_PARTITION),
    private readonly createLoginWindow: LoginWindowFactory = (options) =>
      new BrowserWindow(options),
    readonly accountId = 'legacy',
    initialStatus?: AccountSummary
  ) {
    this.session = accountSession
    this.status =
      initialStatus?.accountId === accountId ? { ...initialStatus } : emptyAccount(accountId)
    this.session.setPermissionCheckHandler(() => false)
    this.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false)
    )
  }

  async applySettings(settings: AppSettings): Promise<void> {
    this.timeoutMs = settings.requestTimeoutMs
    if (settings.proxyMode === 'manual') {
      await this.session.setProxy({ mode: 'fixed_servers', proxyRules: settings.manualProxyUrl })
    } else {
      await this.session.setProxy({ mode: settings.proxyMode })
    }
    await this.session.closeAllConnections()
  }

  getCachedStatus(): AccountSummary {
    return { ...this.status }
  }

  async verify(signal?: AbortSignal): Promise<AccountSummary> {
    const revision = this.revision
    const cached = this.getCachedStatus()
    const cachedUsername = usableProfileName(cached.username)
    const cachedDisplayName = usableProfileName(cached.displayName)
    try {
      const tbs = await this.fetchJson<TbsResponse>(TBS_URL, signal)
      if (!tbs.tbs || !(tbs.is_login === true || tbs.is_login === 1)) {
        if (revision === this.revision) this.status = emptyAccount(this.accountId)
        return this.getCachedStatus()
      }

      let profile: ProfileResponse | undefined
      try {
        profile = await this.fetchJson<ProfileResponse>(PROFILE_URL, signal)
      } catch {
        // TBS is the source of truth. A profile endpoint/layout failure must not
        // incorrectly turn a valid login into an expired login.
      }

      let modernProfile: ModernProfileResponse | undefined
      if (
        !profile?.data?.user_name &&
        !profile?.data?.user_name_show &&
        !cachedUsername &&
        !cachedDisplayName
      ) {
        try {
          modernProfile = await this.fetchJson<ModernProfileResponse>(MODERN_PROFILE_URL, signal)
        } catch {
          // Keep login valid and retain the last verified public profile.
        }
      }

      const modernUser = modernProfile?.data?.user
      const portrait = profile?.data?.portrait || modernUser?.portrait || cached.portrait || null
      const avatarUrl =
        (portrait
          ? `https://himg.bdimg.com/sys/portrait/item/${encodeURIComponent(portrait)}.jpg`
          : modernUser?.user_show_info?.feed_head?.image_data?.img_url) ||
        cached.avatarUrl ||
        null
      const username = profile?.data?.user_name || modernUser?.name || cachedUsername || null
      const displayName =
        profile?.data?.user_name_show ||
        profile?.data?.user_name ||
        modernUser?.name_show ||
        modernUser?.name ||
        cachedDisplayName ||
        '百度贴吧用户'
      const status: AccountSummary = {
        accountId: this.accountId,
        loggedIn: true,
        uid:
          profile?.data?.user_id != null
            ? String(profile.data.user_id)
            : modernUser?.id != null
              ? String(modernUser.id)
              : cached.uid,
        username,
        displayName,
        avatarUrl,
        portrait,
        verifiedAt: new Date().toISOString()
      }
      if (revision === this.revision) this.status = status
      return this.getCachedStatus()
    } catch (error) {
      throw toCoreError(error)
    }
  }

  async getTbs(): Promise<string> {
    const data = await this.fetchJson<TbsResponse>(TBS_URL)
    if (!data.tbs || !(data.is_login === true || data.is_login === 1)) {
      throw new CoreError('AUTH_EXPIRED')
    }
    return data.tbs
  }

  async importCookie(rawCookie: string): Promise<AccountSummary> {
    const cookies = parseCookieHeader(rawCookie)
    return this.importCookies(cookies)
  }

  async importCookies(cookies: Array<{ name: string; value: string }>): Promise<AccountSummary> {
    if (cookies.length === 0 || cookies.length > 256) {
      throw new CoreError('INVALID_INPUT', '没有可导入的 Cookie')
    }
    for (const cookie of cookies) {
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(cookie.name) ||
        cookie.name.length > 256 ||
        cookie.value.length > 16_384 ||
        containsInvalidCookieValueCharacter(cookie.value)
      ) {
        throw new CoreError('INVALID_INPUT', 'Cookie 字段格式不正确')
      }
    }
    await this.clearAccountData()

    for (const cookie of cookies) {
      const hostOnly = cookie.name.startsWith('__Host-')
      await this.session.cookies.set({
        url: 'https://tieba.baidu.com/',
        name: cookie.name,
        value: cookie.value,
        path: '/',
        secure: true,
        httpOnly: /^(?:BDUSS|BDUSS_BFESS|STOKEN|PTOKEN|PASSID)$/iu.test(cookie.name),
        expirationDate: Math.floor(Date.now() / 1_000) + 180 * 24 * 60 * 60,
        ...(hostOnly ? {} : { domain: '.baidu.com' })
      })
    }
    await this.session.cookies.flushStore()
    await this.session.closeAllConnections()
    return this.verify()
  }

  async openLogin(
    parent: BrowserWindow,
    onStatus: (status: AccountSummary) => void
  ): Promise<AccountSummary> {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus()
      return this.loginCompletion ?? Promise.resolve(this.getCachedStatus())
    }

    await this.clearAccountData()

    const loginWindow = this.createLoginWindow({
      parent,
      modal: false,
      width: 980,
      height: 760,
      minWidth: 760,
      minHeight: 620,
      title: '登录百度贴吧',
      autoHideMenuBar: true,
      webPreferences: {
        session: this.session,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false
      }
    })
    this.loginWindow = loginWindow
    loginWindow.setTitle('登录百度贴吧 · 请在窗口中完成登录')

    const preventUnsafeNavigation = (event: Electron.Event, url: string): void => {
      if (!isAllowedBaiduUrl(url)) event.preventDefault()
    }
    loginWindow.webContents.on('will-navigate', preventUnsafeNavigation)
    loginWindow.webContents.on('will-redirect', preventUnsafeNavigation)
    loginWindow.webContents.on('page-title-updated', (event) => event.preventDefault())
    loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    let settled = false
    let windowClosed = false
    let pendingCredentialRecheck = false
    let loginTimer: NodeJS.Timeout | null = null
    let pollController: AbortController | null = null
    let pollPromise: Promise<void> | null = null
    let resolveCompletion: (status: AccountSummary) => void = () => undefined
    let rejectCompletion: (error: CoreError) => void = () => undefined
    const completion = new Promise<AccountSummary>((resolve, reject) => {
      resolveCompletion = resolve
      rejectCompletion = reject
    })
    this.loginCompletion = completion

    const stopWatching = (): void => {
      if (loginTimer) clearInterval(loginTimer)
      loginTimer = null
      this.session.cookies.removeListener('changed', handleCookieChanged)
      if (this.loginWindow === loginWindow) this.loginWindow = null
    }

    const releaseCompletion = (): void => {
      if (this.loginCompletion === completion) this.loginCompletion = null
    }

    const settle = async (status: AccountSummary, forceClose: boolean): Promise<void> => {
      if (settled) return
      settled = true
      stopWatching()
      try {
        if (status.loggedIn) await this.session.cookies.flushStore()
        if (status.loggedIn) onStatus(status)
        resolveCompletion(status)
      } catch (error) {
        rejectCompletion(toCoreError(error))
      } finally {
        releaseCompletion()
        if (forceClose && !loginWindow.isDestroyed()) {
          // Remote pages may cancel BrowserWindow.close() with beforeunload. Once
          // the account is verified, destroy the isolated login window so the IPC
          // request always resolves and the main UI can refresh immediately.
          loginWindow.destroy()
        }
      }
    }

    const runPoll = async (signal: AbortSignal): Promise<void> => {
      try {
        loginWindow.setTitle('登录百度贴吧 · 正在验证登录状态…')
        const status = await this.verify(signal)
        if (status.loggedIn && !windowClosed && !loginWindow.isDestroyed()) {
          await settle(status, true)
        } else if (!windowClosed && !loginWindow.isDestroyed()) {
          loginWindow.setTitle('登录百度贴吧 · 等待有效的贴吧登录凭证')
        }
      } catch (error) {
        if (!signal.aborted && !windowClosed && !settled && !loginWindow.isDestroyed()) {
          const coreError = toCoreError(error)
          loginWindow.setTitle(
            coreError.code === 'NETWORK_TIMEOUT'
              ? '登录百度贴吧 · 验证超时，请检查网络或代理'
              : '登录百度贴吧 · 验证失败，稍后将自动重试'
          )
        }
      }
    }

    const pollLogin = (credentialTriggered = false): void => {
      if (settled || windowClosed || loginWindow.isDestroyed()) return
      if (pollPromise) {
        if (credentialTriggered) pendingCredentialRecheck = true
        return
      }

      const controller = new AbortController()
      pollController = controller
      const currentPoll = runPoll(controller.signal)
      pollPromise = currentPoll
      void currentPoll.finally(() => {
        if (pollPromise === currentPoll) pollPromise = null
        if (pollController === controller) pollController = null
        if (pendingCredentialRecheck && !settled && !windowClosed) {
          pendingCredentialRecheck = false
          pollLogin(true)
        }
      })
    }

    const handleCookieChanged = (
      _event: Electron.Event,
      cookie: Cookie,
      _cause: string,
      removed: boolean
    ): void => {
      if (!removed && isCredentialCookie(cookie)) pollLogin(true)
    }

    loginWindow.webContents.on('did-finish-load', () => pollLogin())
    this.session.cookies.on('changed', handleCookieChanged)
    loginTimer = setInterval(() => pollLogin(), LOGIN_POLL_INTERVAL_MS)
    loginWindow.on('closed', () => {
      if (settled) return
      windowClosed = true
      stopWatching()
      pollController?.abort()
      const activePoll = pollPromise
      void (async () => {
        if (activePoll) await activePoll
        try {
          await settle(await this.verifyAfterLoginWindowClosed(), false)
        } catch (error) {
          if (settled) return
          settled = true
          releaseCompletion()
          rejectCompletion(toCoreError(error))
        }
      })()
    })
    void loginWindow.loadURL(LOGIN_URL).catch(() => {
      if (!windowClosed && !loginWindow.isDestroyed()) {
        loginWindow.setTitle('登录百度贴吧 · 页面加载失败，请检查网络或代理')
      }
    })
    return completion
  }

  async getAccountKey(): Promise<string> {
    const credential = await this.getCredentialCookie()
    if (!credential) throw new CoreError('AUTH_EXPIRED')
    return createHash('sha256').update(`${credential.name}:${credential.value}`).digest('hex')
  }

  /** Sensitive values for same-process official client requests. */
  async getPrivateQueryCredential(): Promise<{ uid: string | null; bduss: string } | null> {
    if (!this.status.loggedIn) return null
    const credential = await this.getBdussCookie()
    if (!credential?.value) return null
    const uid = this.status.uid ?? (await this.resolveClientIdentity(credential.value))
    return { uid, bduss: credential.value }
  }

  async hasCredentials(): Promise<boolean> {
    return Boolean(await this.getCredentialCookie())
  }

  async logout(): Promise<AccountSummary> {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) this.loginWindow.close()
    await this.clearAccountData()
    return this.getCachedStatus()
  }

  private async clearAccountData(): Promise<void> {
    this.revision += 1
    this.status = emptyAccount(this.accountId)
    await this.session.clearStorageData({
      storages: ['cookies', 'localstorage', 'cachestorage', 'indexdb', 'serviceworkers']
    })
    await this.session.clearCache()
  }

  private async getCredentialCookie(): Promise<Cookie | undefined> {
    const cookies = await this.session.cookies.get({ url: 'https://tieba.baidu.com/' })
    return CREDENTIAL_COOKIE_NAMES.map((name) =>
      cookies.find((cookie) => cookie.name.toUpperCase() === name)
    ).find((cookie): cookie is Cookie => cookie !== undefined)
  }

  private async getBdussCookie(): Promise<Cookie | undefined> {
    const cookies = await this.session.cookies.get({ url: 'https://tieba.baidu.com/' })
    return (
      cookies.find((cookie) => cookie.name.toUpperCase() === 'BDUSS') ??
      cookies.find((cookie) => cookie.name.toUpperCase() === 'BDUSS_BFESS')
    )
  }

  /**
   * Some current Tieba web profile endpoints omit the numeric user id. Resolve
   * it locally through Tieba's official client login endpoint so the protobuf
   * user-post feed can still be queried. Failure is deliberately best-effort:
   * ordinary web queries and direct follower removal only require BDUSS.
   */
  private async resolveClientIdentity(bduss: string): Promise<string | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const unsigned = {
        _client_version: CLIENT_VERSION,
        bdusstoken: bduss
      }
      const params = { ...unsigned, sign: signClientParams(unsigned) }
      const response = await this.session.fetch(CLIENT_LOGIN_URL, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json,text/plain,*/*',
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
        },
        body: new URLSearchParams(params).toString()
      })
      if (!response.ok) return null
      const result = (await response.json()) as ClientLoginResponse
      if (Number(result.error_code ?? -1) !== 0) return null
      const uid = result.user?.id == null ? '' : String(result.user.id)
      if (!/^\d+$/u.test(uid)) return null

      const portrait = result.user?.portrait?.trim() || this.status.portrait
      this.status = {
        ...this.status,
        uid,
        username: usableProfileName(this.status.username) || result.user?.name?.trim() || null,
        portrait,
        avatarUrl:
          this.status.avatarUrl ||
          (portrait
            ? `https://himg.bdimg.com/sys/portrait/item/${encodeURIComponent(portrait)}.jpg`
            : null)
      }
      return uid
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private async verifyAfterLoginWindowClosed(): Promise<AccountSummary> {
    if (!(await this.getCredentialCookie())) return this.getCachedStatus()
    return this.verify()
  }

  private async fetchJson<T>(url: string, externalSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const abortFromExternal = (): void => controller.abort()
    if (externalSignal?.aborted) controller.abort()
    else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.session.fetch(url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          Accept: 'application/json,text/plain,*/*',
          Referer: 'https://tieba.baidu.com/',
          'X-Requested-With': 'XMLHttpRequest'
        }
      })
      if (!response.ok) {
        throw new CoreError('HTTP_ERROR', `贴吧服务请求失败（${response.status}）`, {
          retryable: response.status >= 500,
          status: response.status
        })
      }
      return (await response.json()) as T
    } finally {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', abortFromExternal)
    }
  }
}

function isCredentialCookie(cookie: Pick<Cookie, 'name' | 'domain'>): boolean {
  const domain = (cookie.domain ?? '').replace(/^\./u, '').toLowerCase()
  return (
    (domain === 'baidu.com' || domain.endsWith('.baidu.com')) &&
    CREDENTIAL_COOKIE_NAMES.includes(
      cookie.name.toUpperCase() as (typeof CREDENTIAL_COOKIE_NAMES)[number]
    )
  )
}

function usableProfileName(value: string | null | undefined): string | null {
  const name = value?.trim()
  if (!name || /^(?:百度)?贴吧用户$|^未知用户$/u.test(name)) return null
  return name
}

function containsInvalidCookieValueCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return character === ';' || code < 0x20 || code === 0x7f
  })
}

function isAllowedBaiduUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    return (
      url.protocol === 'https:' &&
      ['tieba.baidu.com', 'passport.baidu.com', 'wappass.baidu.com', 'wapp.baidu.com'].includes(
        host
      )
    )
  } catch {
    return false
  }
}

function emptyAccount(accountId: string): AccountSummary {
  return {
    accountId,
    loggedIn: false,
    uid: null,
    username: null,
    displayName: null,
    avatarUrl: null,
    portrait: null,
    verifiedAt: null
  }
}
