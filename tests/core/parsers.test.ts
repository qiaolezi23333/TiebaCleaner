import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adapters } from '../../src/main/core/adapters'
import { parseFilterRange, parseTiebaTime } from '../../src/main/core/date'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')
const now = new Date(2026, 8, 10, 18, 0, 0)

describe('Tieba page parsers', () => {
  it('parses replies, uses cid for nested replies, and preserves unknown time', () => {
    const result = adapters.reply.parsePage(fixture('reply.html'), adapters.reply.pageUrl(1), now)
    expect(result.hasNextPage).toBe(true)
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toMatchObject({
      id: 'reply:10001:30001',
      title: '上下文：这是第一条回复',
      summary: '上下文：这是第一条回复',
      forumName: '测试',
      timeKnown: true,
      sourceUrl: 'https://tieba.baidu.com/p/10001?pid=20001&cid=30001#30001'
    })
    expect(result.items[0].deleteRequest.params).toEqual({ tid: '10001', pid: '30001' })
    expect(result.items[1]).toMatchObject({
      id: 'reply:10002:20002',
      timeKnown: false,
      timestamp: null
    })
  })

  it('parses topic posts', () => {
    const result = adapters.post.parsePage(fixture('post.html'), adapters.post.pageUrl(1), now)
    expect(result.hasNextPage).toBeNull()
    expect(result.items[0]).toMatchObject({
      id: 'post:40001:50001',
      title: '我的主题帖标题',
      summary: '主题帖正文摘要',
      forumName: '测试',
      timeKnown: true
    })
  })

  it('never creates a reply deletion request without a reply id', () => {
    const html = `
      <li class="feed_item">
        <a class="b_reply" href="/p/90001">缺少回复 ID</a>
        <time class="feed_time">2026-09-09 12:30</time>
      </li>
    `
    const result = adapters.reply.parsePage(html, adapters.reply.pageUrl(1), now)
    expect(result.items).toEqual([])
  })

  it('never creates a topic deletion request without its post id', () => {
    const html = `
      <div class="j_feed_li">
        <a class="thread_title" href="/p/90003">缺少主题帖 PID</a>
      </div>
    `
    const result = adapters.post.parsePage(html, adapters.post.pageUrl(1), now)
    expect(result.items).toEqual([])
  })

  it('does not infer publication time from a date mentioned in reply content', () => {
    const html = `
      <li class="feed_item">
        <span class="reply_content">正文提到了 2020-01-01，但页面没有时间节点</span>
        <a class="b_reply" href="/p/90002?pid=91002">正文提到了 2020-01-01</a>
      </li>
    `
    const result = adapters.reply.parsePage(html, adapters.reply.pageUrl(1), now)
    expect(result.items[0]).toMatchObject({
      id: 'reply:90002:91002',
      timeKnown: false,
      timestamp: null
    })
  })

  it('parses reply details from deeply nested personal-home cards', () => {
    const html = `
      <section class="history-card">
        <div><div><span>测试账号</span><span>2024-06-25</span></div></div>
        <div><div><div><div>
          <a class="for_reply_context" href="/p/1234567001?pid=811&cid=922#922">
            回复：我趣，有男铜😨
          </a>
        </div></div></div></div>
        <div><a href="/f?kw=%E6%91%84%E5%BD%B1&ie=utf-8">摄影吧</a></div>
        <div class="operations"><a class="b_reply" href="/p/1234567001?pid=811&cid=922#922">回复</a></div>
      </section>
    `

    const result = adapters.reply.parsePage(html, adapters.reply.pageUrl(1), now)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      id: 'reply:1234567001:922',
      title: '我趣，有男铜😨',
      summary: '我趣，有男铜😨',
      forumName: '摄影',
      timeLabel: '2024-06-25',
      timeKnown: true
    })
  })

  it('parses the alternate personal post collection markup', () => {
    const html = `
      <article class="list_item">
        <a class="list_item_link" href="/p/8123456789?pid=8123456789">
          <h3 class="post_list_item_title">发帖合集里的标题</h3>
        </a>
        <div class="post_abstract_text">发帖合集里的正文摘要</div>
        <a class="post_list_item_info_forum" href="/f?kw=%E6%91%84%E5%BD%B1">摄影吧</a>
        <time class="post_list_item_info_time">2024-06-25</time>
      </article>
    `

    const result = adapters.post.parsePage(html, adapters.post.pageUrl(1), now)
    expect(result.items[0]).toMatchObject({
      id: 'post:8123456789:8123456789',
      title: '发帖合集里的标题',
      summary: '发帖合集里的正文摘要',
      forumName: '摄影',
      timeKnown: true
    })
  })

  it.each([
    ['followingUser', 'following-user.html', 'followingUser:portrait-one', '用户甲'],
    ['followingForum', 'following-forum.html', 'followingForum:101', '考研'],
    ['follower', 'follower.html', 'follower:70001', '粉丝甲']
  ] as const)('parses %s relationship pages', (kind, filename, id, name) => {
    const result = adapters[kind].parsePage(fixture(filename), adapters[kind].pageUrl(1), now)
    expect(result.items[0]).toMatchObject({ id, displayName: name, timeKnown: false })
  })

  it('does not retain page TBS values in parsed relationship items', () => {
    const result = adapters.followingUser.parsePage(
      fixture('following-user.html'),
      adapters.followingUser.pageUrl(1),
      now
    )
    expect(result.items[0].deleteRequest.params).not.toHaveProperty('tbs')
    expect(JSON.stringify(result.items[0])).not.toContain('secret-tbs-one')
  })

  it('builds follower removal only from a numeric UID and never from a portrait blacklist command', () => {
    const parsed = adapters.follower.parsePage(
      fixture('follower.html'),
      adapters.follower.pageUrl(1),
      now
    )
    expect(parsed.items[0].deleteRequest).toMatchObject({
      url: 'https://tiebac.baidu.com/c/c/user/removeFans',
      params: { fans_uid: '70001' },
      successField: 'error_code',
      needsBduss: true,
      needsClientSign: true
    })
    expect(JSON.stringify(parsed.items[0])).not.toContain('add_black_list')

    const withoutUid = fixture('follower.html').replace(' data-uid="70001"', '')
    expect(
      adapters.follower.parsePage(withoutUid, adapters.follower.pageUrl(1), now).items
    ).toEqual([])
  })

  it('keeps each relationship name scoped to its own list item', () => {
    const result = adapters.followingUser.parsePage(
      fixture('following-user.html'),
      adapters.followingUser.pageUrl(1),
      now
    )
    expect(result.items.map((item) => [item.id, item.displayName])).toEqual([
      ['followingUser:portrait-one', '用户甲'],
      ['followingUser:portrait-two', '用户乙']
    ])
  })

  it('reads a username from legacy single-quoted metadata without evaluating it', () => {
    const html = `
      <ul class="simple_block_container">
        <li data-field="{'un':'用户丙'}">
          <input class="btn_unfollow" portrait="portrait-three" />
        </li>
      </ul>
    `
    const result = adapters.followingUser.parsePage(html, adapters.followingUser.pageUrl(1), now)
    expect(result.items[0]).toMatchObject({
      id: 'followingUser:portrait-three',
      displayName: '用户丙'
    })
  })

  it('decodes a GBK percent-encoded forum name only for display', () => {
    const html = `
      <table><tr><td>
        <span tbs="page-tbs" balvid="303" balvname="%BF%BC%D1%D0"></span>
      </td></tr></table>
    `
    const result = adapters.followingForum.parsePage(html, adapters.followingForum.pageUrl(1), now)
    expect(result.items[0]).toMatchObject({ displayName: '考研', forumName: '考研' })
    expect(result.items[0].deleteRequest.params).toMatchObject({
      fid: '303',
      fname: '%BF%BC%D1%D0'
    })
  })

  it('falls back to the raw forum attribute when visible text was already corrupted', () => {
    const html = `
      <table><tr>
        <td><a href="/f?kw=%BF%BC%D1%D0" title="����">����</a></td>
        <td><span balvid="404" balvname="%BF%BC%D1%D0"></span></td>
      </tr></table>
    `
    const result = adapters.followingForum.parsePage(html, adapters.followingForum.pageUrl(1), now)
    expect(result.items[0]).toMatchObject({ displayName: '考研', forumName: '考研' })
  })

  it('only marks an explicit disabled next-page control as the final page', () => {
    const html = `
      <div class="j_feed_li">
        <div class="n_txt">测试回复</div>
        <a class="b_reply" href="/p/70001?pid=71001">回复</a>
      </div>
      <div class="itb_pager"><span class="next disabled">下一页</span></div>
    `
    const result = adapters.reply.parsePage(html, adapters.reply.pageUrl(3), now)
    expect(result.hasNextPage).toBe(false)
  })
})

describe('date normalization', () => {
  it('normalizes today, yesterday, partial and full dates', () => {
    expect(parseTiebaTime('今天 08:30', now).timestamp).toBe(
      new Date(2026, 8, 10, 8, 30).toISOString()
    )
    expect(parseTiebaTime('昨天 09:40', now).timestamp).toBe(
      new Date(2026, 8, 9, 9, 40).toISOString()
    )
    expect(parseTiebaTime('09-08 10:20', now).timestamp).toBe(
      new Date(2026, 8, 8, 10, 20).toISOString()
    )
    expect(parseTiebaTime('2025-12-01 11:00', now).timestamp).toBe(
      new Date(2025, 11, 1, 11, 0).toISOString()
    )
  })

  it('treats calendar end dates as inclusive', () => {
    const range = parseFilterRange('2026-09-01', '2026-09-10')
    expect(range.startMs).toBe(new Date(2026, 8, 1).getTime())
    expect(range.endMs).toBe(new Date(2026, 8, 10, 23, 59, 59, 999).getTime())
  })
})
