import { randomUUID } from 'node:crypto'
import { parseTiebaTime, type ParsedTime } from './date'
import { CoreError, assertHttpOk } from './errors'
import type { HomeFeedMetadata } from './home-feed'
import { decodeUserPostResponse, encodeUserPostRequest } from './tieba-userpost-proto'
import type { Transport } from './transport'

const TIEBA_ORIGIN = 'https://tieba.baidu.com'
const APP_ORIGIN = 'https://tiebac.baidu.com'
const PUBLIC_CLIENT_VERSION = '8.9.8.5'
const AUTHENTICATED_CLIENT_VERSION = '22.6.5.1'
const PAGE_SIZE = 30

type JsonRecord = Record<string, unknown>

export interface UserPostCredential {
  uid: string
  bduss: string
}

export interface UserPostPage {
  items: HomeFeedMetadata[]
  hasMore: boolean
  hidden: boolean
}

export async function fetchUserPostPage(
  transport: Transport,
  credential: UserPostCredential,
  page: number,
  timeoutMs: number,
  now: Date
): Promise<UserPostPage> {
  try {
    const publicResult = await requestUserPostPage(
      transport,
      credential.uid,
      page,
      timeoutMs,
      PUBLIC_CLIENT_VERSION,
      now
    )
    if (page !== 1 || (!publicResult.hidden && publicResult.items.length > 0)) return publicResult

    const authenticatedResult = await requestUserPostPage(
      transport,
      credential.uid,
      page,
      timeoutMs,
      AUTHENTICATED_CLIENT_VERSION,
      now,
      credential.bduss
    )
    return {
      ...authenticatedResult,
      hidden: publicResult.hidden || authenticatedResult.hidden
    }
  } catch (publicError) {
    try {
      return await requestUserPostPage(
        transport,
        credential.uid,
        page,
        timeoutMs,
        AUTHENTICATED_CLIENT_VERSION,
        now,
        credential.bduss
      )
    } catch {
      throw publicError
    }
  }
}

async function requestUserPostPage(
  transport: Transport,
  uid: string,
  page: number,
  timeoutMs: number,
  clientVersion: string,
  now: Date,
  bduss?: string
): Promise<UserPostPage> {
  const payload = encodeUserPostRequest({
    uid,
    ...(bduss ? { bduss } : {}),
    page,
    pageSize: PAGE_SIZE,
    clientVersion
  })
  const boundary = `----TiebaCleaner${randomUUID().replaceAll('-', '')}`

  const response = await transport.request({
    url: `${APP_ORIGIN}/c/u/feed/userpost?cmd=303002`,
    method: 'POST',
    credentials: 'omit',
    timeoutMs,
    operation: bduss ? 'content:userpost-authenticated' : 'content:userpost-public',
    responseType: 'binary',
    headers: {
      Accept: 'application/octet-stream,*/*',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      x_bd_data_type: 'protobuf'
    },
    body: multipartBody(payload, boundary)
  })
  assertHttpOk(response.status)
  if (!response.bytes) {
    throw new CoreError('PARSE_FAILED', '贴吧客户端回复接口没有返回二进制数据')
  }
  return parseUserPostProtoResponse(response.bytes, now)
}

export function parseUserPostProtoResponse(bytes: Uint8Array, now: Date): UserPostPage {
  let decoded: ReturnType<typeof decodeUserPostResponse>
  try {
    decoded = decodeUserPostResponse(bytes)
  } catch (error) {
    throw new CoreError('PARSE_FAILED', '贴吧客户端回复接口返回了无法识别的数据', {
      cause: error
    })
  }
  if (decoded.errorCode !== 0) {
    const message = decoded.errorMessage || '贴吧客户端回复接口暂时不可用'
    if (/未登录|登录失败|login/iu.test(message)) throw new CoreError('AUTH_EXPIRED', message)
    throw new CoreError('PARSE_FAILED', message)
  }
  return {
    items: decoded.groups.flatMap((group) => parseGroup(group, now)),
    hasMore: decoded.groups.length > 0,
    hidden: decoded.hidden
  }
}

function parseGroup(value: unknown, now: Date): HomeFeedMetadata[] {
  const group = asRecord(value)
  if (!group) return []
  const tid = firstIdentifier(group, ['thread_id', 'threadId', 'tid'])
  if (!tid) return []
  const forumId = firstIdentifier(group, ['forum_id', 'forumId', 'fid'])
  const content = Array.isArray(group.content) ? group.content : []
  const forumName = firstText(group, ['forum_name', 'forumName'])?.replace(/吧$/u, '')
  const originalTitle = firstText(group, ['title'])
  const displayName = firstText(group, ['name_show', 'nameShow', 'user_name', 'userName'])
  const portrait = firstText(group, ['user_portrait', 'userPortrait'])

  return content.flatMap((value) => {
    const reply = asRecord(value)
    if (!reply) return []
    const pid = firstIdentifier(reply, ['post_id', 'postId', 'pid'])
    if (!pid) return []
    const title = richText(reply.post_content ?? reply.postContent)
    const time = parseClientTime(firstPrimitive(reply, ['create_time', 'createTime', 'time']), now)
    const location = new URL(`${TIEBA_ORIGIN}/p/${tid}`)
    if (forumId) location.searchParams.set('fid', forumId)
    location.searchParams.set('pid', pid)
    location.searchParams.set('cid', pid)
    location.hash = pid
    return [
      {
        kind: 'reply' as const,
        tid,
        pid,
        ...(title ? { title } : {}),
        ...(originalTitle ? { summary: `原帖：${originalTitle}` } : {}),
        ...(displayName ? { displayName } : {}),
        ...(forumName ? { forumName } : {}),
        ...(portrait ? { avatarUrl: portraitUrl(portrait) } : {}),
        sourceUrl: location.toString(),
        ...time
      }
    ]
  })
}

function parseClientTime(value: string | number | boolean | undefined, now: Date): ParsedTime {
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

function richText(value: unknown, depth = 0): string {
  if (depth > 5 || value == null) return ''
  if (typeof value === 'string') return cleanText(value.replace(/<[^>]*>/gu, ' '))
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value))
    return cleanText(value.map((item) => richText(item, depth + 1)).join(''))
  const record = asRecord(value)
  if (!record) return ''
  for (const key of ['text', 'content', 'value', 'name', 'alt']) {
    if (record[key] === undefined) continue
    const result = richText(record[key], depth + 1)
    if (result) return result
  }
  return ''
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

function firstIdentifier(record: JsonRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if ((typeof value === 'string' || typeof value === 'number') && /^\d+$/u.test(String(value))) {
      return String(value)
    }
  }
  return undefined
}

function firstText(record: JsonRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = richText(record[key])
    if (value) return value
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

function cleanText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function portraitUrl(portrait: string): string {
  return `https://himg.bdimg.com/sys/portrait/item/${encodeURIComponent(portrait)}.jpg`
}

function multipartBody(payload: Uint8Array, boundary: string): Uint8Array {
  const encoder = new TextEncoder()
  const prefix = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="data"; filename="file"\r\nContent-Type: application/octet-stream\r\n\r\n`
  )
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`)
  const body = new Uint8Array(prefix.length + payload.length + suffix.length)
  body.set(prefix)
  body.set(payload, prefix.length)
  body.set(suffix, prefix.length + payload.length)
  return body
}
