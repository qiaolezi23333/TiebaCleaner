import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountState } from '../../src/shared/types'

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>(),
  quit: vi.fn()
}))

vi.mock('electron', () => ({
  app: { quit: electronMocks.quit },
  ipcMain: {
    removeHandler: vi.fn((channel: string) => electronMocks.handlers.delete(channel)),
    handle: vi.fn(
      (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) =>
        electronMocks.handlers.set(channel, handler)
    )
  }
}))

import { IPC_CHANNELS, registerIpcHandlers, type IpcResponse } from '../../src/main/ipc'
import { DEFAULT_SETTINGS } from '../../src/main/storage'

const accountId = '11111111-1111-4111-8111-111111111111'
const accountState: AccountState = {
  selectedAccountId: accountId,
  accounts: [
    {
      accountId,
      loggedIn: true,
      uid: '1',
      username: 'tester',
      displayName: '测试账号',
      avatarUrl: null,
      verifiedAt: '2026-09-11T00:00:00.000Z'
    }
  ]
}

function setup(): {
  invoke: (channel: string, input?: unknown) => Promise<IpcResponse<unknown>>
  accounts: Record<string, ReturnType<typeof vi.fn>>
  getEngine: ReturnType<typeof vi.fn>
  uninstallApp: ReturnType<typeof vi.fn>
} {
  const frame = { url: 'file:///app/index.html' }
  const webContents = {
    mainFrame: frame,
    send: vi.fn()
  }
  const mainWindow = {
    webContents,
    isDestroyed: () => false,
    on: vi.fn(),
    removeListener: vi.fn()
  }
  const account = {
    verify: vi.fn(async () => accountState.accounts[0]),
    getAccountKey: vi.fn(async () => 'private-fingerprint'),
    getPrivateQueryCredential: vi.fn(async () => ({ uid: '1', bduss: 'private-bduss' }))
  }
  const accounts = {
    getState: vi.fn(() => accountState),
    select: vi.fn(async () => accountState),
    openLogin: vi.fn(async () => accountState),
    importCookie: vi.fn(async () => accountState),
    verify: vi.fn(async () => accountState),
    logout: vi.fn(async () => accountState),
    applySettings: vi.fn(async () => undefined),
    getAccount: vi.fn(() => account)
  }
  const engine = {
    invalidatePreviews: vi.fn(),
    query: vi.fn(async () => ({ previewId: 'preview' })),
    execute: vi.fn(async () => ({ id: 'task' }))
  }
  const getEngine = vi.fn(() => engine)
  const uninstallApp = vi.fn(async () => undefined)
  registerIpcHandlers({
    mainWindow,
    accounts,
    getEngine,
    invalidateEngine: vi.fn(),
    settingsStore: { save: vi.fn(async (value) => value), clear: vi.fn(async () => undefined) },
    taskLogStore: {
      list: vi.fn(async () => []),
      clear: vi.fn(async () => undefined)
    },
    getSettings: () => DEFAULT_SETTINGS,
    setSettings: vi.fn(),
    getAppInfo: vi.fn(async () => ({ version: '2.1.9', canUninstall: true })),
    uninstallApp
  } as never)
  return {
    accounts,
    getEngine,
    uninstallApp,
    invoke: async (channel, input) => {
      const handler = electronMocks.handlers.get(channel)
      if (!handler) throw new Error(`missing IPC handler ${channel}`)
      return handler({ sender: webContents, senderFrame: frame }, input) as Promise<
        IpcResponse<unknown>
      >
    }
  }
}

describe('多账号 IPC 边界', () => {
  beforeEach(() => {
    electronMocks.handlers.clear()
    vi.clearAllMocks()
  })

  it('查询必须明确携带合法 accountId，并路由到对应引擎', async () => {
    const context = setup()
    const missing = await context.invoke(IPC_CHANNELS.cleanupQuery, {
      filter: { kind: 'reply', maxPages: 1 }
    })
    expect(missing).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(context.getEngine).not.toHaveBeenCalled()

    const response = await context.invoke(IPC_CHANNELS.cleanupQuery, {
      accountId,
      filter: { kind: 'reply', maxPages: 1 }
    })
    expect(response.ok).toBe(true)
    expect(context.accounts.getAccount).toHaveBeenCalledWith(accountId)
    expect(context.getEngine).toHaveBeenCalledWith(accountId)
  })

  it('执行粉丝移除时只在主进程向引擎提供当前账号 BDUSS', async () => {
    const context = setup()
    const response = await context.invoke(IPC_CHANNELS.cleanupStart, {
      accountId,
      previewId: '22222222-2222-4222-8222-222222222222',
      itemIds: ['follower:90001']
    })

    expect(response.ok).toBe(true)
    const engine = context.getEngine.mock.results[0].value
    expect(engine.execute).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      ['follower:90001'],
      expect.objectContaining({
        accountKey: 'private-fingerprint',
        accountBduss: 'private-bduss'
      })
    )
    expect(JSON.stringify(response)).not.toContain('private-bduss')
  })

  it('Cookie 导入只接受整段或字段表中的一种形式', async () => {
    const context = setup()
    const invalid = await context.invoke(IPC_CHANNELS.accountImportCookie, {
      rawCookie: 'BDUSS=secret',
      fields: [{ name: 'BDUSS', value: 'secret' }]
    })
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })

    const valid = await context.invoke(IPC_CHANNELS.accountImportCookie, {
      fields: [
        { name: 'BDUSS', value: 'opaque=value' },
        { name: 'STOKEN', value: 'another-value' }
      ]
    })
    expect(valid.ok).toBe(true)
    expect(context.accounts.importCookie).toHaveBeenCalledWith({
      fields: [
        { name: 'BDUSS', value: 'opaque=value' },
        { name: 'STOKEN', value: 'another-value' }
      ]
    })
    expect(JSON.stringify(valid)).not.toContain('opaque=value')
  })

  it('返回应用版本，并严格校验卸载数据选项', async () => {
    const context = setup()

    await expect(context.invoke(IPC_CHANNELS.appInfo)).resolves.toMatchObject({
      ok: true,
      data: { version: '2.1.9', canUninstall: true }
    })
    await expect(
      context.invoke(IPC_CHANNELS.appUninstall, { dataMode: 'unknown' })
    ).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } })
    expect(context.uninstallApp).not.toHaveBeenCalled()

    await expect(
      context.invoke(IPC_CHANNELS.appUninstall, { dataMode: 'clear' })
    ).resolves.toMatchObject({ ok: true })
    expect(context.uninstallApp).toHaveBeenCalledWith('clear')
  })
})
