import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BinaryWriter } from '@bufbuild/protobuf/wire'
import { describe, expect, it, vi } from 'vitest'
import type { CleanupKind, TaskLogEntry } from '../../src/shared/types'
import { signClientParams } from '../../src/main/core/client-sign'
import { CoreEngine } from '../../src/main/core/engine'
import { CoreError } from '../../src/main/core/errors'
import { redactLogText } from '../../src/main/core/logger'
import type { Transport, TransportRequest, TransportResponse } from '../../src/main/core/transport'

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

class MockTransport implements Transport {
  readonly requests: TransportRequest[] = []

  constructor(
    private readonly handler: (
      request: TransportRequest
    ) => TransportResponse | Promise<TransportResponse>,
    private readonly provideDefaultTbs = true
  ) {}

  async request(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request)
    if (this.provideDefaultTbs && request.operation === 'auth:tbs') {
      return { status: 200, body: '{"is_login":1,"tbs":"fresh-test-tbs"}' }
    }
    return this.handler(request)
  }
}

const fixedNow = (): Date => new Date('2026-09-10T10:00:00.000Z')

function htmlTransport(kind: CleanupKind, html: string): MockTransport {
  const route = {
    reply: 'my_reply',
    post: 'my_tie',
    followingUser: 'concern',
    followingForum: 'mylike',
    follower: 'fans'
  }[kind]
  return new MockTransport((request) => {
    if (request.url.includes(route)) return { status: 200, body: html }
    throw new Error(`unexpected request: ${request.url}`)
  })
}

describe('CoreEngine querying', () => {
  it('combines date, keyword, and forum filters while preserving unknown dates', async () => {
    const engine = new CoreEngine({
      transport: htmlTransport('reply', fixture('reply.html')),
      now: fixedNow
    })
    const result = await engine.query({
      kind: 'reply',
      startDate: '2026-09-10',
      keyword: '未知时间',
      forumName: '另一个吧',
      maxPages: 5
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({ id: 'reply:10002:20002', timeKnown: false })
    expect(JSON.stringify(result)).not.toMatch(/secret|tbs/i)
  })

  it('supports name search for relationships', async () => {
    const engine = new CoreEngine({
      transport: htmlTransport('followingUser', fixture('following-user.html')),
      now: fixedNow
    })
    const result = await engine.query({ kind: 'followingUser', keyword: '乙', maxPages: 3 })
    expect(result.items.map((item) => item.displayName)).toEqual(['用户乙'])
  })

  it('queries numeric follower UIDs and removes a fan through the signed client endpoint', async () => {
    const logs: TaskLogEntry[] = []
    const transport = new MockTransport((request) => {
      if (request.url.includes('/i/i/fans')) {
        return { status: 200, body: '<html><body><div class="pagination"></div></body></html>' }
      }
      if (request.url.includes('/c/u/fans/page')) {
        const params = Object.fromEntries(new URLSearchParams(request.body))
        expect(params).toMatchObject({
          BDUSS: 'private-follower-bduss',
          uid: '42',
          pn: '1'
        })
        expect(params.sign).toBe(signClientParams(params))
        return {
          status: 200,
          body: JSON.stringify({
            error_code: '0',
            user_list: [
              {
                id: '90001',
                portrait: 'tb.1.follower',
                name: 'legacy-name',
                name_show: '手机端粉丝'
              }
            ],
            page: { has_more: '0' }
          })
        }
      }
      if (request.url.includes('/c/c/user/removeFans')) {
        const params = Object.fromEntries(new URLSearchParams(request.body))
        expect(params).toMatchObject({
          BDUSS: 'private-follower-bduss',
          fans_uid: '90001',
          tbs: 'fresh-test-tbs'
        })
        expect(params.sign).toBe(signClientParams(params))
        expect(request.body).not.toContain('add_black_list')
        return { status: 200, body: '{"error_code":"0"}' }
      }
      throw new Error(`unexpected request: ${request.url}`)
    })
    const engine = new CoreEngine({
      transport,
      now: fixedNow,
      logger: { log: (entry) => logs.push(entry) }
    })

    const result = await engine.query(
      { kind: 'follower', maxPages: 2 },
      { accountUid: '42', accountBduss: 'private-follower-bduss' }
    )
    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'follower:90001',
        title: '手机端粉丝',
        displayName: '手机端粉丝'
      })
    ])
    expect(JSON.stringify(result)).not.toContain('private-follower-bduss')

    const summary = await engine.execute(result.previewId, ['follower:90001'], {
      accountBduss: 'private-follower-bduss'
    })
    expect(summary).toMatchObject({ status: 'completed', succeeded: 1, failed: 0 })
    expect(
      transport.requests.filter((request) => request.url.includes('/c/c/user/removeFans'))
    ).toHaveLength(1)
    expect(JSON.stringify(logs)).not.toContain('private-follower-bduss')
  })

  it('honors maxPages when legacy pages provide no reliable next marker', async () => {
    const transport = new MockTransport((request) => {
      const page = Number(new URL(request.url).searchParams.get('pn'))
      return { status: 200, body: replyPage(page) }
    })
    const engine = new CoreEngine({ transport, now: fixedNow })
    const result = await engine.query({ kind: 'reply', maxPages: 3 })

    expect(result).toMatchObject({ scannedPages: 3, stopReason: 'maxPages' })
    expect(result.items).toHaveLength(3)
    expect(
      transport.requests.map((request) => new URL(request.url).searchParams.get('pn'))
    ).toEqual(['1', '2', '3'])
  })

  it('enriches preview data from the personal-home feed but keeps legacy delete params', async () => {
    const transport = new MockTransport((request) => {
      if (request.url.includes('/i/i/my_reply')) {
        return { status: 200, body: replyPage(1) }
      }
      if (request.url.includes('/c/u/feed/myThread')) {
        return {
          status: 200,
          body: JSON.stringify({
            error_code: 0,
            data: {
              has_more: 0,
              list: [
                {
                  type: 2,
                  thread_info: {
                    id: '80001',
                    title: '原帖标题',
                    forum_info: { id: '101', name: '摄影吧' },
                    post_info: {
                      id: '90001',
                      time: '2024-06-25',
                      content: [{ type: 0, text: '从个人主页取得的回复正文' }],
                      author: { name_show: '测试账号', portrait: 'tb.1.test-portrait' }
                    }
                  }
                }
              ]
            }
          })
        }
      }
      if (request.method === 'POST') return { status: 200, body: '{"err_code":0}' }
      throw new Error(`unexpected request: ${request.url}`)
    })
    const engine = new CoreEngine({ transport, now: fixedNow })
    const preview = await engine.query(
      { kind: 'reply', maxPages: 1 },
      {
        accountUsername: '测试账号',
        accountDisplayName: '测试账号',
        accountAvatarUrl: 'https://himg.bdimg.com/sys/portrait/item/fallback.jpg'
      }
    )

    expect(preview.items[0]).toMatchObject({
      id: 'reply:80001:90001',
      title: '从个人主页取得的回复正文',
      summary: '原帖：原帖标题',
      displayName: '测试账号',
      forumName: '摄影',
      timeLabel: '2024-06-25',
      timeKnown: true,
      avatarUrl: 'https://himg.bdimg.com/sys/portrait/item/tb.1.test-portrait.jpg'
    })
    const feedRequest = transport.requests.find((request) =>
      request.url.includes('/c/u/feed/myThread')
    )
    expect(feedRequest?.method).toBe('GET')
    expect(new URL(feedRequest!.url).searchParams.get('type')).toBe('2')
    expect(new URL(feedRequest!.url).searchParams.get('un')).toBe('测试账号')

    await engine.execute(preview.previewId, [preview.items[0].id])
    const deleteRequest = transport.requests.find((request) => request.method === 'POST')
    expect(deleteRequest?.body).toContain('tid=80001')
    expect(deleteRequest?.body).toContain('pid=90001')
  })

  it('uses the official personal feed when the legacy reply page is empty', async () => {
    const transport = new MockTransport((request) => {
      if (request.url.includes('/i/i/my_reply')) {
        return { status: 200, body: '<html><body><p>暂无回复</p></body></html>' }
      }
      if (request.url.includes('/c/u/feed/myThread')) {
        return {
          status: 200,
          body: JSON.stringify({
            error_code: 0,
            data: {
              has_more: 0,
              list: [
                {
                  type: 2,
                  thread_info: {
                    id: '81001',
                    title: '备用源原帖',
                    forum_info: { name: '测试吧' },
                    post_info: {
                      id: '91001',
                      time: 1_725_000_000,
                      content: [{ type: 0, text: '备用源回复正文' }],
                      author: { name_show: '真实昵称', portrait: 'tb.1.real-portrait' }
                    }
                  }
                }
              ]
            }
          })
        }
      }
      if (request.method === 'POST') return { status: 200, body: '{"err_code":0}' }
      throw new Error(`unexpected request: ${request.url}`)
    })
    const engine = new CoreEngine({ transport, now: fixedNow })
    const preview = await engine.query(
      { kind: 'reply', maxPages: 20 },
      {
        accountUsername: '百度贴吧用户',
        accountPortrait: 'tb.1.real-portrait',
        accountDisplayName: '真实昵称'
      }
    )

    expect(preview).toMatchObject({ scannedPages: 1, stopReason: 'completed' })
    expect(preview.items).toHaveLength(1)
    expect(preview.items[0]).toMatchObject({
      id: 'reply:81001:91001',
      title: '备用源回复正文',
      summary: '原帖：备用源原帖',
      displayName: '真实昵称',
      forumName: '测试',
      timeKnown: true
    })
    const feedRequest = transport.requests.find((request) =>
      request.url.includes('/c/u/feed/myThread')
    )
    expect(new URL(feedRequest!.url).searchParams.get('portrait')).toBe('tb.1.real-portrait')
    expect(new URL(feedRequest!.url).searchParams.get('un')).toBe('')

    await engine.execute(preview.previewId, [preview.items[0].id])
    const deleteRequest = transport.requests.find((request) => request.method === 'POST')
    expect(deleteRequest?.body).toContain('tid=81001')
    expect(deleteRequest?.body).toContain('pid=91001')
  })

  it('uses the public Protobuf client feed without exposing or sending its credential', async () => {
    const logs: TaskLogEntry[] = []
    const transport = new MockTransport((request) => {
      if (request.url.includes('/i/i/my_reply')) {
        return { status: 200, body: '<html><body><p>暂无回复</p></body></html>' }
      }
      if (request.url.includes('/c/u/feed/userpost')) {
        return {
          status: 200,
          body: '',
          bytes: userPostResponse()
        }
      }
      if (request.method === 'POST') return { status: 200, body: '{"err_code":0}' }
      throw new Error(`unexpected request: ${request.url}`)
    })
    const engine = new CoreEngine({
      transport,
      now: fixedNow,
      logger: { log: async (entry) => void logs.push(entry) }
    })
    const preview = await engine.query(
      { kind: 'reply', maxPages: 20 },
      {
        accountUid: '42',
        accountBduss: 'credential-must-stay-private',
        accountDisplayName: '本人昵称'
      }
    )

    expect(preview.items[0]).toMatchObject({
      id: 'reply:82001:92001',
      title: '客户端接口回复正文',
      summary: '原帖：客户端接口原帖',
      forumName: '客户端接口',
      displayName: '本人昵称',
      timeKnown: true
    })
    expect(preview.items[0].sourceUrl).toContain('pid=92001&cid=92001#92001')
    expect(JSON.stringify({ preview, logs })).not.toContain('credential-must-stay-private')
    const request = transport.requests.find((item) => item.url.includes('/c/u/feed/userpost'))
    expect(request).toMatchObject({
      responseType: 'binary',
      credentials: 'omit',
      headers: expect.objectContaining({
        x_bd_data_type: 'protobuf'
      })
    })
    expect(request?.url).toContain('cmd=303002')
    expect(request?.body).toBeInstanceOf(Uint8Array)
    const requestBody = new TextDecoder().decode(request?.body as Uint8Array)
    expect(requestBody).toContain('8.9.8.5')
    expect(requestBody).not.toContain('credential-must-stay-private')
  })

  it('distinguishes an officially hidden reply feed from a confirmed empty page', async () => {
    let clientRequestCount = 0
    const transport = new MockTransport((request) => {
      if (request.url.includes('/i/i/my_reply')) {
        return { status: 200, body: '<html><body><p>暂无回复</p></body></html>' }
      }
      if (request.url.includes('/c/u/feed/userpost')) {
        clientRequestCount += 1
        return {
          status: 200,
          body: '',
          bytes: userPostResponse({ hidden: true, includeGroup: false })
        }
      }
      throw new Error(`unexpected request: ${request.url}`)
    })
    const engine = new CoreEngine({ transport, now: fixedNow })
    const preview = await engine.query(
      { kind: 'reply', maxPages: 20 },
      { accountUid: '42', accountBduss: 'private' }
    )

    expect(preview).toMatchObject({ items: [], stopReason: 'sourceHidden' })
    expect(clientRequestCount).toBe(2)
  })

  it('retries the first hidden public feed page with the local account credential', async () => {
    const requestBodies: string[] = []
    const transport = new MockTransport((request) => {
      if (request.url.includes('/i/i/my_reply')) {
        return { status: 200, body: '<html><body><p>暂无回复</p></body></html>' }
      }
      if (request.url.includes('/c/u/feed/userpost')) {
        requestBodies.push(new TextDecoder().decode(request.body as Uint8Array))
        return requestBodies.length === 1
          ? {
              status: 200,
              body: '',
              bytes: userPostResponse({ hidden: true, includeGroup: false })
            }
          : { status: 200, body: '', bytes: userPostResponse() }
      }
      throw new Error(`unexpected request: ${request.url}`)
    })
    const engine = new CoreEngine({ transport, now: fixedNow })
    const preview = await engine.query(
      { kind: 'reply', maxPages: 1 },
      { accountUid: '42', accountBduss: 'private-retry-bduss' }
    )

    expect(preview.items).toHaveLength(1)
    expect(requestBodies[0]).not.toContain('private-retry-bduss')
    expect(requestBodies[1]).toContain('private-retry-bduss')
    expect(requestBodies[1]).toContain('22.6.5.1')
  })

  it('keeps legacy results when personal-home metadata is unavailable', async () => {
    const transport = new MockTransport((request) => {
      if (request.url.includes('/i/i/my_reply')) return { status: 200, body: replyPage(1) }
      if (request.url.includes('/c/u/feed/myThread')) {
        return { status: 200, body: '{"error_code":110001,"error_msg":"failed"}' }
      }
      throw new Error(`unexpected request: ${request.url}`)
    })
    const engine = new CoreEngine({ transport, now: fixedNow })
    const preview = await engine.query(
      { kind: 'reply', maxPages: 1 },
      {
        accountUsername: '测试账号',
        accountDisplayName: '测试账号',
        accountAvatarUrl: 'https://himg.bdimg.com/sys/portrait/item/fallback.jpg'
      }
    )

    expect(preview.items[0]).toMatchObject({
      id: 'reply:80001:90001',
      title: '第 1 页回复',
      displayName: '测试账号',
      avatarUrl: 'https://himg.bdimg.com/sys/portrait/item/fallback.jpg'
    })
  })

  it('stops when Tieba repeats a non-empty page for a later pn', async () => {
    const transport = new MockTransport(() => ({ status: 200, body: replyPage(1) }))
    const engine = new CoreEngine({ transport, now: fixedNow })
    const result = await engine.query({ kind: 'reply', maxPages: 20 })

    expect(result).toMatchObject({ scannedPages: 2, stopReason: 'completed' })
    expect(result.items).toHaveLength(1)
    expect(transport.requests).toHaveLength(2)
  })

  it('stops once an ordered content page is wholly older than start date', async () => {
    const transport = htmlTransport('post', fixture('post.html'))
    const engine = new CoreEngine({ transport, now: fixedNow })
    const result = await engine.query({ kind: 'post', startDate: '2026-09-10', maxPages: 100 })
    expect(result.stopReason).toBe('beforeStartDate')
    expect(result.scannedPages).toBe(1)
    expect(result.items).toEqual([])
    expect(transport.requests).toHaveLength(1)
  })

  it('enforces the 1..100 max page range', async () => {
    const transport = htmlTransport('post', fixture('post.html'))
    const engine = new CoreEngine({ transport, now: fixedNow })
    await expect(engine.query({ kind: 'post', maxPages: 101 })).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    await expect(engine.query({ kind: 'post', maxPages: 0 })).rejects.toMatchObject({
      code: 'INVALID_INPUT'
    })
    expect(transport.requests).toHaveLength(0)
  })

  it('marks a redirected login page as expired authentication', async () => {
    const transport = new MockTransport(() => ({
      status: 200,
      url: 'https://passport.baidu.com/v2/?login',
      body: '<html>login</html>'
    }))
    const engine = new CoreEngine({ transport, now: fixedNow })
    await expect(engine.query({ kind: 'reply', maxPages: 1 })).rejects.toMatchObject({
      code: 'AUTH_EXPIRED'
    })
  })
})

describe('CoreEngine task runner', () => {
  it('submits each selected forum with its own params (list[0] regression)', async () => {
    const transport = new MockTransport((request) => {
      if (request.method !== 'POST') return { status: 200, body: fixture('following-forum.html') }
      return { status: 200, body: '{"no":0}' }
    })
    const sleep = vi.fn(async () => undefined)
    const engine = new CoreEngine({ transport, now: fixedNow, sleep })
    const preview = await engine.query({ kind: 'followingForum', maxPages: 1 })
    const summary = await engine.execute(
      preview.previewId,
      preview.items.map((item) => item.id)
    )

    const posts = transport.requests.filter((request) => request.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[0].body).toContain('fid=101')
    expect(posts[1].body).toContain('fid=202')
    expect(posts[0].body).toContain('tbs=fresh-test-tbs')
    expect(posts[0].body).toContain('fname=%25BF%25BC%25D1%25D0')
    expect(posts[0].headers).toMatchObject({
      Accept: 'application/json,text/plain,*/*',
      Origin: 'https://tieba.baidu.com',
      Referer: 'https://tieba.baidu.com/f/like/mylike',
      'X-Requested-With': 'XMLHttpRequest'
    })
    expect(transport.requests.filter((request) => request.operation === 'auth:tbs')).toHaveLength(2)
    expect(summary).toMatchObject({ status: 'completed', succeeded: 2, failed: 0, remaining: 0 })
    expect(sleep).toHaveBeenCalledWith(1200)
  })

  it('refreshes TBS and sends a reply deletion with same-site request headers', async () => {
    const transport = new MockTransport((request) => {
      if (request.method !== 'POST') return { status: 200, body: fixture('reply.html') }
      return { status: 200, body: '{"err_code":0}' }
    })
    const engine = new CoreEngine({ transport, now: fixedNow })
    const preview = await engine.query({ kind: 'reply', maxPages: 1 })
    const summary = await engine.execute(preview.previewId, [preview.items[0].id])

    const tbsRequest = transport.requests.find((request) => request.operation === 'auth:tbs')
    const post = transport.requests.find((request) => request.method === 'POST')
    expect(tbsRequest?.headers).toMatchObject({
      Referer: 'https://tieba.baidu.com/',
      'X-Requested-With': 'XMLHttpRequest'
    })
    expect(post).toMatchObject({
      url: 'https://tieba.baidu.com/f/commit/post/delete',
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: 'https://tieba.baidu.com',
        Referer: 'https://tieba.baidu.com/i/i/my_reply',
        'X-Requested-With': 'XMLHttpRequest'
      }
    })
    expect(post?.body).toContain('tid=10001')
    expect(post?.body).toContain('pid=30001')
    expect(post?.body).toContain('tbs=fresh-test-tbs')
    expect(summary).toMatchObject({ status: 'completed', succeeded: 1 })
  })

  it('stops before POST when the fresh TBS check is logged out', async () => {
    const transport = new MockTransport((request) => {
      if (request.operation === 'auth:tbs') {
        return { status: 200, body: '{"is_login":0,"tbs":"anonymous"}' }
      }
      return { status: 200, body: fixture('reply.html') }
    }, false)
    const engine = new CoreEngine({ transport, now: fixedNow })
    const preview = await engine.query({ kind: 'reply', maxPages: 1 })
    const summary = await engine.execute(preview.previewId, [preview.items[0].id])

    expect(summary).toMatchObject({ status: 'failed', succeeded: 0, failed: 1 })
    expect(summary.results[0]).toMatchObject({
      errorCode: 'AUTH_EXPIRED',
      message: '删除评论“上下文：这是第一条回复”失败：删除前的登录校验未通过，请重新登录'
    })
    expect(transport.requests.filter((request) => request.method === 'POST')).toHaveLength(0)
  })

  it('does not retry a destructive POST after a timeout', async () => {
    const transport = new MockTransport((request) => {
      if (request.method !== 'POST') return { status: 200, body: fixture('follower.html') }
      throw new Error('request timeout')
    })
    const engine = new CoreEngine({ transport, now: fixedNow })
    const preview = await engine.query({ kind: 'follower', maxPages: 1 })
    const summary = await engine.execute(preview.previewId, [preview.items[0].id], {
      accountBduss: 'test-bduss'
    })

    expect(transport.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    expect(summary).toMatchObject({ status: 'completed', succeeded: 0, failed: 1 })
    expect(summary.results[0]).toMatchObject({ status: 'failed', errorCode: 'NETWORK_TIMEOUT' })
  })

  it('recognizes error code 220034 and preserves remaining items', async () => {
    const transport = new MockTransport((request) => {
      if (request.method !== 'POST') return { status: 200, body: fixture('following-forum.html') }
      return { status: 200, body: '{"no":220034,"error":"limited"}' }
    })
    const engine = new CoreEngine({ transport, now: fixedNow })
    const preview = await engine.query({ kind: 'followingForum', maxPages: 1 })
    const summary = await engine.execute(
      preview.previewId,
      preview.items.map((item) => item.id),
      { intervalMs: 0 }
    )

    expect(summary).toMatchObject({ status: 'limited', completed: 1, failed: 1, remaining: 1 })
    expect(transport.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
  })

  it('stops after a destructive request is redirected to the login page', async () => {
    const transport = new MockTransport((request) => {
      if (request.method !== 'POST') return { status: 200, body: fixture('following-forum.html') }
      return {
        status: 200,
        url: 'https://passport.baidu.com/v2/?login',
        body: '<html><body>login</body></html>'
      }
    })
    const engine = new CoreEngine({ transport, now: fixedNow })
    const preview = await engine.query({ kind: 'followingForum', maxPages: 1 })
    const summary = await engine.execute(
      preview.previewId,
      preview.items.map((item) => item.id),
      { intervalMs: 0 }
    )

    expect(summary).toMatchObject({ status: 'failed', completed: 1, failed: 1, remaining: 1 })
    expect(summary.results[0]).toMatchObject({ errorCode: 'AUTH_EXPIRED' })
    expect(transport.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
  })

  it('recognizes a login HTML response without relying on the final URL', async () => {
    const transport = new MockTransport((request) => {
      if (request.method !== 'POST') return { status: 200, body: fixture('follower.html') }
      return { status: 200, body: '<html><div id="passport-login-pop">请登录</div></html>' }
    })
    const engine = new CoreEngine({ transport, now: fixedNow })
    const preview = await engine.query({ kind: 'follower', maxPages: 1 })
    const summary = await engine.execute(preview.previewId, [preview.items[0].id], {
      accountBduss: 'test-bduss'
    })

    expect(summary).toMatchObject({ status: 'failed', completed: 1, failed: 1 })
    expect(summary.results[0]).toMatchObject({ errorCode: 'AUTH_EXPIRED' })
  })

  it('cancels only between items', async () => {
    let cancelCurrentTask = (): void => undefined
    const transport = new MockTransport((request) => {
      if (request.method !== 'POST') return { status: 200, body: fixture('following-forum.html') }
      cancelCurrentTask()
      return { status: 200, body: '{"no":0}' }
    })
    const engine = new CoreEngine({ transport, now: fixedNow })
    cancelCurrentTask = () => {
      engine.cancel()
    }
    const preview = await engine.query({ kind: 'followingForum', maxPages: 1 })
    const summary = await engine.execute(
      preview.previewId,
      preview.items.map((item) => item.id),
      { intervalMs: 0 }
    )

    expect(summary).toMatchObject({ status: 'cancelled', completed: 1, succeeded: 1, remaining: 1 })
    expect(transport.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
  })

  it('allows only one destructive task at a time', async () => {
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const transport = new MockTransport(async (request) => {
      if (request.method !== 'POST') return { status: 200, body: fixture('follower.html') }
      await pending
      return { status: 200, body: '{"no":0}' }
    })
    const engine = new CoreEngine({ transport, now: fixedNow })
    const preview = await engine.query({ kind: 'follower', maxPages: 1 })
    const first = engine.execute(preview.previewId, [preview.items[0].id], {
      accountBduss: 'test-bduss'
    })
    await vi.waitFor(() => expect(engine.getActiveTask()?.status).toBe('running'))
    await expect(engine.execute(preview.previewId, [preview.items[0].id])).rejects.toMatchObject({
      code: 'BUSY'
    })
    release?.()
    await first
  })

  it('expires previews and rejects unknown selected IDs', async () => {
    let timestamp = new Date('2026-09-10T00:00:00.000Z')
    const engine = new CoreEngine({
      transport: htmlTransport('follower', fixture('follower.html')),
      now: () => new Date(timestamp),
      previewTtlMs: 100
    })
    const preview = await engine.query({ kind: 'follower', maxPages: 1 })
    await expect(engine.execute(preview.previewId, ['missing'])).rejects.toMatchObject({
      code: 'ITEM_NOT_FOUND'
    })
    timestamp = new Date(timestamp.getTime() + 101)
    await expect(engine.execute(preview.previewId, [preview.items[0].id])).rejects.toMatchObject({
      code: 'PREVIEW_EXPIRED'
    })
  })

  it('rejects a preview created by a different account', async () => {
    const engine = new CoreEngine({
      transport: htmlTransport('follower', fixture('follower.html')),
      now: fixedNow
    })
    const preview = await engine.query(
      { kind: 'follower', maxPages: 1 },
      { accountKey: 'uid-account-a' }
    )
    await expect(
      engine.execute(preview.previewId, [preview.items[0].id], { accountKey: 'uid-account-b' })
    ).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' })
  })

  it('can invalidate all previews after a session change', async () => {
    const engine = new CoreEngine({
      transport: htmlTransport('follower', fixture('follower.html')),
      now: fixedNow
    })
    const preview = await engine.query({ kind: 'follower', maxPages: 1 })
    engine.invalidatePreviews()
    await expect(engine.execute(preview.previewId, [preview.items[0].id])).rejects.toMatchObject({
      code: 'PREVIEW_EXPIRED'
    })
  })

  it('keeps task results correct and releases the runner when logging fails', async () => {
    const transport = new MockTransport((request) => {
      if (request.method !== 'POST') return { status: 200, body: fixture('follower.html') }
      return { status: 200, body: '{"error_code":0}' }
    })
    const engine = new CoreEngine({
      transport,
      now: fixedNow,
      logger: {
        log: async () => {
          throw new Error('disk full')
        }
      }
    })
    const preview = await engine.query({ kind: 'follower', maxPages: 1 })
    const summary = await engine.execute(preview.previewId, [preview.items[0].id], {
      accountBduss: 'test-bduss',
      onProgress: async () => {
        throw new Error('renderer gone')
      }
    })

    expect(summary).toMatchObject({ status: 'completed', succeeded: 1, failed: 0 })
    expect(engine.getActiveTask()).toBeNull()

    const second = await engine.execute(preview.previewId, [preview.items[0].id], {
      accountBduss: 'test-bduss'
    })
    expect(second.status).toBe('completed')
  })
})

describe('safe errors and logs', () => {
  it('redacts credentials and long tokens', () => {
    const text = redactLogText(`cookie=abc123; TBS:secret-value BDUSS=${'a'.repeat(60)}`)
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('secret-value')
    expect(text).not.toContain('a'.repeat(60))
  })

  it('serializes errors without their underlying cause', () => {
    const error = new CoreError('NETWORK_ERROR', undefined, { cause: new Error('Cookie=secret') })
    expect(JSON.stringify(error.serialize())).not.toContain('secret')
  })

  it('never includes private request fields in structured task logs', async () => {
    const logs: TaskLogEntry[] = []
    const transport = new MockTransport((request) => {
      if (request.method !== 'POST') return { status: 200, body: fixture('follower.html') }
      return { status: 200, body: '{"error_code":1,"error":"TBS=should-not-leak"}' }
    })
    const engine = new CoreEngine({
      transport,
      now: fixedNow,
      logger: { log: (entry) => logs.push(entry) }
    })
    const preview = await engine.query({ kind: 'follower', maxPages: 1 })
    await engine.execute(preview.previewId, [preview.items[0].id], {
      account: '测试账号',
      accountBduss: 'test-bduss'
    })
    expect(JSON.stringify(logs)).not.toContain('should-not-leak')
    expect(JSON.stringify(logs)).not.toContain('fans-tbs-1')
    expect(logs.find((entry) => entry.event === 'item.failed')).toMatchObject({
      account: '测试账号',
      itemId: 'follower:70001',
      targetUrl: 'https://tieba.baidu.com/home/main?un=%E7%B2%89%E4%B8%9D%E7%94%B2',
      message: expect.stringContaining('移除粉丝“粉丝甲”失败')
    })
  })
})

function replyPage(page: number): string {
  const tid = 80_000 + page
  const pid = 90_000 + page
  return `
    <div class="j_feed_li">
      <div class="title-tag-wraper"><a title="测试吧">测试吧</a></div>
      <div class="n_txt">第 ${page} 页回复</div>
      <span class="time">2026-09-0${page} 12:00</span>
      <a class="b_reply" href="/p/${tid}?pid=${pid}">回复</a>
    </div>
  `
}

function userPostResponse(options: { hidden?: boolean; includeGroup?: boolean } = {}): Uint8Array {
  const writer = new BinaryWriter()
  const data = writer.uint32(18).fork()
  if (options.hidden) data.uint32(16).int32(1)
  if (options.includeGroup !== false) {
    const group = data.uint32(10).fork()
    group.uint32(8).uint64('101')
    group.uint32(16).uint64('82001')
    group.uint32(24).uint64('82000')
    group.uint32(40).uint32(1_725_000_000)
    group.uint32(50).string('客户端接口吧')
    group.uint32(58).string('客户端接口原帖')
    group.uint32(82).string('客户端账号')
    group.uint32(154).string('tb.1.client-portrait')
    group.uint32(282).string('本人昵称')

    const content = group.uint32(66).fork()
    const text = content.uint32(10).fork()
    text.uint32(8).uint32(0)
    text.uint32(18).string('客户端接口回复正文')
    text.join()
    content.uint32(16).uint64('1725000000')
    content.uint32(24).uint64('1')
    content.uint32(32).uint64('92001')
    content.join()
    group.join()
  }
  data.join()
  return writer.finish()
}
