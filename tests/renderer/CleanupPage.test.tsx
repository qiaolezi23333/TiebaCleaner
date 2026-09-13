/* @vitest-environment jsdom */

import React, { useState, type ComponentProps } from 'react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntApp, Modal } from 'antd'
import CleanupPage from '../../src/renderer/src/pages/CleanupPage'
import { CleanupSessionProvider } from '../../src/renderer/src/state/CleanupSessionProvider'
import type {
  AccountState,
  AccountSummary,
  CleanupItem,
  PreviewResult
} from '../../src/shared/types'

const apiMocks = vi.hoisted(() => ({
  query: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  getSettings: vi.fn(),
  selectAccount: vi.fn(),
  openLogin: vi.fn(),
  importCookie: vi.fn()
}))

vi.mock('../../src/renderer/src/api', () => ({
  tiebaClient: {
    cleanup: {
      query: apiMocks.query,
      start: apiMocks.start,
      stop: apiMocks.stop
    },
    account: {
      select: apiMocks.selectAccount,
      openLogin: apiMocks.openLogin,
      importCookie: apiMocks.importCookie
    },
    settings: {
      get: apiMocks.getSettings
    },
    events: {
      onTaskEvent: () => () => undefined,
      onLog: () => () => undefined
    }
  },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
}))

const account: AccountSummary = {
  accountId: 'account-1',
  loggedIn: true,
  uid: '10001',
  username: 'tester',
  displayName: '测试账号',
  avatarUrl: null,
  verifiedAt: '2026-09-11T00:00:00.000Z'
}

const singleAccountState: AccountState = {
  accounts: [account],
  selectedAccountId: account.accountId
}

function SessionCleanupPage({
  group,
  initialKind,
  ...props
}: Omit<ComponentProps<typeof CleanupPage>, 'onKindChange'>): React.JSX.Element {
  const [kinds, setKinds] = useState<{
    content: CleanupItem['kind']
    relations: CleanupItem['kind']
  }>({
    content: group === 'content' ? initialKind : 'reply',
    relations: group === 'relations' ? initialKind : 'followingUser'
  })
  const kind = group === 'content' ? kinds.content : kinds.relations

  return (
    <CleanupSessionProvider>
      <CleanupPage
        {...props}
        group={group}
        initialKind={kind}
        onKindChange={(nextKind) =>
          setKinds((current) => ({
            ...current,
            [group]: nextKind
          }))
        }
      />
    </CleanupSessionProvider>
  )
}

function item(index: number, timeKnown: boolean): CleanupItem {
  return {
    id: `item-${index}`,
    kind: 'reply',
    title: `内容 ${index}`,
    summary: `摘要 ${index}`,
    forumName: '测试吧',
    timestamp: timeKnown ? '2026-09-10T20:00:00' : null,
    timeLabel: timeKnown ? '2026-09-10 20:00' : null,
    timeKnown,
    sourceUrl: `https://tieba.baidu.com/p/${index}`,
    status: 'pending'
  }
}

function preview(items: CleanupItem[]): PreviewResult {
  return {
    previewId: 'preview-1',
    kind: 'reply',
    scannedPages: 2,
    items,
    stopReason: 'completed',
    createdAt: '2026-09-11T00:00:00.000Z',
    expiresAt: '2026-09-11T00:30:00.000Z'
  }
}

async function renderQueryResult(result: PreviewResult): Promise<ReturnType<typeof render>> {
  apiMocks.query.mockResolvedValueOnce(result)
  const rendered = render(
    React.createElement(
      AntApp,
      null,
      React.createElement(SessionCleanupPage, {
        group: 'content',
        initialKind: 'reply',
        accountState: singleAccountState,
        onAccountStateChange: () => undefined
      })
    )
  )

  fireEvent.click(screen.getByRole('button', { name: '查询并预览' }))
  await waitFor(() => expect(apiMocks.query).toHaveBeenCalledTimes(1))
  await screen.findByText(result.items[0].title)
  return rendered
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  })
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    value: class ResizeObserver {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  })
})

beforeEach(() => {
  apiMocks.query.mockReset()
  apiMocks.start.mockReset()
  apiMocks.stop.mockReset()
  apiMocks.getSettings.mockReset().mockResolvedValue({ maxPages: 20 })
  apiMocks.selectAccount.mockReset()
  apiMocks.openLogin.mockReset()
  apiMocks.importCookie.mockReset()
})

afterEach(() => {
  Modal.destroyAll()
  cleanup()
  document.body.replaceChildren()
})

describe('CleanupPage 内容结果选择', () => {
  it('固定结果列宽，长回复不会把吧名和时间推到表格右侧', async () => {
    const longItem = {
      ...item(1, true),
      title: '这是一段很长的回复内容'.repeat(20),
      forumName: '一个名字很长的测试贴吧'
    }
    const rendered = await renderQueryResult(preview([longItem]))

    const table = rendered.container.querySelector('.results-table table')
    expect(table).toHaveStyle({ tableLayout: 'fixed' })
    expect(rendered.container.querySelector('.result-forum')).toHaveTextContent(longItem.forumName)
    expect(rendered.container.querySelector('.result-time')).toHaveTextContent('2026-09-10 20:00')

    fireEvent.mouseEnter(screen.getByText(longItem.title))
    await waitFor(() => {
      const tooltip = screen.getByRole('tooltip')
      expect(tooltip).toHaveTextContent(longItem.title)
      expect(tooltip.closest('.full-comment-tooltip')).not.toBeNull()
    })
  })

  it('查询页可从下拉框切换已登录账号并提供新增入口', async () => {
    const secondAccount: AccountSummary = {
      ...account,
      accountId: 'account-2',
      uid: '10002',
      username: 'tester-2',
      displayName: '第二个账号'
    }
    const state: AccountState = {
      accounts: [account, secondAccount],
      selectedAccountId: account.accountId
    }
    const nextState: AccountState = { ...state, selectedAccountId: secondAccount.accountId }
    apiMocks.selectAccount.mockResolvedValueOnce(nextState)
    const onChange = vi.fn()

    render(
      <AntApp>
        <SessionCleanupPage
          group="content"
          initialKind="reply"
          accountState={state}
          onAccountStateChange={onChange}
        />
      </AntApp>
    )

    fireEvent.mouseDown(screen.getByRole('combobox', { name: '查询账号' }))
    expect(await screen.findByRole('button', { name: '登录新账号' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '导入 Cookie' })).toBeInTheDocument()

    fireEvent.click(await screen.findByText('第二个账号'))
    await waitFor(() => expect(apiMocks.selectAccount).toHaveBeenCalledWith('account-2'))
    expect(onChange).toHaveBeenCalledWith(nextState)
  })

  it('空回复后按关注用户、关注贴吧、关注用户顺序查询不会串用类型', async () => {
    apiMocks.query.mockResolvedValue(preview([]))
    const rendered = render(
      React.createElement(
        AntApp,
        null,
        React.createElement(SessionCleanupPage, {
          group: 'content',
          initialKind: 'reply',
          accountState: singleAccountState,
          onAccountStateChange: () => undefined
        })
      )
    )

    fireEvent.change(screen.getByPlaceholderText('留空表示不限'), {
      target: { value: '只用于回复的关键词' }
    })
    fireEvent.click(screen.getByRole('button', { name: '查询并预览' }))
    await waitFor(() => expect(apiMocks.query).toHaveBeenCalledTimes(1))
    expect(apiMocks.query).toHaveBeenNthCalledWith(
      1,
      'account-1',
      expect.objectContaining({ kind: 'reply', keyword: '只用于回复的关键词' })
    )

    rendered.rerender(
      React.createElement(
        AntApp,
        null,
        React.createElement(SessionCleanupPage, {
          group: 'relations',
          initialKind: 'reply',
          accountState: singleAccountState,
          onAccountStateChange: () => undefined
        })
      )
    )

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: '关注用户' })).toHaveAttribute('aria-selected', 'true')
    )
    expect(screen.getByPlaceholderText('留空表示不限')).toHaveValue('')

    fireEvent.click(screen.getByRole('button', { name: '查询并预览' }))
    await waitFor(() => expect(apiMocks.query).toHaveBeenCalledTimes(2))
    expect(apiMocks.query).toHaveBeenNthCalledWith(
      2,
      'account-1',
      expect.objectContaining({ kind: 'followingUser', keyword: undefined })
    )

    fireEvent.click(screen.getByRole('tab', { name: '关注贴吧' }))
    fireEvent.click(screen.getByRole('button', { name: '查询并预览' }))
    await waitFor(() => expect(apiMocks.query).toHaveBeenCalledTimes(3))
    expect(apiMocks.query).toHaveBeenNthCalledWith(
      3,
      'account-1',
      expect.objectContaining({ kind: 'followingForum' })
    )

    fireEvent.click(screen.getByRole('tab', { name: '关注用户' }))
    fireEvent.click(screen.getByRole('button', { name: '查询并预览' }))
    await waitFor(() => expect(apiMocks.query).toHaveBeenCalledTimes(4))
    expect(apiMocks.query).toHaveBeenNthCalledWith(
      4,
      'account-1',
      expect.objectContaining({ kind: 'followingUser' })
    )
  })

  it('二次确认后全选全部查询结果，并明确提示时间未知风险', async () => {
    await renderQueryResult(preview([item(1, true), item(2, false)]))

    expect(screen.getByRole('button', { name: '删除回复（1）' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '全选全部查询结果' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByText('全选全部 2 项查询结果？')).not.toHaveLength(0)
    expect(
      within(dialog).getByText('其中 1 项时间未知，可能不在日期筛选范围内。')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除回复（1）' })).toBeEnabled()

    fireEvent.click(within(dialog).getByRole('button', { name: '确认全选 2 项' }))

    await waitFor(() => expect(screen.getByRole('button', { name: '删除回复（2）' })).toBeEnabled())
  })

  it('默认每页显示 20 条，并在翻页选择时保留之前页面的选择', async () => {
    const rendered = await renderQueryResult(
      preview(Array.from({ length: 21 }, (_, index) => item(index + 1, false)))
    )

    expect(screen.getByText('20 / page')).toBeInTheDocument()
    const firstRow = screen.getByText('内容 1').closest('tr')
    expect(firstRow).not.toBeNull()
    fireEvent.click(within(firstRow as HTMLTableRowElement).getByRole('checkbox'))

    const nextPageButton = rendered.container.querySelector<HTMLButtonElement>(
      '.ant-pagination-next button'
    )
    expect(nextPageButton).not.toBeNull()
    fireEvent.click(nextPageButton as HTMLButtonElement)
    await screen.findByText('内容 21')

    const lastRow = screen.getByText('内容 21').closest('tr')
    expect(lastRow).not.toBeNull()
    fireEvent.click(within(lastRow as HTMLTableRowElement).getByRole('checkbox'))

    const previousPageButton = rendered.container.querySelector<HTMLButtonElement>(
      '.ant-pagination-prev button'
    )
    expect(previousPageButton).not.toBeNull()
    fireEvent.click(previousPageButton as HTMLButtonElement)
    await screen.findByText('内容 1')

    expect(
      within(screen.getByText('内容 1').closest('tr') as HTMLTableRowElement).getByRole('checkbox')
    ).toBeChecked()
    expect(screen.getByRole('button', { name: '删除回复（2）' })).toBeEnabled()
  })

  it('提供 20、50、100、200 四种每页条数', async () => {
    const rendered = await renderQueryResult(
      preview(Array.from({ length: 21 }, (_, index) => item(index + 1, false)))
    )

    const sizeChanger = rendered.container
      .querySelector<HTMLInputElement>('[role="combobox"][aria-label="Page Size"]')
      ?.closest<HTMLElement>('.ant-select-content')
    expect(sizeChanger).not.toBeNull()
    fireEvent.mouseDown(sizeChanger as HTMLElement)

    for (const size of [20, 50, 100, 200]) {
      expect(await screen.findByRole('option', { name: `${size} / page` })).toBeInTheDocument()
    }

    fireEvent.click(screen.getByRole('option', { name: '50 / page' }))
    await waitFor(() => expect(screen.getByText('内容 21')).toBeInTheDocument())
  })

  it('在回复和主题帖页签之间切换时分别保留结果、筛选和选择', async () => {
    const replyPreview = preview([item(1, true)])
    const postPreview: PreviewResult = {
      ...preview([{ ...item(2, true), kind: 'post', title: '主题帖结果' }]),
      previewId: 'preview-post',
      kind: 'post'
    }
    apiMocks.query.mockResolvedValueOnce(replyPreview).mockResolvedValueOnce(postPreview)

    render(
      <AntApp>
        <SessionCleanupPage
          group="content"
          initialKind="reply"
          accountState={singleAccountState}
          onAccountStateChange={() => undefined}
        />
      </AntApp>
    )

    fireEvent.change(screen.getByPlaceholderText('留空表示不限'), {
      target: { value: '回复筛选词' }
    })
    fireEvent.click(screen.getByRole('button', { name: '查询并预览' }))
    await screen.findByText('内容 1')
    expect(screen.getByRole('button', { name: '删除回复（1）' })).toBeEnabled()

    fireEvent.click(screen.getByRole('tab', { name: '我的主题帖' }))
    await waitFor(() => expect(screen.queryByText('内容 1')).not.toBeInTheDocument())
    expect(screen.getByPlaceholderText('留空表示不限')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: '查询并预览' }))
    await screen.findByText('主题帖结果')

    fireEvent.click(screen.getByRole('tab', { name: '我的回复' }))
    expect(await screen.findByText('内容 1')).toBeInTheDocument()
    expect(screen.queryByText('主题帖结果')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('留空表示不限')).toHaveValue('回复筛选词')
    expect(screen.getByRole('button', { name: '删除回复（1）' })).toBeEnabled()
    expect(apiMocks.query).toHaveBeenCalledTimes(2)
  })

  it('切换到其他侧边栏再返回时恢复结果、筛选、分页条数和勾选', async () => {
    function SidebarHarness(): React.JSX.Element {
      const [visible, setVisible] = useState(true)
      return (
        <CleanupSessionProvider>
          <button type="button" onClick={() => setVisible((current) => !current)}>
            切换侧边栏
          </button>
          {visible && (
            <CleanupPage
              group="content"
              initialKind="reply"
              accountState={singleAccountState}
              onAccountStateChange={() => undefined}
              onKindChange={() => undefined}
            />
          )}
        </CleanupSessionProvider>
      )
    }

    apiMocks.query.mockResolvedValueOnce(
      preview(Array.from({ length: 21 }, (_, index) => item(index + 1, true)))
    )
    const rendered = render(
      <AntApp>
        <SidebarHarness />
      </AntApp>
    )

    fireEvent.change(screen.getByPlaceholderText('留空表示不限'), {
      target: { value: '需要恢复的筛选词' }
    })
    fireEvent.click(screen.getByRole('button', { name: '查询并预览' }))
    await screen.findByText('内容 1')

    const sizeChanger = rendered.container
      .querySelector<HTMLInputElement>('[role="combobox"][aria-label="Page Size"]')
      ?.closest<HTMLElement>('.ant-select-content')
    fireEvent.mouseDown(sizeChanger as HTMLElement)
    fireEvent.click(await screen.findByRole('option', { name: '50 / page' }))
    await screen.findByText('内容 21')

    fireEvent.click(screen.getByRole('button', { name: '切换侧边栏' }))
    expect(screen.queryByText('内容 1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '切换侧边栏' }))

    expect(await screen.findByText('内容 1')).toBeInTheDocument()
    expect(screen.getByText('内容 21')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('留空表示不限')).toHaveValue('需要恢复的筛选词')
    expect(screen.getByText('50 / page')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除回复（21）' })).toBeEnabled()
    expect(apiMocks.query).toHaveBeenCalledTimes(1)
  })
})
