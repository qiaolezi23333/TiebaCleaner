import { parseTiebaTime, type ParsedTime } from './date'
import { CoreError, assertHttpOk } from './errors'
import type { Transport } from './transport'

const TIEBA_ORIGIN = 'https://tieba.baidu.com'
const FEED_PAGE_SIZE = 20

type JsonRecord = Record<string, unknown>

export interface HomeFeedIdentity {
  username?: string
  portrait?: string
}

export interface HomeFeedMetadata {
  kind: 'reply' | 'post'
  tid: string
  pid?: string
  title?: string
  summary?: string
  displayName?: string
  forumName?: string
  avatarUrl?: string
  sourceUrl: string
  timestamp: string | null
  timeLabel: string | null
  timeKnown: boolean
}

export interface HomeFeedPage {
  items: HomeFeedMetadata[]
  hasMore: boolean
}

export function homeFeedPageLimit(itemCount: number, requestedPages: number): number {
  if (itemCount <= 0) return 0
  return Math.min(requestedPages, Math.max(1, Math.ceil(itemCount / FEED_PAGE_SIZE) + 2))
}

export async function fetchHomeFeedPage(
  transport: Transport,
  identity: HomeFeedIdentity,
  kind: 'reply' | 'post',
  page: number,
  timeoutMs: number,
  now: Date
): Promise<HomeFeedPage> {
  const url = new URL('/c/u/feed/myThread', TIEBA_ORIGIN)
  url.searchParams.set('pn', String(page))
  url.searchParams.set('rn', String(FEED_PAGE_SIZE))
  url.searchParams.set('portrait', identity.portrait ?? '')
  url.searchParams.set('type', kind === 'post' ? '1' : '2')
  url.searchParams.set('un', identity.portrait ? '' : (identity.username ?? ''))
  url.searchParams.set('subapp_type', 'pc')
  url.searchParams.set('_client_type', '20')

  const referer = new URL('/home/main', TIEBA_ORIGIN)
  if (identity.portrait) referer.searchParams.set('id', identity.portrait)
  else referer.searchParams.set('un', identity.username ?? '')
  referer.searchParams.set('fr', 'personpage')

  const response = await transport.request({
    url: url.toString(),
    method: 'GET',
    timeoutMs,
    operation: 'content:metadata',
    headers: {
      Accept: 'application/json,text/plain,*/*',
      Referer: referer.toString(),
      'X-Requested-With': 'XMLHttpRequest'
    }
  })
  assertHttpOk(response.status)
  return parseHomeFeedResponse(response.body, kind, now)
}

export function parseHomeFeedResponse(
  body: string,
  kind: 'reply' | 'post',
  now: Date
): HomeFeedPage {
  let root: unknown
  try {
    root = JSON.parse(body)
  } catch (error) {
    throw new CoreError('PARSE_FAILED', '个人主页内容接口返回了无法识别的数据', { cause: error })
  }

  const rootRecord = asRecord(root)
  if (!rootRecord) throw new CoreError('PARSE_FAILED', '个人主页内容接口缺少结果数据')
  const errorCode = firstNumber(rootRecord, ['error_code', 'errorCode', 'errno', 'no'])
  if (errorCode !== undefined && errorCode !== 0) {
    throw new CoreError('PARSE_FAILED', '个人主页内容接口暂时不可用')
  }

  const payload = findFeedPayload(rootRecord)
  if (!payload) throw new CoreError('PARSE_FAILED', '个人主页内容接口缺少列表数据')
  const list = Array.isArray(payload.list)
    ? payload.list
    : Array.isArray(payload.thread_list)
      ? payload.thread_list
      : []

  return {
    items: list.flatMap((value) => {
      const metadata = parseFeedItem(value, kind, now)
      return metadata ? [metadata] : []
    }),
    hasMore: Boolean(Number(payload.has_more ?? 0))
  }
}

function parseFeedItem(value: unknown, kind: 'reply' | 'post', now: Date): HomeFeedMetadata | null {
  const item = asRecord(value)
  if (!item) return null
  const thread = asRecord(item.thread_info) ?? item
  const post = asRecord(item.post_info) ?? asRecord(thread.post_info)
  const author = asRecord(post?.author) ?? asRecord(thread.author)
  const forum = asRecord(thread.forum_info) ?? asRecord(item.forum_info)

  const tid =
    firstIdentifier(thread, ['id', 'tid', 'thread_id']) ??
    firstIdentifier(item, ['tid', 'thread_id'])
  if (!tid) return null

  const useQuoteId = kind === 'reply' && Number(item.type) === 3
  const pid =
    kind === 'reply'
      ? (firstIdentifier(
          post,
          useQuoteId ? ['quote_id', 'id', 'pid'] : ['id', 'pid', 'post_id', 'quote_id']
        ) ?? firstIdentifier(item, ['pid', 'post_id', 'cid']))
      : (firstIdentifier(thread, ['first_post_id', 'post_id']) ?? tid)

  const threadTitle = firstText(thread, ['title', 'thread_title']) || richText(thread.rich_title)
  const threadContent =
    richText(thread.first_post_content) ||
    richText(thread.content) ||
    firstText(thread, ['abstract'])
  const replyContent =
    richText(post?.content) || firstText(post, ['content_text', 'text', 'abstract'])

  const title = kind === 'reply' ? replyContent : threadTitle || threadContent
  const summary =
    kind === 'reply'
      ? threadTitle
        ? `原帖：${threadTitle}`
        : threadContent
      : threadContent || threadTitle
  const displayName = firstText(author, ['name_show', 'name', 'user_name_show', 'user_name'])
  const forumName = firstText(forum, ['name', 'fname']) || firstText(thread, ['fname'])
  const portrait = firstText(author, ['portrait'])
  const time = parseFeedTime(
    firstPrimitive(post, ['time', 'create_time']) ??
      firstPrimitive(thread, ['create_time', 'time']),
    now
  )
  const sourceUrl = `${TIEBA_ORIGIN}/p/${tid}${pid ? `?pid=${pid}#${pid}` : ''}`

  return {
    kind,
    tid,
    ...(pid ? { pid } : {}),
    ...(title ? { title } : {}),
    ...(summary ? { summary } : {}),
    ...(displayName ? { displayName } : {}),
    ...(forumName ? { forumName: forumName.replace(/吧$/u, '') } : {}),
    ...(portrait ? { avatarUrl: portraitUrl(portrait) } : {}),
    sourceUrl,
    ...time
  }
}

function parseFeedTime(value: string | number | boolean | undefined, now: Date): ParsedTime {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{10,13}$/u.test(value))) {
    const raw = String(value)
    const milliseconds = raw.length === 10 ? Number(raw) * 1_000 : Number(raw)
    const date = new Date(milliseconds)
    if (!Number.isNaN(date.getTime())) {
      return { timestamp: date.toISOString(), timeLabel: raw, timeKnown: true }
    }
  }
  return parseTiebaTime(typeof value === 'string' ? value : undefined, now)
}

function findFeedPayload(root: JsonRecord): JsonRecord | undefined {
  let current: JsonRecord | undefined = root
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (Array.isArray(current.list) || Array.isArray(current.thread_list)) return current
    current = asRecord(current.data)
  }
  return undefined
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

function firstIdentifier(
  record: JsonRecord | undefined,
  keys: readonly string[]
): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if ((typeof value === 'string' || typeof value === 'number') && /^\d+$/u.test(String(value))) {
      return String(value)
    }
  }
  return undefined
}

function firstPrimitive(
  record: JsonRecord | undefined,
  keys: readonly string[]
): string | number | boolean | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value
    }
  }
  return undefined
}

function firstText(record: JsonRecord | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = richText(record[key])
    if (value) return value
  }
  return undefined
}

function richText(value: unknown, depth = 0): string {
  if (depth > 5 || value == null) return ''
  if (typeof value === 'string') return cleanText(value.replace(/<[^>]*>/gu, ' '))
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value))
    return cleanText(value.map((part) => richText(part, depth + 1)).join(''))
  const record = asRecord(value)
  if (!record) return ''
  for (const key of ['text', 'content', 'value', 'name', 'alt']) {
    if (record[key] !== undefined) {
      const result = richText(record[key], depth + 1)
      if (result) return result
    }
  }
  return ''
}

function cleanText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function portraitUrl(portrait: string): string {
  return `https://himg.bdimg.com/sys/portrait/item/${encodeURIComponent(portrait)}.jpg`
}

function firstNumber(record: JsonRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && /^-?\d+$/u.test(value)) return Number(value)
  }
  return undefined
}
