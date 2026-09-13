import type { Cookie, Session } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { AccountSessionManager } from '../../src/main/account-manager'
import { DEFAULT_SETTINGS, type StoredAccountRegistry } from '../../src/main/storage'

interface FakeSessionState {
  partition: string
  cookies: Map<string, Cookie>
}

function makeSessionFactory(initial: Record<string, string> = {}): {
  states: FakeSessionState[]
  createSession: (partition: string) => Session
} {
  const states: FakeSessionState[] = []
  return {
    states,
    createSession(partition) {
      const cookieValues = new Map<string, Cookie>()
      const preset = initial[partition]
      if (preset) {
        cookieValues.set('BDUSS', {
          name: 'BDUSS',
          value: preset,
          domain: '.baidu.com'
        } as Cookie)
      }
      const state = { partition, cookies: cookieValues }
      states.push(state)
      return {
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        setProxy: vi.fn(async () => undefined),
        closeAllConnections: vi.fn(async () => undefined),
        clearStorageData: vi.fn(async () => cookieValues.clear()),
        clearCache: vi.fn(async () => undefined),
        cookies: {
          get: vi.fn(async () => [...cookieValues.values()]),
          set: vi.fn(async (cookie: Cookie) => {
            cookieValues.set(cookie.name, cookie)
          }),
          flushStore: vi.fn(async () => undefined)
        },
        fetch: vi.fn(async (url: string) => {
          const credential = cookieValues.get('BDUSS')?.value
          if (url.includes('/dc/common/tbs')) {
            return new Response(
              JSON.stringify(
                credential ? { is_login: 1, tbs: `private-${credential}` } : { is_login: 0 }
              ),
              { status: 200 }
            )
          }
          return new Response(
            JSON.stringify({
              no: 0,
              data: {
                user_id: credential === 'first-secret' ? 1 : 2,
                user_name: credential === 'first-secret' ? 'first' : 'second',
                user_name_show: credential === 'first-secret' ? '账号一' : '账号二'
              }
            }),
            { status: 200 }
          )
        })
      } as unknown as Session
    }
  }
}

function makeStore(initial: StoredAccountRegistry = { accounts: [], selectedAccountId: null }): {
  saved: StoredAccountRegistry[]
  get: () => Promise<StoredAccountRegistry>
  save: (value: StoredAccountRegistry) => Promise<StoredAccountRegistry>
} {
  let value = structuredClone(initial)
  const saved: StoredAccountRegistry[] = []
  return {
    saved,
    get: vi.fn(async () => structuredClone(value)),
    save: vi.fn(async (next) => {
      value = structuredClone(next)
      saved.push(structuredClone(next))
      return next
    })
  }
}

describe('多账号会话管理', () => {
  it('为每个账号使用独立持久化 partition，注册表不保存凭据', async () => {
    const store = makeStore()
    const sessions = makeSessionFactory()
    const manager = new AccountSessionManager({ store, createSession: sessions.createSession })
    await manager.initialize(DEFAULT_SETTINGS)

    const first = await manager.importCookie({ rawCookie: 'BDUSS=first-secret' })
    const firstId = first.selectedAccountId!
    const second = await manager.importCookie({
      fields: [{ name: 'BDUSS', value: 'second-secret' }]
    })
    const secondId = second.selectedAccountId!

    expect(firstId).not.toBe(secondId)
    expect(second.accounts).toHaveLength(2)
    expect(second.accounts.map((account) => account.displayName)).toEqual(['账号一', '账号二'])
    expect(sessions.states.map(({ partition }) => partition)).toEqual([
      'persist:tieba-account',
      `persist:tieba-account-${firstId}`,
      `persist:tieba-account-${secondId}`
    ])
    expect(manager.getAccount(firstId).session).not.toBe(manager.getAccount(secondId).session)
    expect(await manager.getAccount(firstId).hasCredentials()).toBe(true)
    expect(await manager.getAccount(secondId).hasCredentials()).toBe(true)
    expect(JSON.stringify(store.saved)).not.toContain('first-secret')
    expect(JSON.stringify(store.saved)).not.toContain('second-secret')

    const selected = await manager.select(firstId)
    expect(selected.selectedAccountId).toBe(firstId)
  })

  it('首次升级会识别并保留旧版 persist:tieba-account 登录态', async () => {
    const store = makeStore()
    const sessions = makeSessionFactory({ 'persist:tieba-account': 'legacy-secret' })
    const manager = new AccountSessionManager({ store, createSession: sessions.createSession })

    const state = await manager.initialize(DEFAULT_SETTINGS)

    expect(state.selectedAccountId).toBe('legacy')
    expect(state.accounts).toEqual([
      expect.objectContaining({ accountId: 'legacy', loggedIn: true, displayName: '账号二' })
    ])
    expect(store.saved.at(-1)?.accounts[0]?.partition).toBe('persist:tieba-account')
    expect(JSON.stringify(store.saved)).not.toContain('legacy-secret')
  })

  it('启动时真实验证所选账号，不把过期的缓存状态继续显示为在线', async () => {
    const accountId = '11111111-1111-4111-8111-111111111111'
    const store = makeStore({
      selectedAccountId: accountId,
      accounts: [
        {
          accountId,
          partition: `persist:tieba-account-${accountId}`,
          summary: {
            accountId,
            loggedIn: true,
            uid: '1',
            username: 'expired',
            displayName: '已过期账号',
            avatarUrl: null,
            verifiedAt: '2026-09-10T00:00:00.000Z'
          }
        }
      ]
    })
    const sessions = makeSessionFactory()
    const manager = new AccountSessionManager({ store, createSession: sessions.createSession })

    const state = await manager.initialize(DEFAULT_SETTINGS)

    expect(state.accounts[0]).toMatchObject({ accountId, loggedIn: false, displayName: null })
    expect(store.saved.at(-1)?.accounts[0]?.summary.loggedIn).toBe(false)
  })

  it('重复添加同一贴吧 UID 时仍保持独立会话且不覆盖原账号', async () => {
    const store = makeStore()
    const sessions = makeSessionFactory()
    const manager = new AccountSessionManager({ store, createSession: sessions.createSession })
    await manager.initialize(DEFAULT_SETTINGS)

    const first = await manager.importCookie({ rawCookie: 'BDUSS=second-secret' })
    const firstId = first.selectedAccountId!
    const state = await manager.importCookie({ rawCookie: 'BDUSS=second-secret-copy' })

    expect(state.accounts).toHaveLength(2)
    expect(state.accounts.every(({ uid }) => uid === '2')).toBe(true)
    expect(state.accounts.map(({ accountId }) => accountId)).toContain(firstId)
    expect(new Set(state.accounts.map(({ accountId }) => accountId))).toHaveProperty('size', 2)
  })

  it('退出只清除指定账号，并自动选择剩余账号', async () => {
    const store = makeStore()
    const sessions = makeSessionFactory()
    const manager = new AccountSessionManager({ store, createSession: sessions.createSession })
    await manager.initialize(DEFAULT_SETTINGS)
    const firstId = (await manager.importCookie({ rawCookie: 'BDUSS=first-secret' }))
      .selectedAccountId!
    const secondId = (await manager.importCookie({ rawCookie: 'BDUSS=second-secret' }))
      .selectedAccountId!

    const state = await manager.logout(secondId)

    expect(state.accounts.map(({ accountId }) => accountId)).toEqual([firstId])
    expect(state.selectedAccountId).toBe(firstId)
    expect(await manager.getAccount(firstId).hasCredentials()).toBe(true)
    expect(() => manager.getAccount(secondId)).toThrow('所选账号不存在')
  })

  it('全部退出会清除所有隔离会话和账号注册记录', async () => {
    const store = makeStore()
    const sessions = makeSessionFactory()
    const manager = new AccountSessionManager({ store, createSession: sessions.createSession })
    await manager.initialize(DEFAULT_SETTINGS)
    await manager.importCookie({ rawCookie: 'BDUSS=first-secret' })
    await manager.importCookie({ rawCookie: 'BDUSS=second-secret' })

    const state = await manager.logoutAll()

    expect(state).toEqual({ accounts: [], selectedAccountId: null })
    expect(sessions.states.every(({ cookies }) => cookies.size === 0)).toBe(true)
    expect(store.saved.at(-1)).toEqual({ accounts: [], selectedAccountId: null })
  })
})
