import { contextBridge, ipcRenderer } from 'electron'
import type {
  AccountCleanupInput,
  AccountQueryInput,
  AccountState,
  AppInfo,
  AppSettings,
  CleanupProgress,
  CookieImportInput,
  PreviewResult,
  SerializedCoreError,
  TaskLogEntry,
  TaskSummary,
  UninstallDataMode
} from '../shared/types'

const channels = {
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

const allowedInvokeChannels = new Set<string>([
  channels.accountList,
  channels.accountSelect,
  channels.accountOpenLogin,
  channels.accountImportCookie,
  channels.accountVerify,
  channels.accountLogout,
  channels.cleanupQuery,
  channels.cleanupStart,
  channels.cleanupStop,
  channels.tasksList,
  channels.tasksClear,
  channels.settingsGet,
  channels.settingsSave,
  channels.appInfo,
  channels.appUninstall,
  channels.appQuit
])

interface IpcSuccess<T> {
  ok: true
  data: T
}

interface IpcFailure {
  ok: false
  error: SerializedCoreError
}

type IpcResponse<T> = IpcSuccess<T> | IpcFailure

async function invoke<T>(channel: string, input?: unknown): Promise<T> {
  if (!allowedInvokeChannels.has(channel)) throw new Error('IPC channel is not allowed')
  const response = (await ipcRenderer.invoke(channel, input)) as IpcResponse<T>
  if (response.ok) return response.data

  const error = new Error(response.error.message)
  error.name = response.error.name
  Object.assign(error, {
    code: response.error.code,
    retryable: response.error.retryable,
    status: response.error.status
  })
  throw error
}

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  if (channel !== channels.taskEvent && channel !== channels.logEvent) {
    throw new Error('IPC event channel is not allowed')
  }
  const wrapped = (_event: Electron.IpcRendererEvent, value: T): void => listener(value)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

export const tiebaAPI = {
  account: {
    list: (): Promise<AccountState> => invoke(channels.accountList),
    select: (accountId: string): Promise<AccountState> =>
      invoke(channels.accountSelect, { accountId }),
    openLogin: (accountId?: string): Promise<AccountState> =>
      invoke(channels.accountOpenLogin, accountId ? { accountId } : undefined),
    importCookie: (input: CookieImportInput): Promise<AccountState> =>
      invoke(channels.accountImportCookie, input),
    verify: (accountId: string): Promise<AccountState> =>
      invoke(channels.accountVerify, { accountId }),
    logout: (accountId: string): Promise<AccountState> =>
      invoke(channels.accountLogout, { accountId })
  },
  cleanup: {
    query: (input: AccountQueryInput): Promise<PreviewResult> =>
      invoke(channels.cleanupQuery, input),
    start: (input: AccountCleanupInput): Promise<TaskSummary> =>
      invoke(channels.cleanupStart, input),
    stop: (): Promise<{ stopped: boolean }> => invoke(channels.cleanupStop)
  },
  tasks: {
    list: (): Promise<TaskLogEntry[]> => invoke(channels.tasksList),
    clear: (): Promise<void> => invoke(channels.tasksClear)
  },
  settings: {
    get: (): Promise<AppSettings> => invoke(channels.settingsGet),
    save: (settings: AppSettings): Promise<AppSettings> => invoke(channels.settingsSave, settings)
  },
  app: {
    info: (): Promise<AppInfo> => invoke(channels.appInfo),
    uninstall: (dataMode: UninstallDataMode): Promise<void> =>
      invoke(channels.appUninstall, { dataMode }),
    quit: (): Promise<void> => invoke(channels.appQuit)
  },
  events: {
    onTaskEvent: (listener: (event: CleanupProgress) => void): (() => void) =>
      subscribe(channels.taskEvent, listener),
    onLog: (listener: (entry: TaskLogEntry) => void): (() => void) =>
      subscribe(channels.logEvent, listener)
  }
} as const

contextBridge.exposeInMainWorld('tieba', tiebaAPI)

export type TiebaAPI = typeof tiebaAPI
