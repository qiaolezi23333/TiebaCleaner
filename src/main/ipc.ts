import { app, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { CoreEngine } from './core/engine'
import { CoreError, toCoreError } from './core/errors'
import type {
  AccountState,
  AppInfo,
  AppSettings,
  CleanupProgress,
  CookieImportInput,
  PreviewResult,
  QueryFilter,
  SerializedCoreError,
  TaskLogEntry,
  TaskSummary,
  UninstallDataMode
} from '../shared/types'
import type { AccountSessionManager } from './account-manager'
import { sanitizeForLog, type SettingsStore, type TaskLogStore } from './storage'

export const IPC_CHANNELS = {
  accountList: 'tieba:account:list',
  accountSelect: 'tieba:account:select',
  accountOpenLogin: 'tieba:account:open-login',
  accountImportCookie: 'tieba:account:import-cookie',
  accountVerify: 'tieba:account:verify',
  accountLogout: 'tieba:account:logout',
  cleanupQuery: 'tieba:cleanup:query',
  cleanupStart: 'tieba:cleanup:start',
  cleanupStop: 'tieba:cleanup:stop',
  tasksList: 'tieba:tasks:list',
  tasksClear: 'tieba:tasks:clear',
  settingsGet: 'tieba:settings:get',
  settingsSave: 'tieba:settings:save',
  appInfo: 'tieba:app:info',
  appUninstall: 'tieba:app:uninstall',
  appQuit: 'tieba:app:quit',
  taskEvent: 'tieba:event:task',
  logEvent: 'tieba:event:log'
} as const

interface IpcSuccess<T> {
  ok: true
  data: T
}

interface IpcFailure {
  ok: false
  error: SerializedCoreError
}

export type IpcResponse<T> = IpcSuccess<T> | IpcFailure

const kindSchema = z.enum(['reply', 'post', 'followingUser', 'followingForum', 'follower'])
const dateSchema = z
  .string()
  .trim()
  .max(40)
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isNaN(Date.parse(value)), {
    message: '日期格式不正确'
  })
  .optional()

const querySchema = z
  .object({
    kind: kindSchema,
    startDate: dateSchema,
    endDate: dateSchema,
    keyword: z.string().trim().max(100).optional(),
    forumName: z.string().trim().max(100).optional(),
    maxPages: z.number().int().min(1).max(100)
  })
  .strict()

const startSchema = z
  .object({
    accountId: z.union([z.string().uuid(), z.literal('legacy')]),
    previewId: z.string().uuid(),
    itemIds: z.array(z.string().min(1).max(256)).min(1).max(10_000)
  })
  .strict()
  .refine((value) => new Set(value.itemIds).size === value.itemIds.length, {
    message: '项目列表中存在重复项'
  })

const accountIdSchema = z.union([z.string().uuid(), z.literal('legacy')])
const accountTargetSchema = z.object({ accountId: accountIdSchema }).strict()
const optionalAccountTargetSchema = z
  .object({ accountId: accountIdSchema.optional() })
  .strict()
  .optional()
const cookieFieldSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u),
    value: z
      .string()
      .max(16_384)
      .refine((value) => !containsInvalidCookieValueCharacter(value), {
        message: 'Cookie 值包含不允许的字符'
      })
  })
  .strict()
const cookieImportSchema = z
  .object({
    accountId: accountIdSchema.optional(),
    rawCookie: z.string().trim().min(1).max(65_536).optional(),
    fields: z.array(cookieFieldSchema).min(1).max(256).optional()
  })
  .strict()
  .refine((value) => Boolean(value.rawCookie) !== Boolean(value.fields), {
    message: '请粘贴完整 Cookie，或填写 Cookie 字段'
  })
  .refine(
    (value) =>
      !value.fields ||
      value.fields.reduce((size, field) => size + field.name.length + field.value.length + 1, 0) <=
        65_536,
    { message: 'Cookie 内容过长' }
  )
const cleanupQuerySchema = z.object({ accountId: accountIdSchema, filter: querySchema }).strict()
const proxySchema = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => !/\s/u.test(value), { message: '代理地址不能包含空格' })

const settingsSchema = z
  .object({
    proxyMode: z.enum(['system', 'direct', 'manual']),
    manualProxyUrl: proxySchema,
    requestTimeoutMs: z.number().int().min(3_000).max(120_000),
    scanIntervalMs: z.number().int().min(0).max(10_000),
    deleteIntervalMs: z.number().int().min(350).max(60_000),
    maxPages: z.number().int().min(1).max(100)
  })
  .strict()
  .refine((value) => value.proxyMode !== 'manual' || value.manualProxyUrl.length > 0, {
    message: '手动代理模式必须填写代理地址',
    path: ['manualProxyUrl']
  })

const uninstallSchema = z.object({ dataMode: z.enum(['keep', 'logout', 'clear']) }).strict()

interface IpcDependencies {
  mainWindow: BrowserWindow
  accounts: AccountSessionManager
  getEngine: (accountId: string) => CoreEngine
  invalidateEngine: (accountId: string, remove?: boolean) => void
  settingsStore: SettingsStore
  taskLogStore: TaskLogStore
  getSettings: () => AppSettings
  setSettings: (settings: AppSettings) => void
  getAppInfo: () => Promise<AppInfo>
  uninstallApp: (dataMode: UninstallDataMode) => Promise<void>
}

export function registerIpcHandlers(dependencies: IpcDependencies): () => void {
  const {
    mainWindow,
    accounts,
    getEngine,
    invalidateEngine,
    settingsStore,
    taskLogStore,
    getSettings,
    setSettings,
    getAppInfo,
    uninstallApp
  } = dependencies
  let active: {
    kind: 'query' | 'cleanup' | 'session'
    controller: AbortController | null
  } | null = null

  const send = (channel: string, payload: unknown): void => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, sanitizeForLog(payload))
  }

  const assertIdle = (): void => {
    if (active) throw new CoreError('BUSY')
  }

  const preventCloseWhileBusy = (event: Electron.Event): void => {
    if (!active) return
    event.preventDefault()
    send(
      IPC_CHANNELS.logEvent,
      makeShellLog('warning', 'app.close-blocked', '当前操作尚未结束，请先停止任务')
    )
  }
  mainWindow.on('close', preventCloseWhileBusy)

  const install = <T>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<T> | T
  ): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, input): Promise<IpcResponse<T>> => {
      try {
        assertTrustedSender(event, mainWindow)
        return { ok: true, data: await handler(event, input) }
      } catch (error) {
        return { ok: false, error: serializeSafeError(error) }
      }
    })
  }

  install<AccountState>(IPC_CHANNELS.accountList, async () => accounts.getState())
  install<AccountState>(IPC_CHANNELS.accountSelect, async (_event, input) => {
    assertIdle()
    const { accountId } = accountTargetSchema.parse(input)
    active = { kind: 'session', controller: null }
    try {
      return await accounts.select(accountId)
    } finally {
      active = null
    }
  })
  install<AccountState>(IPC_CHANNELS.accountOpenLogin, async (_event, input) => {
    assertIdle()
    const parsed = optionalAccountTargetSchema.parse(input)
    active = { kind: 'session', controller: null }
    if (parsed?.accountId) invalidateEngine(parsed.accountId)
    try {
      return await accounts.openLogin(
        mainWindow,
        (status) => {
          send(
            IPC_CHANNELS.logEvent,
            makeShellLog('success', 'account.login', `${status.displayName ?? '账号'} 登录成功`)
          )
        },
        parsed?.accountId
      )
    } finally {
      active = null
    }
  })
  install<AccountState>(IPC_CHANNELS.accountImportCookie, async (_event, input) => {
    assertIdle()
    const cookieInput = cookieImportSchema.parse(input) as CookieImportInput
    active = { kind: 'session', controller: null }
    if (cookieInput.accountId) invalidateEngine(cookieInput.accountId)
    try {
      const state = await accounts.importCookie(cookieInput)
      send(
        IPC_CHANNELS.logEvent,
        makeShellLog('success', 'account.import', 'Cookie 导入并验证成功')
      )
      return state
    } finally {
      active = null
    }
  })
  install<AccountState>(IPC_CHANNELS.accountVerify, async (_event, input) => {
    assertIdle()
    const { accountId } = accountTargetSchema.parse(input)
    active = { kind: 'session', controller: null }
    try {
      return await accounts.verify(accountId)
    } finally {
      active = null
    }
  })
  install<AccountState>(IPC_CHANNELS.accountLogout, async (_event, input) => {
    assertIdle()
    const { accountId } = accountTargetSchema.parse(input)
    active = { kind: 'session', controller: null }
    invalidateEngine(accountId, true)
    try {
      const state = await accounts.logout(accountId)
      send(IPC_CHANNELS.logEvent, makeShellLog('info', 'account.logout', '已移除所选账号'))
      return state
    } finally {
      active = null
    }
  })

  install<PreviewResult>(IPC_CHANNELS.cleanupQuery, async (_event, input) => {
    assertIdle()
    const parsed = cleanupQuerySchema.parse(input) as {
      accountId: string
      filter: QueryFilter
    }
    const { accountId, filter } = parsed
    const account = accounts.getAccount(accountId)
    const engine = getEngine(accountId)
    const controller = new AbortController()
    active = { kind: 'query', controller }
    try {
      const status = await account.verify()
      if (!status.loggedIn) throw new CoreError('AUTH_EXPIRED')
      const accountKey = await account.getAccountKey()
      const privateQueryCredential = await account.getPrivateQueryCredential()
      return await engine.query(filter, {
        signal: controller.signal,
        requestTimeoutMs: getSettings().requestTimeoutMs,
        pageIntervalMs: getSettings().scanIntervalMs,
        accountKey,
        accountUid: privateQueryCredential?.uid ?? status.uid,
        accountBduss: privateQueryCredential?.bduss,
        accountUsername: status.username ?? status.displayName,
        accountPortrait: status.portrait ?? portraitFromAvatarUrl(status.avatarUrl),
        accountDisplayName: status.displayName,
        accountAvatarUrl: status.avatarUrl
      })
    } finally {
      active = null
    }
  })

  install<TaskSummary>(IPC_CHANNELS.cleanupStart, async (_event, input) => {
    assertIdle()
    const { accountId, previewId, itemIds } = startSchema.parse(input)
    const account = accounts.getAccount(accountId)
    const engine = getEngine(accountId)
    const controller = new AbortController()
    active = { kind: 'cleanup', controller }
    try {
      const status = await account.verify()
      if (!status.loggedIn) throw new CoreError('AUTH_EXPIRED')
      const accountKey = await account.getAccountKey()
      const privateRequestCredential = await account.getPrivateQueryCredential()
      return await engine.execute(previewId, itemIds, {
        intervalMs: getSettings().deleteIntervalMs,
        requestTimeoutMs: getSettings().requestTimeoutMs,
        signal: controller.signal,
        account: status.displayName,
        accountKey,
        accountBduss: privateRequestCredential?.bduss,
        onProgress: (progress: CleanupProgress) => send(IPC_CHANNELS.taskEvent, progress)
      })
    } finally {
      active = null
    }
  })

  install<{ stopped: boolean }>(IPC_CHANNELS.cleanupStop, async () => {
    if (!active?.controller) return { stopped: false }
    active.controller.abort()
    return { stopped: true }
  })

  install<TaskLogEntry[]>(IPC_CHANNELS.tasksList, async () => taskLogStore.list())
  install<void>(IPC_CHANNELS.tasksClear, async () => taskLogStore.clear())
  install<AppSettings>(IPC_CHANNELS.settingsGet, async () => getSettings())
  install<AppSettings>(IPC_CHANNELS.settingsSave, async (_event, input) => {
    assertIdle()
    const settings = settingsSchema.parse(input) as AppSettings
    active = { kind: 'session', controller: null }
    const previousSettings = getSettings()
    try {
      await accounts.applySettings(settings)
      try {
        await settingsStore.save(settings)
        setSettings(settings)
        return settings
      } catch (error) {
        await accounts.applySettings(previousSettings).catch(() => undefined)
        throw error
      }
    } finally {
      active = null
    }
  })
  install<AppInfo>(IPC_CHANNELS.appInfo, async () => getAppInfo())
  install<void>(IPC_CHANNELS.appUninstall, async (_event, input) => {
    assertIdle()
    const { dataMode } = uninstallSchema.parse(input)
    active = { kind: 'session', controller: null }
    try {
      await uninstallApp(dataMode)
    } finally {
      active = null
    }
  })
  install<void>(IPC_CHANNELS.appQuit, () => {
    assertIdle()
    app.quit()
  })

  const channels = Object.values(IPC_CHANNELS).filter(
    (channel) => !channel.startsWith('tieba:event:')
  )
  return () => {
    mainWindow.removeListener('close', preventCloseWhileBusy)
    channels.forEach((channel) => ipcMain.removeHandler(channel))
  }
}

export function createCoreLogger(
  mainWindow: BrowserWindow,
  taskLogStore: TaskLogStore
): { log(entry: TaskLogEntry): Promise<void> } {
  return {
    async log(entry): Promise<void> {
      const safeEntry = sanitizeForLog(entry) as TaskLogEntry
      await taskLogStore.append(safeEntry)
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_CHANNELS.logEvent, safeEntry)
    }
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent, mainWindow: BrowserWindow): void {
  if (event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new CoreError('INVALID_INPUT', '拒绝来自未知页面的请求')
  }
  const source = event.senderFrame.url
  try {
    const url = new URL(source)
    const developmentUrl = process.env['ELECTRON_RENDERER_URL']
    if (developmentUrl) {
      if (url.origin !== new URL(developmentUrl).origin) throw new Error('origin mismatch')
    } else if (url.protocol !== 'file:') {
      throw new Error('protocol mismatch')
    }
  } catch {
    throw new CoreError('INVALID_INPUT', '拒绝来自未知页面的请求')
  }
}

function serializeSafeError(error: unknown): SerializedCoreError {
  if (error instanceof z.ZodError) {
    return new CoreError('INVALID_INPUT', error.issues[0]?.message || '输入参数不正确').serialize()
  }
  return toCoreError(error).serialize()
}

function containsInvalidCookieValueCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return character === ';' || code < 0x20 || code === 0x7f
  })
}

function portraitFromAvatarUrl(value: string | null): string | null {
  if (!value) return null
  try {
    const fileName = new URL(value).pathname.split('/').pop()
    if (!fileName) return null
    return decodeURIComponent(fileName.replace(/\.jpg$/iu, '')) || null
  } catch {
    return null
  }
}

function makeShellLog(level: TaskLogEntry['level'], event: string, message: string): TaskLogEntry {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    level,
    event,
    message
  }
}
