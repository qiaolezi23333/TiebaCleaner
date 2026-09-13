import { randomUUID } from 'node:crypto'
import type {
  CleanupItem,
  CleanupProgress,
  CleanupTask,
  PreviewResult,
  QueryFilter,
  TaskItemResult,
  TaskLogEntry,
  TaskStatus,
  TaskSummary
} from '../../shared/types'
import { adapters, deleteItem, fetchPage, type InternalCleanupItem } from './adapters'
import { completedItemMessage, failedItemMessage } from './task-target'
import { parseFilterRange } from './date'
import { CoreError, toCoreError } from './errors'
import { fetchHomeFeedPage, homeFeedPageLimit, type HomeFeedMetadata } from './home-feed'
import { fetchFollowerPage } from './follower-feed'
import { noopLogger, redactLogText, type CoreLogger } from './logger'
import type { Transport } from './transport'
import { fetchUserPostPage } from './userpost-feed'

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_DELETE_INTERVAL_MS = 1_200
const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1_000
const TIEBA_ORIGIN = 'https://tieba.baidu.com'

interface StoredPreview {
  result: PreviewResult
  items: Map<string, InternalCleanupItem>
  expiresAtMs: number
  accountKey: string | null
}

export interface QueryOptions {
  signal?: AbortSignal
  requestTimeoutMs?: number
  pageIntervalMs?: number
  /** Stable account identifier (prefer UID) used to prevent cross-account execution. */
  accountKey?: string | null
  /** Used only inside the main process for the signed, read-only official client feed. */
  accountUid?: string | null
  accountBduss?: string | null
  /** Verified public profile fields used only for read-only metadata enrichment. */
  accountUsername?: string | null
  accountPortrait?: string | null
  accountDisplayName?: string | null
  accountAvatarUrl?: string | null
}

export interface ExecuteOptions {
  intervalMs?: number
  requestTimeoutMs?: number
  account?: string | null
  /** Must match the account that created the preview. */
  accountKey?: string | null
  /** Used only in the main process for signed destructive client requests. */
  accountBduss?: string | null
  signal?: AbortSignal
  onProgress?: (progress: CleanupProgress) => void | Promise<void>
}

export interface CoreEngineOptions {
  transport: Transport
  logger?: CoreLogger
  now?: () => Date
  sleep?: (milliseconds: number) => Promise<void>
  previewTtlMs?: number
}

function safeItem(item: InternalCleanupItem): CleanupItem {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    ...(item.displayName ? { displayName: item.displayName } : {}),
    ...(item.avatarUrl ? { avatarUrl: item.avatarUrl } : {}),
    ...(item.forumName ? { forumName: item.forumName } : {}),
    timestamp: item.timestamp,
    timeLabel: item.timeLabel,
    timeKnown: item.timeKnown,
    sourceUrl: item.sourceUrl,
    status: item.status
  }
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CoreError('INVALID_INPUT', `${name}必须是 ${minimum} 到 ${maximum} 之间的整数`)
  }
  return value
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 60_000) {
    throw new CoreError('INVALID_INPUT', `${name}必须是 0 到 60000 之间的数值`)
  }
  return Math.floor(value)
}

function normalize(value: string | undefined): string {
  return value?.trim().toLocaleLowerCase('zh-CN') ?? ''
}

function usableAccountUsername(value: string | null | undefined): string | undefined {
  const username = value?.trim()
  if (!username || /^(?:百度)?贴吧用户$|^未知用户$/u.test(username)) return undefined
  return username
}

function matchesFilter(
  item: InternalCleanupItem,
  filter: QueryFilter,
  startMs: number | null,
  endMs: number | null
): boolean {
  if (item.timeKnown && item.timestamp) {
    const time = new Date(item.timestamp).getTime()
    if (startMs !== null && time < startMs) return false
    if (endMs !== null && time > endMs) return false
  }

  const keyword = normalize(filter.keyword)
  if (keyword) {
    const target = normalize(
      [item.title, item.summary, item.displayName, item.forumName].filter(Boolean).join(' ')
    )
    if (!target.includes(keyword)) return false
  }

  const forum = normalize(filter.forumName).replace(/吧$/, '')
  if (forum && normalize(item.forumName).replace(/吧$/, '') !== forum) return false
  return true
}

function canStopBeforeStart(items: InternalCleanupItem[], startMs: number | null): boolean {
  if (startMs === null || items.length === 0) return false
  return items.every(
    (item) => item.timeKnown && item.timestamp && new Date(item.timestamp).getTime() < startMs
  )
}

function cloneTask(task: CleanupTask): CleanupTask {
  return { ...task }
}

export class CoreEngine {
  private readonly transport: Transport
  private readonly logger: CoreLogger
  private readonly now: () => Date
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly previewTtlMs: number
  private readonly previews = new Map<string, StoredPreview>()
  private activeTask: CleanupTask | null = null
  private cancelRequested = false

  constructor(options: CoreEngineOptions) {
    this.transport = options.transport
    this.logger = options.logger ?? noopLogger
    this.now = options.now ?? (() => new Date())
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.previewTtlMs = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS
  }

  getActiveTask(): CleanupTask | null {
    return this.activeTask ? cloneTask(this.activeTask) : null
  }

  /** Invalidates destructive capabilities after login, logout, or account replacement. */
  invalidatePreviews(): void {
    this.previews.clear()
  }

  cancel(): boolean {
    if (!this.activeTask || !['running', 'cancelling'].includes(this.activeTask.status))
      return false
    this.cancelRequested = true
    this.activeTask.status = 'cancelling'
    void this.writeLog(
      'warning',
      'task.cancelling',
      '正在停止，将在当前项目处理完成后结束',
      this.activeTask
    )
    return true
  }

  async query(filter: QueryFilter, options: QueryOptions = {}): Promise<PreviewResult> {
    const adapter = adapters[filter.kind]
    if (!adapter) throw new CoreError('INVALID_INPUT', '未知的清理类型')
    const maxPages = boundedInteger(filter.maxPages, '扫描页数', 1, 100)
    const timeoutMs = boundedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      '请求超时',
      1_000,
      120_000
    )
    const pageIntervalMs = nonNegativeInteger(options.pageIntervalMs ?? 0, '扫描间隔')
    const range = parseFilterRange(filter.startDate, filter.endDate)
    const startedAt = this.now()
    const queryId = randomUUID()
    await this.writeLog('info', 'scan.started', `开始查询${labelFor(filter.kind)}`)

    const collected = new Map<string, InternalCleanupItem>()
    let scannedPages = 0
    let stopReason: PreviewResult['stopReason'] = 'maxPages'

    try {
      for (let page = 1; page <= maxPages; page += 1) {
        if (options.signal?.aborted) {
          stopReason = 'cancelled'
          break
        }
        const parsed = await fetchPage(this.transport, adapter, page, timeoutMs, this.now())
        scannedPages = page
        const previousItemCount = collected.size
        for (const item of parsed.items) collected.set(item.id, item)
        const addedItemCount = collected.size - previousItemCount

        if (parsed.items.length === 0) {
          stopReason = 'emptyPage'
          break
        }
        // Some legacy Tieba pages silently return the last/first page when pn is
        // out of range. Stop once a non-empty page contributes no new stable IDs
        // instead of repeating it all the way to the configured 100-page cap.
        if (page > 1 && addedItemCount === 0) {
          stopReason = 'completed'
          break
        }
        if (filter.kind === 'reply' || filter.kind === 'post') {
          if (canStopBeforeStart(parsed.items, range.startMs)) {
            stopReason = 'beforeStartDate'
            break
          }
        }
        if (parsed.hasNextPage === false) {
          stopReason = 'completed'
          break
        }
        if (page < maxPages && pageIntervalMs > 0) await this.sleep(pageIntervalMs)
      }
    } catch (error) {
      const coreError = toCoreError(error)
      await this.writeLog(
        'error',
        'scan.failed',
        coreError.message,
        undefined,
        undefined,
        coreError.code
      )
      throw coreError
    }

    let privateSourceHidden = false
    let clientReplySourceResponded = false
    if (filter.kind === 'reply' || filter.kind === 'post') {
      const fallbackIdentity = {
        displayName: options.accountDisplayName?.trim() || undefined,
        avatarUrl: options.accountAvatarUrl?.trim() || undefined
      }
      applyFallbackIdentity(collected.values(), fallbackIdentity)

      const accountUid = options.accountUid?.trim()
      const accountBduss = options.accountBduss?.trim()
      if (filter.kind === 'reply' && accountUid && accountBduss && !options.signal?.aborted) {
        try {
          const sourceWasEmpty = collected.size === 0
          const clientItems: HomeFeedMetadata[] = []
          const clientItemIds = new Set<string>()
          let clientScannedPages = 0
          let clientHasMore = false
          let clientStoppedBeforeStart = false
          for (let page = 1; page <= maxPages; page += 1) {
            if (options.signal?.aborted) break
            const feed = await fetchUserPostPage(
              this.transport,
              { uid: accountUid, bduss: accountBduss },
              page,
              timeoutMs,
              this.now()
            )
            clientScannedPages = page
            clientHasMore = feed.hasMore
            privateSourceHidden ||= feed.hidden
            const previousCount = clientItemIds.size
            for (const item of feed.items) {
              const id = `${item.kind}:${item.tid}:${item.pid ?? ''}`
              if (clientItemIds.has(id)) continue
              clientItemIds.add(id)
              clientItems.push(item)
            }
            const pageItems = feed.items.flatMap((item) => {
              const converted = homeFeedReplyItem(item)
              return converted ? [converted] : []
            })
            if (canStopBeforeStart(pageItems, range.startMs)) {
              clientStoppedBeforeStart = true
              break
            }
            if (!feed.hasMore || feed.items.length === 0) break
            if (page > 1 && clientItemIds.size === previousCount) break
            if (page < maxPages && pageIntervalMs > 0) await this.sleep(pageIntervalMs)
          }
          clientReplySourceResponded = true

          const enriched = mergeHomeFeedMetadata(collected, clientItems)
          const added = addHomeFeedReplies(collected, clientItems)
          applyFallbackIdentity(collected.values(), fallbackIdentity)
          if (sourceWasEmpty && clientScannedPages > 0) {
            scannedPages = Math.max(scannedPages, clientScannedPages)
            stopReason = clientStoppedBeforeStart
              ? 'beforeStartDate'
              : clientHasMore && clientScannedPages >= maxPages
                ? 'maxPages'
                : collected.size > 0
                  ? 'completed'
                  : privateSourceHidden
                    ? 'sourceHidden'
                    : 'emptyPage'
          }
          await this.writeLog(
            added > 0 || enriched > 0 ? 'success' : 'warning',
            'scan.privateMetadata',
            added > 0
              ? `已从贴吧客户端接口找到 ${added} 项回复`
              : privateSourceHidden
                ? '贴吧客户端接口未授权显示回复，将继续尝试其他官方来源'
                : '贴吧客户端接口没有返回可匹配的回复'
          )
        } catch {
          await this.writeLog(
            'warning',
            'scan.privateMetadata',
            '贴吧客户端回复接口暂时不可用，将继续尝试其他官方来源'
          )
        }
      }

      const username = usableAccountUsername(options.accountUsername)
      const portrait = options.accountPortrait?.trim() || undefined
      if ((username || portrait) && !options.signal?.aborted) {
        try {
          const legacyWasEmpty = collected.size === 0
          const feedItems: HomeFeedMetadata[] = []
          const feedItemIds = new Set<string>()
          const feedPages = legacyWasEmpty ? maxPages : homeFeedPageLimit(collected.size, maxPages)
          let feedScannedPages = 0
          let feedHasMore = false
          let feedStoppedBeforeStart = false
          for (let page = 1; page <= feedPages; page += 1) {
            if (options.signal?.aborted) break
            const feed = await fetchHomeFeedPage(
              this.transport,
              { username, portrait },
              filter.kind,
              page,
              timeoutMs,
              this.now()
            )
            feedScannedPages = page
            feedHasMore = feed.hasMore
            const previousFeedCount = feedItemIds.size
            for (const item of feed.items) {
              const id = `${item.kind}:${item.tid}:${item.pid ?? ''}`
              if (!feedItemIds.has(id)) {
                feedItemIds.add(id)
                feedItems.push(item)
              }
            }
            if (legacyWasEmpty && filter.kind === 'reply') {
              const pageItems = feed.items.flatMap((item) => {
                const converted = homeFeedReplyItem(item)
                return converted ? [converted] : []
              })
              if (canStopBeforeStart(pageItems, range.startMs)) {
                feedStoppedBeforeStart = true
                break
              }
            }
            if (!feed.hasMore) break
            if (page > 1 && feedItemIds.size === previousFeedCount) break
            if (page < feedPages && pageIntervalMs > 0) await this.sleep(pageIntervalMs)
          }
          const enriched = mergeHomeFeedMetadata(collected, feedItems)
          const added = filter.kind === 'reply' ? addHomeFeedReplies(collected, feedItems) : 0
          applyFallbackIdentity(collected.values(), fallbackIdentity)
          if (legacyWasEmpty && feedScannedPages > 0) {
            scannedPages = Math.max(scannedPages, feedScannedPages)
            stopReason = feedStoppedBeforeStart
              ? 'beforeStartDate'
              : feedHasMore && feedScannedPages >= feedPages
                ? 'maxPages'
                : collected.size > 0
                  ? 'completed'
                  : 'emptyPage'
          }
          const homeMetadataMatched = enriched > 0 || added > 0
          await this.writeLog(
            homeMetadataMatched ? 'success' : clientReplySourceResponded ? 'info' : 'warning',
            'scan.metadata',
            added > 0
              ? `旧回复页为空或不完整，已从个人主页找到 ${added} 项回复`
              : enriched > 0
                ? `已从个人主页补全 ${enriched} 项内容信息`
                : clientReplySourceResponded
                  ? '已完成个人主页补充检查'
                  : '个人主页没有返回可匹配的内容信息，已保留旧页面结果'
          )
        } catch {
          // The metadata source is read-only and best-effort. Deletion still uses
          // the stable IDs and request parameters parsed from the legacy page.
          await this.writeLog(
            clientReplySourceResponded ? 'info' : 'warning',
            'scan.metadata',
            clientReplySourceResponded
              ? '个人主页来源不可用，已完成贴吧客户端接口查询'
              : '个人主页内容补全暂时不可用，已保留旧页面结果'
          )
        }
      }
    }

    if (filter.kind === 'reply' && collected.size === 0 && privateSourceHidden) {
      stopReason = 'sourceHidden'
    }

    const accountUid = options.accountUid?.trim()
    const accountBduss = options.accountBduss?.trim()
    if (filter.kind === 'follower' && accountUid && accountBduss && !options.signal?.aborted) {
      try {
        const sourceWasEmpty = collected.size === 0
        let clientScannedPages = 0
        let clientHasMore = false
        for (let page = 1; page <= maxPages; page += 1) {
          if (options.signal?.aborted) break
          const feed = await fetchFollowerPage(
            this.transport,
            { uid: accountUid, bduss: accountBduss },
            page,
            timeoutMs
          )
          clientScannedPages = page
          clientHasMore = feed.hasMore
          const previousCount = collected.size
          for (const item of feed.items) collected.set(item.id, item)
          if (!feed.hasMore || feed.items.length === 0) break
          if (page > 1 && collected.size === previousCount) break
          if (page < maxPages && pageIntervalMs > 0) await this.sleep(pageIntervalMs)
        }
        if (clientScannedPages > 0) {
          scannedPages = Math.max(scannedPages, clientScannedPages)
          if (sourceWasEmpty) {
            stopReason =
              clientHasMore && clientScannedPages >= maxPages
                ? 'maxPages'
                : collected.size > 0
                  ? 'completed'
                  : 'emptyPage'
          }
        }
        await this.writeLog(
          collected.size > 0 ? 'success' : 'warning',
          'scan.followerClient',
          collected.size > 0
            ? `已从贴吧客户端接口找到 ${collected.size} 位可直接移除的粉丝`
            : '贴吧客户端接口没有返回可移除的粉丝'
        )
      } catch {
        await this.writeLog(
          'warning',
          'scan.followerClient',
          collected.size > 0
            ? '贴吧客户端粉丝接口暂时不可用，已保留网页来源结果'
            : '贴吧客户端粉丝接口暂时不可用，未生成无法安全直接移除的候选项'
        )
      }
    }

    const filtered = [...collected.values()].filter((item) =>
      matchesFilter(item, filter, range.startMs, range.endMs)
    )
    const createdAt = this.now()
    const expiresAtMs = createdAt.getTime() + this.previewTtlMs
    const result: PreviewResult = {
      previewId: queryId,
      kind: filter.kind,
      scannedPages,
      items: filtered.map(safeItem),
      stopReason,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString()
    }
    this.removeExpiredPreviews(createdAt.getTime())
    this.previews.set(queryId, {
      result,
      items: new Map(filtered.map((item) => [item.id, item])),
      expiresAtMs,
      accountKey: options.accountKey?.trim() || null
    })
    await this.writeLog(
      'success',
      'scan.completed',
      `查询完成：扫描 ${scannedPages} 页，找到 ${filtered.length} 项（耗时 ${createdAt.getTime() - startedAt.getTime()}ms）`
    )
    return structuredClone(result)
  }

  async execute(
    previewId: string,
    itemIds: string[],
    options: ExecuteOptions = {}
  ): Promise<TaskSummary> {
    if (this.activeTask && ['running', 'cancelling'].includes(this.activeTask.status))
      throw new CoreError('BUSY')
    const preview = this.getPreview(previewId)
    const currentAccountKey = options.accountKey?.trim() || null
    if (preview.accountKey !== currentAccountKey) {
      this.previews.delete(previewId)
      throw new CoreError('PREVIEW_EXPIRED', '预览所属账号已改变，请重新查询')
    }
    const uniqueIds = [...new Set(itemIds)]
    if (uniqueIds.length === 0) throw new CoreError('INVALID_INPUT', '请至少选择一个项目')
    const selected = uniqueIds.map((id) => {
      const item = preview.items.get(id)
      if (!item) throw new CoreError('ITEM_NOT_FOUND')
      return item
    })
    const intervalMs = nonNegativeInteger(
      options.intervalMs ?? DEFAULT_DELETE_INTERVAL_MS,
      '删除间隔'
    )
    const timeoutMs = boundedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      '请求超时',
      1_000,
      120_000
    )
    const startedAt = this.now().toISOString()
    const task: CleanupTask = {
      id: randomUUID(),
      previewId,
      kind: preview.result.kind,
      account: options.account ?? null,
      status: 'running',
      startedAt,
      finishedAt: null,
      total: selected.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      remaining: selected.length
    }
    this.activeTask = task
    this.cancelRequested = false
    const results: TaskItemResult[] = []
    const requestCancel = (): void => {
      this.cancel()
    }
    options.signal?.addEventListener('abort', requestCancel, { once: true })
    if (options.signal?.aborted) requestCancel()
    await this.writeLog('info', 'task.started', `开始处理 ${selected.length} 项`, task)

    try {
      for (let index = 0; index < selected.length; index += 1) {
        if (this.cancelRequested) {
          task.status = 'cancelled'
          break
        }
        const item = selected[index]
        await this.emitProgress(options, task, item.id)
        try {
          const outcome = await deleteItem(this.transport, item, timeoutMs, {
            bduss: options.accountBduss
          })
          if (outcome.limited) {
            const reason = outcome.message ?? '已触发贴吧限制'
            item.status = 'failed'
            task.failed += 1
            task.completed += 1
            task.remaining = task.total - task.completed
            results.push({
              itemId: item.id,
              status: 'failed',
              errorCode: 'RATE_LIMIT',
              message: failedItemMessage(item, reason)
            })
            task.status = 'limited'
            await this.writeLog(
              'warning',
              'task.limited',
              failedItemMessage(item, reason),
              task,
              item.id,
              'RATE_LIMIT',
              item.sourceUrl
            )
            await this.emitProgress(options, task, item.id)
            break
          }
          if (outcome.success) {
            const successMessage = completedItemMessage(item)
            item.status = 'succeeded'
            task.succeeded += 1
            results.push({ itemId: item.id, status: 'succeeded', message: successMessage })
            await this.writeLog(
              'success',
              'item.succeeded',
              successMessage,
              task,
              item.id,
              undefined,
              item.sourceUrl
            )
          } else {
            const reason = outcome.message ?? '贴吧未接受此次操作'
            item.status = 'failed'
            task.failed += 1
            results.push({
              itemId: item.id,
              status: 'failed',
              errorCode: 'DELETE_FAILED',
              message: failedItemMessage(item, reason)
            })
            await this.writeLog(
              'error',
              'item.failed',
              failedItemMessage(item, reason),
              task,
              item.id,
              'DELETE_FAILED',
              item.sourceUrl
            )
          }
        } catch (error) {
          const coreError = toCoreError(error)
          const failureMessage = failedItemMessage(item, coreError.message)
          item.status = 'failed'
          task.failed += 1
          results.push({
            itemId: item.id,
            status: 'failed',
            errorCode: coreError.code,
            message: failureMessage
          })
          await this.writeLog(
            'error',
            'item.failed',
            failureMessage,
            task,
            item.id,
            coreError.code,
            item.sourceUrl
          )
          if (coreError.code === 'AUTH_EXPIRED') task.status = 'failed'
        }

        task.completed += 1
        task.remaining = task.total - task.completed
        await this.emitProgress(options, task, item.id)
        if (task.status === 'failed' || this.cancelRequested) {
          if (this.cancelRequested) task.status = 'cancelled'
          break
        }
        if (index < selected.length - 1 && intervalMs > 0) await this.sleep(intervalMs)
      }

      if (task.status === 'running') task.status = 'completed'
      if (task.status === 'cancelling') task.status = 'cancelled'
    } catch (error) {
      task.status = 'failed'
      const coreError = toCoreError(error)
      await this.writeLog(
        'error',
        'task.failed',
        coreError.message,
        task,
        undefined,
        coreError.code
      )
    } finally {
      options.signal?.removeEventListener('abort', requestCancel)
      task.finishedAt = this.now().toISOString()
      task.remaining = task.total - task.completed
      const level =
        task.status === 'completed' ? 'success' : task.status === 'failed' ? 'error' : 'warning'
      try {
        await this.writeLog(level, 'task.finished', taskFinishMessage(task), task)
        await this.emitProgress(options, task, null)
      } finally {
        // No observer or persistence failure may leave the destructive runner wedged.
        this.activeTask = null
        this.cancelRequested = false
      }
    }

    return { ...task, results }
  }

  private getPreview(previewId: string): StoredPreview {
    const preview = this.previews.get(previewId)
    if (!preview || preview.expiresAtMs <= this.now().getTime()) {
      if (preview) this.previews.delete(previewId)
      throw new CoreError('PREVIEW_EXPIRED')
    }
    return preview
  }

  private removeExpiredPreviews(nowMs: number): void {
    for (const [id, preview] of this.previews) {
      if (preview.expiresAtMs <= nowMs) this.previews.delete(id)
    }
  }

  private async emitProgress(
    options: ExecuteOptions,
    task: CleanupTask,
    currentItemId: string | null
  ): Promise<void> {
    try {
      await options.onProgress?.({ ...task, currentItemId })
    } catch {
      // UI progress is best-effort and must never alter a destructive operation's result.
    }
  }

  private async writeLog(
    level: TaskLogEntry['level'],
    event: string,
    message: string,
    task?: CleanupTask,
    itemId?: string,
    errorCode?: TaskLogEntry['errorCode'],
    targetUrl?: string
  ): Promise<void> {
    try {
      await this.logger.log({
        id: randomUUID(),
        timestamp: this.now().toISOString(),
        level,
        event,
        message: redactLogText(message),
        ...(task ? { taskId: task.id, kind: task.kind, account: task.account } : {}),
        ...(itemId ? { itemId } : {}),
        ...(targetUrl ? { targetUrl } : {}),
        ...(errorCode ? { errorCode } : {})
      })
    } catch {
      // Logging is best-effort: disk/observer failures cannot change task semantics.
    }
  }
}

function applyFallbackIdentity(
  items: Iterable<InternalCleanupItem>,
  identity: { displayName?: string; avatarUrl?: string }
): void {
  for (const item of items) {
    if (identity.displayName && !item.displayName) item.displayName = identity.displayName
    if (identity.avatarUrl && !item.avatarUrl) item.avatarUrl = identity.avatarUrl
  }
}

function homeFeedReplyItem(metadata: HomeFeedMetadata): InternalCleanupItem | undefined {
  if (metadata.kind !== 'reply' || !metadata.pid) return undefined
  const id = `reply:${metadata.tid}:${metadata.pid}`
  const title = metadata.title || `回复 ${metadata.tid}`
  return {
    id,
    kind: 'reply',
    title,
    summary: metadata.summary || title,
    ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
    ...(metadata.avatarUrl ? { avatarUrl: metadata.avatarUrl } : {}),
    ...(metadata.forumName ? { forumName: metadata.forumName } : {}),
    timestamp: metadata.timestamp,
    timeLabel: metadata.timeLabel,
    timeKnown: metadata.timeKnown,
    sourceUrl: metadata.sourceUrl,
    status: 'pending',
    deleteRequest: {
      url: `${TIEBA_ORIGIN}/f/commit/post/delete`,
      referer: `${TIEBA_ORIGIN}/i/i/my_reply`,
      params: { tid: metadata.tid, pid: metadata.pid },
      successField: 'err_code',
      needsFreshTbs: true
    }
  }
}

function addHomeFeedReplies(
  items: Map<string, InternalCleanupItem>,
  metadata: HomeFeedMetadata[]
): number {
  let added = 0
  for (const entry of metadata) {
    const item = homeFeedReplyItem(entry)
    if (!item || items.has(item.id)) continue
    items.set(item.id, item)
    added += 1
  }
  return added
}

function mergeHomeFeedMetadata(
  items: Map<string, InternalCleanupItem>,
  metadata: HomeFeedMetadata[]
): number {
  const exact = new Map<string, HomeFeedMetadata>()
  const byThread = new Map<string, HomeFeedMetadata[]>()
  for (const entry of metadata) {
    if (entry.pid) exact.set(`${entry.kind}:${entry.tid}:${entry.pid}`, entry)
    const key = `${entry.kind}:${entry.tid}`
    byThread.set(key, [...(byThread.get(key) ?? []), entry])
  }

  const itemsByThread = new Map<string, InternalCleanupItem[]>()
  for (const item of items.values()) {
    const identity = contentItemIdentity(item.id)
    if (!identity) continue
    const key = `${item.kind}:${identity.tid}`
    itemsByThread.set(key, [...(itemsByThread.get(key) ?? []), item])
  }

  let merged = 0
  for (const item of items.values()) {
    const identity = contentItemIdentity(item.id)
    if (!identity) continue
    const threadKey = `${item.kind}:${identity.tid}`
    const candidates = byThread.get(threadKey) ?? []
    const entry =
      exact.get(item.id) ??
      (candidates.length === 1 && itemsByThread.get(threadKey)?.length === 1
        ? candidates[0]
        : undefined)
    if (!entry) continue

    if (entry.title) item.title = entry.title
    if (entry.summary) item.summary = entry.summary
    if (entry.displayName) item.displayName = entry.displayName
    if (entry.avatarUrl) item.avatarUrl = entry.avatarUrl
    if (entry.forumName) item.forumName = entry.forumName
    if (entry.timeKnown) {
      item.timestamp = entry.timestamp
      item.timeLabel = entry.timeLabel
      item.timeKnown = true
    }
    // Keep the old source URL and, crucially, the old deleteRequest untouched.
    merged += 1
  }
  return merged
}

function contentItemIdentity(id: string): { tid: string; pid: string } | undefined {
  const match = id.match(/^(?:reply|post):(\d+):(\d+)$/u)
  return match ? { tid: match[1], pid: match[2] } : undefined
}

function labelFor(kind: QueryFilter['kind']): string {
  return {
    reply: '回复',
    post: '主题帖',
    followingUser: '关注用户',
    followingForum: '关注贴吧',
    follower: '粉丝'
  }[kind]
}

function taskFinishMessage(task: CleanupTask): string {
  const prefix =
    {
      completed: '任务完成',
      limited: '任务因贴吧限制停止',
      cancelled: '任务已停止',
      failed: '任务失败'
    }[task.status as Extract<TaskStatus, 'completed' | 'limited' | 'cancelled' | 'failed'>] ??
    '任务结束'
  return `${prefix}：成功 ${task.succeeded}，失败 ${task.failed}，未处理 ${task.remaining}`
}
