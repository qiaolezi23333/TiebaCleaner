export type {
  AccountState,
  AccountSummary,
  AppInfo,
  CookieFieldInput,
  CookieImportInput,
  AppSettings,
  CleanupItem,
  CleanupKind,
  CleanupProgress,
  CleanupTask,
  PreviewResult,
  QueryFilter,
  TaskLogEntry,
  TaskStatus,
  TaskSummary,
  UninstallDataMode
} from '../../shared/types'

export interface NavigationIntent {
  page: string
  kind?: import('../../shared/types').CleanupKind
}

export const DEFAULT_SETTINGS: import('../../shared/types').AppSettings = {
  proxyMode: 'system',
  manualProxyUrl: '',
  requestTimeoutMs: 15000,
  scanIntervalMs: 350,
  deleteIntervalMs: 1200,
  maxPages: 20
}

export const EMPTY_ACCOUNT: import('../../shared/types').AccountSummary = {
  accountId: '',
  loggedIn: false,
  uid: null,
  username: null,
  displayName: null,
  avatarUrl: null,
  verifiedAt: null
}

export const EMPTY_ACCOUNT_STATE: import('../../shared/types').AccountState = {
  accounts: [],
  selectedAccountId: null
}
