export const CLEANUP_KINDS = [
  'reply',
  'post',
  'followingUser',
  'followingForum',
  'follower'
] as const

export type CleanupKind = (typeof CLEANUP_KINDS)[number]

export type ContentKind = Extract<CleanupKind, 'reply' | 'post'>
export type RelationKind = Exclude<CleanupKind, ContentKind>

export interface AccountSummary {
  /** Opaque local identifier. It never contains a credential or Tieba token. */
  accountId: string
  loggedIn: boolean
  uid: string | null
  username: string | null
  displayName: string | null
  avatarUrl: string | null
  /** Public Tieba portrait identifier used by the official personal-feed endpoint. */
  portrait?: string | null
  verifiedAt: string | null
}

export interface AccountState {
  accounts: AccountSummary[]
  selectedAccountId: string | null
}

export interface CookieFieldInput {
  name: string
  value: string
}

export interface CookieImportInput {
  /** Existing account to replace. Omit to add another account. */
  accountId?: string
  /** A complete request Cookie header. */
  rawCookie?: string
  /** Individually entered Cookie name/value pairs. */
  fields?: CookieFieldInput[]
}

export type ProxyMode = 'system' | 'direct' | 'manual'

export interface AppSettings {
  proxyMode: ProxyMode
  manualProxyUrl: string
  requestTimeoutMs: number
  scanIntervalMs: number
  deleteIntervalMs: number
  maxPages: number
}

export type UninstallDataMode = 'keep' | 'logout' | 'clear'

export interface AppInfo {
  version: string
  canUninstall: boolean
}

export interface QueryFilter {
  kind: CleanupKind
  /** Inclusive local calendar date (YYYY-MM-DD) or an ISO timestamp. */
  startDate?: string
  /** Inclusive local calendar date (YYYY-MM-DD) or an ISO timestamp. */
  endDate?: string
  keyword?: string
  forumName?: string
  maxPages: number
}

export interface AccountQueryInput {
  accountId: string
  filter: QueryFilter
}

export interface AccountCleanupInput {
  accountId: string
  previewId: string
  itemIds: string[]
}

export type CleanupItemStatus = 'pending' | 'succeeded' | 'failed' | 'skipped'

/** Safe to expose to the renderer. Credentials and destructive request parameters are excluded. */
export interface CleanupItem {
  id: string
  kind: CleanupKind
  title: string
  summary: string
  displayName?: string
  avatarUrl?: string
  forumName?: string
  timestamp: string | null
  timeLabel: string | null
  timeKnown: boolean
  sourceUrl: string
  status: CleanupItemStatus
}

export type PreviewStopReason =
  'completed' | 'emptyPage' | 'sourceHidden' | 'beforeStartDate' | 'maxPages' | 'cancelled'

export interface PreviewResult {
  previewId: string
  kind: CleanupKind
  scannedPages: number
  items: CleanupItem[]
  stopReason: PreviewStopReason
  createdAt: string
  expiresAt: string
}

export type TaskStatus =
  'scanning' | 'ready' | 'running' | 'cancelling' | 'completed' | 'limited' | 'cancelled' | 'failed'

export type LogLevel = 'info' | 'success' | 'warning' | 'error'

export interface TaskLogEntry {
  id: string
  timestamp: string
  level: LogLevel
  event: string
  message: string
  taskId?: string
  itemId?: string
  account?: string | null
  targetUrl?: string
  kind?: CleanupKind
  errorCode?: CoreErrorCode
}

export interface TaskItemResult {
  itemId: string
  status: Extract<CleanupItemStatus, 'succeeded' | 'failed' | 'skipped'>
  errorCode?: CoreErrorCode
  message?: string
}

export interface CleanupTask {
  id: string
  previewId: string
  kind: CleanupKind
  account: string | null
  status: TaskStatus
  startedAt: string
  finishedAt: string | null
  total: number
  completed: number
  succeeded: number
  failed: number
  remaining: number
}

export interface TaskSummary extends CleanupTask {
  results: TaskItemResult[]
}

export interface CleanupProgress extends CleanupTask {
  currentItemId: string | null
}

export type CoreErrorCode =
  | 'AUTH_EXPIRED'
  | 'NETWORK_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'HTTP_ERROR'
  | 'PARSE_FAILED'
  | 'RATE_LIMIT'
  | 'DELETE_FAILED'
  | 'INVALID_INPUT'
  | 'BUSY'
  | 'PREVIEW_EXPIRED'
  | 'ITEM_NOT_FOUND'
  | 'CANCELLED'

export interface SerializedCoreError {
  name: 'CoreError'
  code: CoreErrorCode
  message: string
  retryable: boolean
  status?: number
}
