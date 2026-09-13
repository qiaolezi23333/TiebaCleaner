import * as cheerio from 'cheerio'
import type { Cheerio, CheerioAPI } from 'cheerio'
import type { AnyNode } from 'domhandler'
import type { CleanupItem, CleanupKind } from '../../shared/types'
import { signClientParams } from './client-sign'
import { parseTiebaTime } from './date'
import { CoreError, assertHttpOk, toCoreError } from './errors'
import type { Transport } from './transport'

const TIEBA_ORIGIN = 'https://tieba.baidu.com'
const JSON_ACCEPT = 'application/json,text/plain,*/*'

export interface DeleteRequest {
  url: string
  referer: string
  params: Record<string, string>
  successField: 'err_code' | 'error_code' | 'no'
  needsFreshTbs?: boolean
  needsBduss?: boolean
  needsClientSign?: boolean
}

export interface InternalCleanupItem extends CleanupItem {
  deleteRequest: DeleteRequest
}

export interface ParsedPage {
  items: InternalCleanupItem[]
  hasNextPage: boolean | null
}

export interface CleanupAdapter {
  readonly kind: CleanupKind
  pageUrl(page: number): string
  parsePage(html: string, pageUrl: string, now: Date): ParsedPage
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function absoluteUrl(value: string | undefined, fallback: string): string {
  if (!value) return fallback
  try {
    const url = new URL(value, TIEBA_ORIGIN)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'tieba.baidu.com')
      return fallback
    return url.toString()
  } catch {
    return fallback
  }
}

function getContainer(
  element: AnyNode,
  $: CheerioAPI,
  preferredSelector: string
): Cheerio<AnyNode> {
  const current = $(element)
  const preferred = current.closest(preferredSelector).first()
  if (preferred.length) return preferred
  const fallback = current.closest('.feed_item, .list_item, .thread_item, li, tr').first()
  return fallback.length ? fallback : current.parent()
}

/**
 * Tieba's newer personal-center cards use generated class names and can wrap
 * the action link in many otherwise anonymous divs. Walk outwards until the
 * next item boundary (a second action link) and keep the closest ancestor that
 * contains the useful fields for this one item.
 */
function getContentContainer(
  element: AnyNode,
  $: CheerioAPI,
  actionSelector: string,
  preferredSelector: string
): Cheerio<AnyNode> {
  const preferred = $(element).closest(preferredSelector).first()
  if (preferred.length) return preferred

  let candidate = $(element).parent()
  let best = candidate
  let bestScore = -1
  for (let depth = 0; depth < 20 && candidate.length && !candidate.is('body, html'); depth += 1) {
    const actionCount = candidate.find(actionSelector).length
    if (actionCount > 1) break
    if (actionCount === 1) {
      const score = contentContainerScore(candidate)
      if (score > bestScore) {
        best = candidate
        bestScore = score
      }
    }
    candidate = candidate.parent()
  }
  return best
}

function contentContainerScore(container: Cheerio<AnyNode>): number {
  let score = 0
  if (
    container.find(
      '.n_txt, .feed_rich, .reply_content, .reply_body_text, .thread_content, .post_abstract_text, .thread-card-content, .content, [data-content]'
    ).length
  )
    score += 12
  if (container.find('a[href*="/f?"][href*="kw="], [data-forum-name]').length) score += 8
  if (
    container.find(
      '[data-time], [data-timestamp], time, .time, .post_time, .feed_time, .thread_time, .n_post_time, .n_reply_time'
    ).length
  )
    score += 8
  if (findExactTimeLabel(container)) score += 6
  if (findReplyBody(container)) score += 10
  if (container.find('[data-tid], [data-pid], [data-thread-id], [data-post-id]').length) score += 4
  return score
}

function getRelationContainer(
  element: AnyNode,
  $: CheerioAPI,
  actionSelector: string,
  identitySelector: string
): Cheerio<AnyNode> {
  let candidate = $(element).parent()
  for (let depth = 0; depth < 10 && candidate.length && !candidate.is('body, html'); depth += 1) {
    if (candidate.find(actionSelector).length === 1 && candidate.find(identitySelector).length) {
      return candidate
    }
    candidate = candidate.parent()
  }
  const preferred = getContainer(element, $, '.block, .concern_item, .fans_item, tr')
  return preferred.find(actionSelector).length === 1 ? preferred : $(element).parent()
}

function readTime(
  container: Cheerio<AnyNode>,
  now: Date,
  $: CheerioAPI
): ReturnType<typeof parseTiebaTime> {
  const timeSelector =
    '[data-time], [data-timestamp], time, .time, .post_time, .feed_time, .thread_time, .n_post_time, .n_reply_time, .post_list_item_info_time'
  const candidates = container.is(timeSelector)
    ? [container.get(0), ...container.find(timeSelector).toArray()]
    : container.find(timeSelector).toArray()
  let firstLabel: string | undefined
  for (const node of candidates) {
    if (!node) continue
    const timed = $(node)
    const epoch = timed.attr('data-time') ?? timed.attr('data-timestamp')
    if (epoch && /^\d{10,13}$/u.test(epoch)) {
      const millis = epoch.length === 10 ? Number(epoch) * 1000 : Number(epoch)
      const date = new Date(millis)
      if (!Number.isNaN(date.getTime())) {
        return {
          timestamp: date.toISOString(),
          timeLabel: cleanText(timed.text()) || epoch,
          timeKnown: true
        }
      }
    }
    const labels = [timed.attr('datetime'), timed.attr('title'), cleanText(timed.text())].filter(
      (value): value is string => Boolean(value)
    )
    firstLabel ??= labels[0]
    for (const label of labels) {
      const parsed = parseTiebaTime(label, now)
      if (parsed.timeKnown) return parsed
    }
  }
  // The redesigned user profile uses generated class names. Accept a date only
  // when the complete text of a small descendant is a known time expression;
  // this avoids treating a date embedded in the reply body as its publish time.
  const exactLabel = findExactTimeLabel(container)
  if (exactLabel) {
    const parsed = parseTiebaTime(exactLabel, now)
    if (parsed.timeKnown) return parsed
  }
  // Only explicit time elements are trusted. Parsing the whole content block can
  // mistake a date mentioned in the user's text for the publication time.
  return parseTiebaTime(firstLabel, now)
}

const EXACT_TIME_LABEL =
  /^(?:(?:\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?|\d{1,2}[-/.月]\d{1,2}(?:日)?)(?:\s+\d{1,2}:\d{2})?|(?:今天|今日|昨天)\s*\d{1,2}:\d{2})$/u

function findExactTimeLabel(container: Cheerio<AnyNode>): string | undefined {
  return shortestMatchingText(container, (value) => EXACT_TIME_LABEL.test(value))
}

function shortestMatchingText(
  container: Cheerio<AnyNode>,
  predicate: (value: string) => boolean
): string | undefined {
  const candidates = container
    .find('div, span, p, a, time')
    .toArray()
    .map((node) => cleanText(container.find(node).text()))
    .filter((value, index, values) => value && predicate(value) && values.indexOf(value) === index)
    .sort((left, right) => left.length - right.length)
  return candidates[0]
}

function findReplyBody(container: Cheerio<AnyNode>): string | undefined {
  const explicit = container
    .find(
      'a.for_reply_context, .reply_body_text, .n_txt, .feed_rich, .reply_content, .reply-text, .reply_text, [data-content], [data-reply-content]'
    )
    .toArray()
    .map((node) => cleanText(container.find(node).text()))
    .filter(
      (value) =>
        Boolean(value) &&
        !value.includes('\ufffd') &&
        !/^(?:回复|回帖|删除)$/u.test(value) &&
        !/^原帖\s*[：:]/u.test(value)
    )
    .sort((left, right) => left.length - right.length)[0]
  if (explicit) return stripReplyPrefix(explicit)

  const replyLine = shortestMatchingText(container, (value) => {
    if (!/^(?:回复|回帖)\s*(?:@.*?)?[：:]/u.test(value)) return false
    return !/^(?:回复|回帖)\s*(?:@.*?)?[：:]\s*$/u.test(value)
  })
  return replyLine ? stripReplyPrefix(replyLine) : undefined
}

function stripReplyPrefix(value: string): string {
  const withoutContext = value.split(/\s*原帖\s*[：:]/u, 1)[0]
  return cleanText(withoutContext.replace(/^(?:回复|回帖)\s*(?:@.*?)?[：:]\s*/u, ''))
}

function forumFrom(container: Cheerio<AnyNode>): string | undefined {
  for (const node of container
    .find(
      '.title-tag-wraper a, .forum_name, .p_forum, .post_list_item_info_forum, [data-forum-name]'
    )
    .toArray()) {
    const element = container.find(node)
    const explicit = firstReadableLabel(
      element.attr('data-forum-name'),
      element.attr('title'),
      cleanText(element.text())
    )
    if (explicit) return explicit.replace(/吧$/u, '')
  }
  const anchor = container
    .find('a[href*="/f?"], a[href*="/f/"]')
    .filter((_, el) => {
      const href = container.find(el).attr('href') ?? ''
      return href.includes('kw=') || href.includes('ie=utf-8')
    })
    .first()
  const fromText = firstReadableLabel(cleanText(anchor.text()), anchor.attr('title'))
  if (fromText) return fromText.replace(/吧$/, '')
  const href = anchor.attr('href')
  if (href) {
    const rawKeyword = href.match(/[?&]kw=([^&#]+)/iu)?.[1]
    const decodedKeyword = decodeTiebaName(rawKeyword)
    if (decodedKeyword) return decodedKeyword
    try {
      const keyword = new URL(href, TIEBA_ORIGIN).searchParams.get('kw')
      const readableKeyword = firstReadableLabel(keyword ?? undefined)
      if (readableKeyword) return readableKeyword
    } catch {
      // Ignore malformed source links; the item can still be previewed.
    }
  }
  return undefined
}

function pageHasNext($: CheerioAPI, pageUrl: string): boolean | null {
  let currentPage = 1
  try {
    currentPage = Number(new URL(pageUrl).searchParams.get('pn')) || 1
  } catch {
    // The requested page number defaults to one for malformed final URLs.
  }

  const pagers = $('.itb_pager, .pagination, .pager, .p_pager, .page')
  const links = pagers.find('a[href]').add('a[rel="next"], a.next, a.next_page').toArray()
  for (const node of links) {
    const link = $(node)
    if (
      link.attr('aria-disabled') === 'true' ||
      /(?:disabled|off)/iu.test(link.attr('class') ?? '')
    )
      continue
    const label = cleanText(`${link.text()} ${link.attr('title') ?? ''}`)
    const relation = link.attr('rel')?.toLowerCase()
    const href = link.attr('href')
    if (relation === 'next' || /^(?:下一页|下页|next|›|»)\s*$/iu.test(label)) return true
    if (!href) continue
    try {
      const nextPage = Number(new URL(href, pageUrl).searchParams.get('pn'))
      if (Number.isInteger(nextPage) && nextPage > currentPage) return true
    } catch {
      // Ignore malformed pager links and keep scanning conservatively.
    }
  }

  const disabledNext = pagers
    .find('span, button, a')
    .toArray()
    .some((node) => {
      const element = $(node)
      const label = cleanText(`${element.text()} ${element.attr('title') ?? ''}`)
      return (
        /(?:下一页|下页|next)/iu.test(label) &&
        (element.is('span') ||
          element.attr('disabled') !== undefined ||
          element.attr('aria-disabled') === 'true' ||
          /(?:disabled|off)/iu.test(element.attr('class') ?? ''))
      )
    })
  if (disabledNext) return false
  return null
}

function contentAdapter(kind: Extract<CleanupKind, 'reply' | 'post'>): CleanupAdapter {
  const selector =
    kind === 'reply' ? 'a.for_reply_context, a.b_reply' : 'a.thread_title, a.list_item_link'
  const route = kind === 'reply' ? 'my_reply' : 'my_tie'
  return {
    kind,
    pageUrl: (page) => `${TIEBA_ORIGIN}/i/i/${route}?pn=${page}`,
    parsePage(html, pageUrl, now) {
      const $ = cheerio.load(html)
      const items: InternalCleanupItem[] = []
      const seen = new Set<string>()
      const elements =
        kind === 'reply'
          ? [...$('a.for_reply_context').toArray(), ...$('a.b_reply').toArray()]
          : $(selector).toArray()
      elements.forEach((element) => {
        const anchor = $(element)
        const href = anchor.attr('href') ?? ''
        const tid = href.match(/\/p\/(\d+)/)?.[1] ?? anchor.attr('data-tid')
        let pid = href.match(/[?&#]pid=(\d+)/)?.[1] ?? anchor.attr('data-pid')
        const cid = href.match(/[?&#]cid=(\d+)/)?.[1] ?? anchor.attr('data-cid')
        if (cid && cid !== '0') pid = cid
        // Both legacy delete flows submit tid + pid. A reply without pid/cid
        // can also be misinterpreted as a topic deletion, so never expose an
        // item unless both stable identifiers are available.
        if (!tid || !pid) return

        const container = getContentContainer(
          element,
          $,
          kind === 'reply' && anchor.is('a.for_reply_context')
            ? 'a.for_reply_context'
            : kind === 'reply'
              ? 'a.b_reply'
              : selector,
          kind === 'reply'
            ? '.list_item, .j_feed_li, .feed_item'
            : '.list_item, .j_feed_li, .thread_item, .feed_item'
        )
        const contentText =
          kind === 'reply'
            ? (findReplyBody(container) ?? '')
            : cleanText(
                container
                  .find(
                    '.post_abstract_text, .feed_rich, .thread_content, .content, [data-content]'
                  )
                  .first()
                  .text()
              )
        const title =
          kind === 'reply'
            ? contentText || `回复 ${tid}`
            : cleanText(
                container.find('.post_list_item_title').first().text() ||
                  anchor.attr('title') ||
                  anchor.text()
              ) ||
              contentText ||
              `主题帖 ${tid}`
        const time = readTime(container, now, $)
        const forumName = forumFrom(container)
        const id = `${kind}:${tid}:${pid}`
        if (seen.has(id)) return
        seen.add(id)
        const sourceUrl = absoluteUrl(href, `${TIEBA_ORIGIN}/p/${tid}`)
        items.push({
          id,
          kind,
          title,
          summary: contentText || title,
          ...(forumName ? { forumName } : {}),
          ...time,
          sourceUrl,
          status: 'pending',
          deleteRequest: {
            url: `${TIEBA_ORIGIN}/f/commit/post/delete`,
            referer: `${TIEBA_ORIGIN}/i/i/${route}`,
            params: { tid, pid },
            successField: 'err_code',
            needsFreshTbs: true
          }
        })
      })
      return { items, hasNextPage: pageHasNext($, pageUrl) }
    }
  }
}

function userDisplayName(container: Cheerio<AnyNode>, $: CheerioAPI): string {
  const selectors = [
    '.userinfo_username',
    '.concern_name',
    '.fans_name',
    '.post_author',
    '.user_name',
    '.username',
    '.user-name',
    '.nickname',
    '.name',
    '.j_user_card',
    '[username]',
    '[data-username]',
    'a[href*="/home/"]',
    'a[href*="/i/i"]',
    'a[href*="un="]'
  ]
  for (const selector of selectors) {
    for (const node of container.find(selector).toArray()) {
      const element = $(node)
      const href = element.attr('href')
      let urlName: string | null = null
      if (href) {
        try {
          const url = new URL(href, TIEBA_ORIGIN)
          urlName =
            url.searchParams.get('un') ??
            url.searchParams.get('user_name') ??
            url.searchParams.get('username')
        } catch {
          // Other explicit name fields can still identify this user.
        }
      }
      const candidate = firstSafeUserName(
        cleanText(element.text()),
        element.attr('title'),
        element.attr('username'),
        element.attr('data-username'),
        element.attr('data-name'),
        element.attr('un'),
        element.attr('aria-label'),
        urlName
      )
      if (candidate) return candidate
    }
  }

  for (const node of container.find('img[alt]').toArray()) {
    const candidate = firstSafeUserName($(node).attr('alt'), $(node).attr('title'))
    if (candidate) return candidate
  }

  const metadataNodes = [
    ...(container.attr('data-field') ? [container.get(0)] : []),
    ...container.find('[data-field]').toArray()
  ]
  for (const node of metadataNodes) {
    if (!node) continue
    const dataField = $(node).attr('data-field')
    if (!dataField) continue
    try {
      const record = JSON.parse(dataField) as Record<string, unknown>
      const candidate = firstSafeUserName(
        record.showname,
        record.name_show,
        record.nick_name_new,
        record.nick_name,
        record.user_name,
        record.username,
        record.un,
        record.name
      )
      if (candidate) return candidate
    } catch {
      const candidate = nameFromLooseMetadata(dataField)
      if (candidate) return candidate
    }
  }
  return '未知用户'
}

function nameFromLooseMetadata(value: string): string | undefined {
  const match = value.match(
    /(?:^|[,{])\s*['"]?(?:showname|name_show|nick_name_new|nick_name|user_name|username|un|name)['"]?\s*:\s*(['"])(.*?)\1/iu
  )
  return firstSafeUserName(match?.[2])
}

function followerUserId(
  button: Cheerio<AnyNode>,
  container: Cheerio<AnyNode>,
  $: CheerioAPI
): string | undefined {
  const attributeNames = ['fans_uid', 'data-uid', 'uid', 'data-user-id', 'user_id']
  const nodes = [
    button.get(0),
    container.get(0),
    ...container
      .find('[fans_uid], [data-uid], [uid], [data-user-id], [user_id], [data-field]')
      .toArray()
  ]
  for (const node of nodes) {
    if (!node) continue
    const element = $(node)
    for (const attribute of attributeNames) {
      const value = element.attr(attribute)?.trim()
      if (value && /^\d+$/u.test(value) && value !== '0') return value
    }
    const dataField = element.attr('data-field')
    if (!dataField) continue
    try {
      const record = JSON.parse(dataField) as Record<string, unknown>
      for (const key of ['fans_uid', 'user_id', 'uid', 'id']) {
        const value = record[key]
        if (
          (typeof value === 'number' || typeof value === 'string') &&
          /^\d+$/u.test(String(value))
        ) {
          return String(value)
        }
      }
    } catch {
      const value = dataField.match(
        /(?:^|[,{])\s*['"]?(?:fans_uid|user_id|uid|id)['"]?\s*:\s*['"]?(\d+)/iu
      )?.[1]
      if (value && value !== '0') return value
    }
  }
  return undefined
}

function firstSafeUserName(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const candidate = cleanText(value)
    if (
      candidate &&
      !candidate.includes('\ufffd') &&
      !/^tb\.\d+\./iu.test(candidate) &&
      !/^(?:取消关注|关注|移除粉丝|加黑名单|加入黑名单|私信|主页)$/u.test(candidate)
    ) {
      return candidate
    }
  }
  return undefined
}

function firstReadableLabel(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') continue
    const candidate = cleanText(value)
    if (candidate && !candidate.includes('\ufffd')) return candidate
  }
  return undefined
}

function forumDisplayName(
  container: Cheerio<AnyNode>,
  $: CheerioAPI,
  rawForumName: string | undefined,
  fid: string
): string {
  for (const node of container.find('a[href*="/f?"]').toArray()) {
    const anchor = $(node)
    const candidate = firstReadableLabel(anchor.attr('title'), cleanText(anchor.text()))?.replace(
      /吧$/u,
      ''
    )
    if (candidate) return candidate
  }
  const decoded = decodeTiebaName(rawForumName)
  return decoded || `贴吧 ${fid}`
}

function decodeTiebaName(value: string | undefined): string | undefined {
  const input = value?.trim()
  if (!input) return undefined
  if (!/%[0-9a-f]{2}/iu.test(input)) return cleanText(input).replace(/吧$/u, '')
  try {
    return cleanText(decodeURIComponent(input)).replace(/吧$/u, '')
  } catch {
    const bytes: number[] = []
    for (let index = 0; index < input.length; index += 1) {
      if (input[index] === '%' && /^[0-9a-f]{2}$/iu.test(input.slice(index + 1, index + 3))) {
        bytes.push(Number.parseInt(input.slice(index + 1, index + 3), 16))
        index += 2
      } else {
        const code = input.charCodeAt(index)
        if (code > 0x7f) return undefined
        bytes.push(code)
      }
    }
    try {
      return cleanText(
        new TextDecoder('gbk', { fatal: true }).decode(Uint8Array.from(bytes))
      ).replace(/吧$/u, '')
    } catch {
      return undefined
    }
  }
}

function relationAdapter(
  kind: Extract<CleanupKind, 'followingUser' | 'followingForum' | 'follower'>
): CleanupAdapter {
  const config = {
    followingUser: {
      route: '/i/i/concern',
      selector: 'input.btn_unfollow[portrait], button.btn_unfollow[portrait]',
      command: 'unfollow'
    },
    followingForum: {
      route: '/f/like/mylike',
      selector: '[balvid][balvname]',
      command: null
    },
    follower: {
      route: '/i/i/fans',
      selector: 'input.btn_follow[portrait], button.btn_follow[portrait]',
      command: null
    }
  }[kind]

  return {
    kind,
    pageUrl: (page) => `${TIEBA_ORIGIN}${config.route}?pn=${page}`,
    parsePage(html, pageUrl) {
      const $ = cheerio.load(html)
      const items: InternalCleanupItem[] = []
      const seen = new Set<string>()
      $(config.selector).each((_, element) => {
        const button = $(element)
        const identitySelector =
          kind === 'followingForum'
            ? 'a[href*="/f?"]'
            : '.userinfo_username, .user_name, .username, .user-name, .post_author, .j_user_card, a[href*="/home/"], a[href*="/i/i"], a[href*="un="], [username], [data-username], [data-field], img[alt]:not([alt=""])'
        const container = getRelationContainer(element, $, config.selector, identitySelector)
        const portrait = button.attr('portrait')
        const fid = button.attr('balvid')
        const fanUid = kind === 'follower' ? followerUserId(button, container, $) : undefined
        const rawForumName = button.attr('balvname')?.trim()
        const stableValue =
          kind === 'followingForum' ? fid : kind === 'follower' ? fanUid : portrait
        if (!stableValue) return
        const id = `${kind}:${stableValue}`
        if (seen.has(id)) return
        seen.add(id)

        const name =
          kind === 'followingForum'
            ? forumDisplayName(container, $, rawForumName, fid as string)
            : userDisplayName(container, $)
        const link = container
          .find(
            kind === 'followingForum'
              ? 'a[href*="/f?"]'
              : 'a[href*="/home/"], a[href*="/i/i"], a[href*="un="]'
          )
          .first()
          .attr('href')
        const params: Record<string, string> =
          kind === 'followingForum'
            ? { fid: fid as string, fname: rawForumName ?? '' }
            : kind === 'follower'
              ? { fans_uid: fanUid as string }
              : { cmd: config.command as string, id: portrait as string }
        items.push({
          id,
          kind,
          title: name,
          summary:
            kind === 'followingForum'
              ? `关注的贴吧：${name}`
              : kind === 'follower'
                ? `粉丝：${name}`
                : `关注用户：${name}`,
          displayName: name,
          ...(kind === 'followingForum' ? { forumName: name } : {}),
          timestamp: null,
          timeLabel: null,
          timeKnown: false,
          sourceUrl: absoluteUrl(link, pageUrl),
          status: 'pending',
          deleteRequest: {
            url:
              kind === 'followingForum'
                ? `${TIEBA_ORIGIN}/f/like/commit/delete`
                : kind === 'follower'
                  ? 'https://tiebac.baidu.com/c/c/user/removeFans'
                  : `${TIEBA_ORIGIN}/home/post/unfollow`,
            referer: `${TIEBA_ORIGIN}${config.route}`,
            params,
            successField: kind === 'follower' ? 'error_code' : 'no',
            needsFreshTbs: true,
            ...(kind === 'follower' ? { needsBduss: true, needsClientSign: true } : {})
          }
        })
      })
      return { items, hasNextPage: pageHasNext($, pageUrl) }
    }
  }
}

export const adapters: Record<CleanupKind, CleanupAdapter> = {
  reply: contentAdapter('reply'),
  post: contentAdapter('post'),
  followingUser: relationAdapter('followingUser'),
  followingForum: relationAdapter('followingForum'),
  follower: relationAdapter('follower')
}

function looksLoggedOut(html: string, responseUrl?: string): boolean {
  return (
    Boolean(responseUrl?.includes('passport.baidu.com')) ||
    /id=["']?(?:login_btn|passport-login-pop)/i.test(html) ||
    /请先登录后继续|登录后才能查看/.test(html)
  )
}

export async function fetchPage(
  transport: Transport,
  adapter: CleanupAdapter,
  page: number,
  timeoutMs: number,
  now: Date
): Promise<ParsedPage> {
  try {
    const url = adapter.pageUrl(page)
    const response = await transport.request({
      url,
      method: 'GET',
      timeoutMs,
      operation: `scan:${adapter.kind}`
    })
    assertHttpOk(response.status)
    if (looksLoggedOut(response.body, response.url)) throw new CoreError('AUTH_EXPIRED')
    return adapter.parsePage(response.body, response.url || url, now)
  } catch (error) {
    throw toCoreError(error)
  }
}

export async function fetchTbs(transport: Transport, timeoutMs: number): Promise<string> {
  try {
    const response = await transport.request({
      url: `${TIEBA_ORIGIN}/dc/common/tbs`,
      method: 'GET',
      headers: {
        Accept: JSON_ACCEPT,
        Referer: `${TIEBA_ORIGIN}/`,
        'X-Requested-With': 'XMLHttpRequest'
      },
      timeoutMs,
      operation: 'auth:tbs'
    })
    assertHttpOk(response.status)
    if (looksLoggedOut(response.body, response.url)) {
      throw new CoreError('AUTH_EXPIRED', '删除前的登录校验未通过，请重新登录')
    }
    let data: unknown
    try {
      data = JSON.parse(response.body)
    } catch (cause) {
      throw new CoreError('PARSE_FAILED', undefined, { cause })
    }
    if (!data || typeof data !== 'object') throw new CoreError('PARSE_FAILED')
    const record = data as Record<string, unknown>
    if (!record.is_login || typeof record.tbs !== 'string' || !record.tbs) {
      throw new CoreError('AUTH_EXPIRED', '删除前的登录校验未通过，请重新登录')
    }
    return record.tbs
  } catch (error) {
    throw toCoreError(error)
  }
}

export interface DeleteResult {
  success: boolean
  limited: boolean
  message?: string
}

export interface DeleteRuntimeCredential {
  bduss?: string | null
}

/** One destructive request, deliberately with no retry loop. */
export async function deleteItem(
  transport: Transport,
  item: InternalCleanupItem,
  timeoutMs: number,
  credential: DeleteRuntimeCredential = {}
): Promise<DeleteResult> {
  try {
    const params = { ...item.deleteRequest.params }
    if (item.deleteRequest.needsBduss) {
      const bduss = credential.bduss?.trim()
      if (!bduss) throw new CoreError('AUTH_EXPIRED', '无法读取当前账号登录凭据，请重新登录')
      params.BDUSS = bduss
    }
    if (item.deleteRequest.needsFreshTbs) params.tbs = await fetchTbs(transport, timeoutMs)
    if (item.deleteRequest.needsClientSign) params.sign = signClientParams(params)
    const body = new URLSearchParams(params).toString()
    const headers: Record<string, string> = {
      Accept: JSON_ACCEPT,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    }
    if (!item.deleteRequest.needsClientSign) {
      headers.Origin = TIEBA_ORIGIN
      headers.Referer = item.deleteRequest.referer
      headers['X-Requested-With'] = 'XMLHttpRequest'
    }
    const response = await transport.request({
      url: item.deleteRequest.url,
      method: 'POST',
      headers,
      body,
      timeoutMs,
      operation: `delete:${item.kind}`
    })
    assertHttpOk(response.status)
    if (looksLoggedOut(response.body, response.url)) {
      throw new CoreError('AUTH_EXPIRED', '删除请求未携带有效登录状态，请重新登录')
    }
    let data: unknown
    try {
      data = JSON.parse(response.body)
    } catch (cause) {
      throw new CoreError('PARSE_FAILED', undefined, { cause })
    }
    if (!data || typeof data !== 'object') throw new CoreError('PARSE_FAILED')
    const record = data as Record<string, unknown>
    const code = Number(record[item.deleteRequest.successField])
    const limited =
      code === 220034 || Number(record.err_code) === 220034 || Number(record.no) === 220034
    if (limited) return { success: false, limited: true, message: '已触发贴吧删除频率或每日上限' }
    if (code === 0) return { success: true, limited: false }
    const message =
      [record.err_msg, record.error, record.error_msg, record.message].find(
        (value) => typeof value === 'string'
      ) ?? '贴吧未接受此次操作'
    return { success: false, limited: false, message: String(message) }
  } catch (error) {
    throw toCoreError(error)
  }
}
