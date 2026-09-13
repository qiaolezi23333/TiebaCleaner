import type {
  AccountState,
  AppInfo,
  AppSettings,
  CleanupProgress,
  PreviewResult,
  QueryFilter,
  CookieImportInput,
  TaskLogEntry,
  TaskSummary,
  UninstallDataMode
} from './types'
import { DEFAULT_SETTINGS, EMPTY_ACCOUNT_STATE } from './types'

const unavailable = '桌面服务尚未就绪，请重新启动应用'

function getApi(): NonNullable<Window['tieba']> {
  if (!window.tieba) throw new Error(unavailable)
  return window.tieba
}

export const tiebaClient = {
  account: {
    async list(): Promise<AccountState> {
      if (!window.tieba) return EMPTY_ACCOUNT_STATE
      return getApi().account.list()
    },
    openLogin(accountId?: string): Promise<AccountState> {
      return getApi().account.openLogin(accountId)
    },
    importCookie(input: CookieImportInput): Promise<AccountState> {
      return getApi().account.importCookie(input)
    },
    verify(accountId: string): Promise<AccountState> {
      return getApi().account.verify(accountId)
    },
    logout(accountId: string): Promise<AccountState> {
      return getApi().account.logout(accountId)
    },
    select(accountId: string): Promise<AccountState> {
      return getApi().account.select(accountId)
    }
  },
  cleanup: {
    query(accountId: string, filter: QueryFilter): Promise<PreviewResult> {
      return getApi().cleanup.query({ accountId, filter })
    },
    start(accountId: string, previewId: string, itemIds: string[]): Promise<TaskSummary> {
      return getApi().cleanup.start({ accountId, previewId, itemIds })
    },
    async stop(): Promise<void> {
      await getApi().cleanup.stop()
    }
  },
  tasks: {
    async list(): Promise<TaskLogEntry[]> {
      if (!window.tieba) return []
      return getApi().tasks.list()
    },
    clear(): Promise<void> {
      return getApi().tasks.clear()
    }
  },
  settings: {
    async get(): Promise<AppSettings> {
      if (!window.tieba) return DEFAULT_SETTINGS
      return getApi().settings.get()
    },
    save(settings: AppSettings): Promise<AppSettings> {
      return getApi().settings.save(settings)
    }
  },
  app: {
    info(): Promise<AppInfo> {
      return getApi().app.info()
    },
    uninstall(dataMode: UninstallDataMode): Promise<void> {
      return getApi().app.uninstall(dataMode)
    }
  },
  events: {
    onTaskEvent(listener: (event: CleanupProgress) => void): () => void {
      return window.tieba?.events.onTaskEvent(listener) ?? (() => undefined)
    },
    onLog(listener: (message: TaskLogEntry) => void): () => void {
      return window.tieba?.events.onLog(listener) ?? (() => undefined)
    }
  },
  async quit(): Promise<void> {
    await getApi().app.quit()
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return '操作失败，请稍后重试'
}
