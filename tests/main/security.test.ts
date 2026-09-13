import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { BrowserWindow, Cookie, Session } from 'electron'
import { vi } from 'vitest'
import { AccountSession } from '../../src/main/account-session'
import { parseCookieHeader } from '../../src/main/cookie'
import { sanitizeForLog } from '../../src/main/storage'

describe('Cookie 导入解析', () => {
  it('接受 Cookie: 前缀、空格和包含等号的值', () => {
    expect(parseCookieHeader('Cookie: BAIDUID=abc; BDUSS=a=b=c; STOKEN=token')).toEqual([
      { name: 'BAIDUID', value: 'abc' },
      { name: 'BDUSS', value: 'a=b=c' },
      { name: 'STOKEN', value: 'token' }
    ])
  })

  it.each(['', 'not-a-cookie', 'BDUSS=value\nInjected=yes', '=value'])('%s 会被拒绝', (value) => {
    expect(() => parseCookieHeader(value)).toThrow()
  })

  it('允许合法的空 Cookie 值', () => {
    expect(parseCookieHeader('optional=')).toEqual([{ name: 'optional', value: '' }])
  })
})

describe('日志脱敏', () => {
  it('移除对象字段、Cookie 片段和长凭据', () => {
    const sanitized = sanitizeForLog({
      headers: { Cookie: 'BDUSS=secret' },
      message: `请求失败 tbs=abcdef ${'A'.repeat(60)}`
    })

    expect(JSON.stringify(sanitized)).not.toContain('secret')
    expect(JSON.stringify(sanitized)).not.toContain('abcdef')
    expect(JSON.stringify(sanitized)).not.toContain('A'.repeat(60))
  })
})

describe('账号会话', () => {
  it('公开资料缺少 UID 时仍向主进程提供直接移除所需的 BDUSS', async () => {
    const accountSession = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      cookies: {
        get: vi.fn(async () => [
          { name: 'BDUSS', value: 'private-credential', domain: '.baidu.com' } as Cookie
        ])
      }
    } as unknown as Session
    const account = new AccountSession(accountSession, undefined, 'account-without-uid', {
      accountId: 'account-without-uid',
      loggedIn: true,
      uid: null,
      username: null,
      displayName: '已登录用户',
      avatarUrl: null,
      verifiedAt: '2026-09-12T10:27:55.012Z'
    })

    await expect(account.getPrivateQueryCredential()).resolves.toEqual({
      uid: null,
      bduss: 'private-credential'
    })
  })

  it('公开资料缺少 UID 时通过贴吧客户端登录接口在本机补齐', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error_code: '0',
            user: { id: '123456789', name: 'client-name', portrait: 'tb.1.client' }
          }),
          { status: 200 }
        )
    )
    const accountSession = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      cookies: {
        get: vi.fn(async () => [
          { name: 'BDUSS', value: 'private-credential', domain: '.baidu.com' } as Cookie
        ])
      },
      fetch
    } as unknown as Session
    const account = new AccountSession(accountSession, undefined, 'account-without-uid', {
      accountId: 'account-without-uid',
      loggedIn: true,
      uid: null,
      username: null,
      displayName: '已登录用户',
      avatarUrl: null,
      verifiedAt: '2026-09-12T10:27:55.012Z'
    })

    await expect(account.getPrivateQueryCredential()).resolves.toEqual({
      uid: '123456789',
      bduss: 'private-credential'
    })
    const [url, request] = fetch.mock.calls[0]
    expect(url).toBe('https://tiebac.baidu.com/c/s/login')
    expect(request).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' })
    const params = new URLSearchParams(request?.body)
    expect(params.get('bdusstoken')).toBe('private-credential')
    expect(params.get('sign')).toMatch(/^[a-f0-9]{32}$/u)
  })

  it('把手动导入的 Cookie 写成可跨重启持久化的 Cookie', async () => {
    const set = vi.fn(async () => undefined)
    const flushStore = vi.fn(async () => undefined)
    const accountSession = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
      cookies: { set, flushStore },
      fetch: vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ is_login: 1, tbs: 'sensitive-tbs' }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ no: 0, data: { user_id: 1, user_name: 'tester' } }), {
            status: 200
          })
        )
    } as unknown as Session

    await new AccountSession(accountSession).importCookie('BDUSS=credential; optional=')

    expect(set).toHaveBeenCalledTimes(2)
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'BDUSS',
        httpOnly: true,
        expirationDate: expect.any(Number)
      })
    )
    const imported = set.mock.calls[0]?.[0]
    expect(imported?.expirationDate).toBeGreaterThan(Date.now() / 1_000 + 179 * 24 * 60 * 60)
    expect(flushStore).toHaveBeenCalledOnce()
  })

  it('资料接口暂时失败时保留上次验证成功的昵称和头像', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ is_login: 1, tbs: 'sensitive-tbs' }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response('temporary failure', { status: 503 }))
    const accountSession = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      cookies: {},
      fetch
    } as unknown as Session
    const account = new AccountSession(accountSession, undefined, 'saved-account', {
      accountId: 'saved-account',
      loggedIn: true,
      uid: '123',
      username: 'stable-user',
      displayName: '稳定昵称',
      avatarUrl: 'https://himg.bdimg.com/sys/portrait/item/tb.1.stable.jpg',
      portrait: 'tb.1.stable',
      verifiedAt: '2026-09-10T00:00:00.000Z'
    })

    const result = await account.verify()

    expect(result).toMatchObject({
      loggedIn: true,
      uid: '123',
      username: 'stable-user',
      displayName: '稳定昵称',
      avatarUrl: 'https://himg.bdimg.com/sys/portrait/item/tb.1.stable.jpg',
      portrait: 'tb.1.stable'
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('占位资料不会阻止现代官方资料接口修复昵称和头像', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ is_login: 1, tbs: 'sensitive-tbs' }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ no: 0, data: {} }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error_code: 0,
            data: {
              user: {
                id: '456',
                name: 'modern-user',
                name_show: '现代昵称',
                portrait: 'tb.1.modern-portrait'
              }
            }
          }),
          { status: 200 }
        )
      )
    const accountSession = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      cookies: {},
      fetch
    } as unknown as Session
    const account = new AccountSession(accountSession, undefined, 'saved-account', {
      accountId: 'saved-account',
      loggedIn: true,
      uid: null,
      username: null,
      displayName: '百度贴吧用户',
      avatarUrl: null,
      verifiedAt: '2026-09-10T00:00:00.000Z'
    })

    const result = await account.verify()

    expect(result).toMatchObject({
      loggedIn: true,
      uid: '456',
      username: 'modern-user',
      displayName: '现代昵称',
      portrait: 'tb.1.modern-portrait',
      avatarUrl: 'https://himg.bdimg.com/sys/portrait/item/tb.1.modern-portrait.jpg'
    })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('合并验证中的凭证事件，并强制关闭可能拦截普通关闭的远程窗口', async () => {
    let resolveAnonymous: (response: Response) => void = () => undefined
    const anonymousResponse = new Promise<Response>((resolve) => {
      resolveAnonymous = resolve
    })
    const flushStore = vi.fn(async () => undefined)
    const cookieStore = Object.assign(new EventEmitter(), {
      get: vi.fn(async () => []),
      set: vi.fn(async () => undefined),
      flushStore
    })
    const fetch = vi
      .fn()
      .mockReturnValueOnce(anonymousResponse)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ is_login: 1, tbs: 'sensitive-tbs' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ no: 0, data: { user_id: 1, user_name_show: '测试用户' } }), {
          status: 200
        })
      )
    const accountSession = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
      cookies: cookieStore,
      fetch
    } as unknown as Session

    const windowEvents = new EventEmitter()
    const webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn()
    })
    let destroyed = false
    const close = vi.fn()
    const destroy = vi.fn(() => {
      destroyed = true
      windowEvents.emit('closed')
    })
    const setTitle = vi.fn()
    const loginWindow = Object.assign(windowEvents, {
      webContents,
      setTitle,
      isDestroyed: () => destroyed,
      destroy,
      close,
      focus: vi.fn(),
      loadURL: vi.fn(async () => {
        queueMicrotask(() => webContents.emit('did-finish-load'))
      })
    }) as unknown as BrowserWindow
    const onStatus = vi.fn()
    const account = new AccountSession(accountSession, () => loginWindow)

    const completion = account.openLogin({} as BrowserWindow, onStatus)
    await expect.poll(() => fetch.mock.calls.length).toBe(1)

    cookieStore.emit(
      'changed',
      {},
      { name: 'BDUSS', value: 'credential', domain: '.baidu.com' } as Cookie,
      'explicit',
      false
    )
    expect(fetch).toHaveBeenCalledTimes(1)
    resolveAnonymous(
      new Response(JSON.stringify({ is_login: 0, tbs: 'anonymous-tbs' }), { status: 200 })
    )
    const result = await completion

    expect(result).toMatchObject({ loggedIn: true, displayName: '测试用户' })
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ loggedIn: true }))
    expect(destroy).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
    expect(cookieStore.listenerCount('changed')).toBe(0)
    expect(flushStore).toHaveBeenCalledOnce()
    expect(flushStore.mock.invocationCallOrder[0]).toBeLessThan(
      onStatus.mock.invocationCallOrder[0]!
    )
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://tieba.baidu.com/dc/common/tbs',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({
          Referer: 'https://tieba.baidu.com/',
          'X-Requested-With': 'XMLHttpRequest'
        })
      })
    )
  })

  it('手动关闭窗口时先中止旧轮询，再执行最后一次登录验证', async () => {
    let firstPollAborted = false
    let secondRequestStartedAfterAbort = false
    const fetch = vi.fn((_url: string, init?: RequestInit): Promise<Response> => {
      const callNumber = fetch.mock.calls.length
      if (callNumber === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              firstPollAborted = true
              reject(new DOMException('Aborted', 'AbortError'))
            },
            { once: true }
          )
        })
      }
      if (callNumber === 2) {
        secondRequestStartedAfterAbort = firstPollAborted
        return Promise.resolve(
          new Response(JSON.stringify({ is_login: 1, tbs: 'sensitive-tbs' }), { status: 200 })
        )
      }
      return Promise.resolve(
        new Response(JSON.stringify({ data: { user_id: 2, user_name_show: '关闭后验证' } }), {
          status: 200
        })
      )
    })
    const flushStore = vi.fn(async () => undefined)
    const cookieStore = Object.assign(new EventEmitter(), {
      get: vi.fn(async () => [
        { name: 'BDUSS', value: 'credential', domain: '.baidu.com' } as Cookie
      ]),
      set: vi.fn(async () => undefined),
      flushStore
    })
    const accountSession = {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      closeAllConnections: vi.fn(async () => undefined),
      cookies: cookieStore,
      fetch
    } as unknown as Session

    const windowEvents = new EventEmitter()
    const webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn()
    })
    let destroyed = false
    const destroy = vi.fn(() => {
      destroyed = true
      windowEvents.emit('closed')
    })
    const loginWindow = Object.assign(windowEvents, {
      webContents,
      setTitle: vi.fn(),
      isDestroyed: () => destroyed,
      destroy,
      close: vi.fn(),
      focus: vi.fn(),
      loadURL: vi.fn(async () => {
        queueMicrotask(() => webContents.emit('did-finish-load'))
      })
    }) as unknown as BrowserWindow
    const onStatus = vi.fn()
    const account = new AccountSession(accountSession, () => loginWindow)

    const completion = account.openLogin({} as BrowserWindow, onStatus)
    await expect.poll(() => fetch.mock.calls.length).toBe(1)
    destroyed = true
    windowEvents.emit('closed')
    const result = await completion

    expect(firstPollAborted).toBe(true)
    expect(secondRequestStartedAfterAbort).toBe(true)
    expect(result).toMatchObject({ loggedIn: true, displayName: '关闭后验证' })
    expect(onStatus).toHaveBeenCalledOnce()
    expect(flushStore).toHaveBeenCalledOnce()
    expect(destroy).not.toHaveBeenCalled()
    expect(cookieStore.listenerCount('changed')).toBe(0)
  })
})
