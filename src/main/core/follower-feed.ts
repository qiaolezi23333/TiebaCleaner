import { CoreError, assertHttpOk } from './errors'
import type { InternalCleanupItem } from './adapters'
import { signClientParams } from './client-sign'
import type { Transport } from './transport'

const APP_ORIGIN = 'https://tiebac.baidu.com'
const TIEBA_ORIGIN = 'https://tieba.baidu.com'
const CLIENT_VERSION = '22.6.5.1'

type JsonRecord = Record<string, unknown>

export interface FollowerCredential {
  uid: string
  bduss: string
}

export interface FollowerPage {
  items: InternalCleanupItem[]
  hasMore: boolean
}

export async function fetchFollowerPage(
  transport: Transport,
  credential: FollowerCredential,
  page: number,
  timeoutMs: number
): Promise<FollowerPage> {
  const params: Record<string, string> = {
    BDUSS: credential.bduss,
    _client_version: CLIENT_VERSION,
    pn: String(page),
    uid: credential.uid
  }
  params.sign = signClientParams(params)

  const response = await transport.request({
    url: `${APP_ORIGIN}/c/u/fans/page`,
    method: 'POST',
    timeoutMs,
    operation: 'relation:follower-feed',
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    },
    body: new URLSearchParams(params).toString()
  })
  assertHttpOk(response.status)
  return parseFollowerResponse(response.body)
}

export function parseFollowerResponse(body: string): FollowerPage {
  let root: unknown
  try {
    root = JSON.parse(body)
  } catch (cause) {
    throw new CoreError('PARSE_FAILED', '贴吧粉丝接口返回了无法识别的数据', { cause })
  }
  const record = asRecord(root)
  if (!record) throw new CoreError('PARSE_FAILED', '贴吧粉丝接口缺少结果数据')
  const errorCode = numberValue(record.error_code)
  if (errorCode !== undefined && errorCode !== 0) {
    throw new CoreError('PARSE_FAILED', '贴吧粉丝接口暂时不可用')
  }

  const users = Array.isArray(record.user_list) ? record.user_list : []
  const page = asRecord(record.page)
  return {
    items: users.flatMap((value) => {
      const user = asRecord(value)
      if (!user) return []
      const uid = identifier(user.id ?? user.user_id ?? user.uid)
      if (!uid) return []
      const portrait = textValue(user.portrait)?.replace(/\?.*$/u, '')
      const displayName =
        textValue(user.name_show) || textValue(user.nick_name_new) || textValue(user.name) || uid
      const sourceUrl = portrait
        ? `${TIEBA_ORIGIN}/home/main?id=${encodeURIComponent(portrait)}`
        : `${TIEBA_ORIGIN}/i/i/fans`
      return [
        {
          id: `follower:${uid}`,
          kind: 'follower' as const,
          title: displayName,
          summary: `粉丝：${displayName}`,
          displayName,
          ...(portrait ? { avatarUrl: portraitUrl(portrait) } : {}),
          timestamp: null,
          timeLabel: null,
          timeKnown: false,
          sourceUrl,
          status: 'pending' as const,
          deleteRequest: directRemoveRequest(uid)
        }
      ]
    }),
    hasMore: truthyFlag(page?.has_more)
  }
}

export function directRemoveRequest(uid: string): InternalCleanupItem['deleteRequest'] {
  return {
    url: `${APP_ORIGIN}/c/c/user/removeFans`,
    referer: `${TIEBA_ORIGIN}/i/i/fans`,
    params: { fans_uid: uid },
    successField: 'error_code',
    needsFreshTbs: true,
    needsBduss: true,
    needsClientSign: true
  }
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

function identifier(value: unknown): string | undefined {
  const result = typeof value === 'number' || typeof value === 'string' ? String(value) : ''
  return /^\d+$/u.test(result) && result !== '0' ? result : undefined
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return typeof value === 'string' && /^-?\d+$/u.test(value) ? Number(value) : undefined
}

function truthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function portraitUrl(portrait: string): string {
  return `https://himg.bdimg.com/sys/portrait/item/${encodeURIComponent(portrait)}.jpg`
}
