/* @vitest-environment jsdom */

import React from 'react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { App as AntApp, Modal } from 'antd'
import AccountPage from '../../src/renderer/src/pages/AccountPage'
import type { AccountState } from '../../src/shared/types'

const apiMocks = vi.hoisted(() => ({
  openLogin: vi.fn(),
  importCookie: vi.fn(),
  verify: vi.fn(),
  logout: vi.fn(),
  select: vi.fn()
}))

vi.mock('../../src/renderer/src/api', () => ({
  tiebaClient: { account: apiMocks },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
}))

const accountState: AccountState = {
  selectedAccountId: 'account-1',
  accounts: [
    {
      accountId: 'account-1',
      loggedIn: true,
      uid: '10001',
      username: 'first',
      displayName: '第一个账号',
      avatarUrl: null,
      verifiedAt: '2026-09-11T00:00:00.000Z'
    },
    {
      accountId: 'account-2',
      loggedIn: true,
      uid: '10002',
      username: 'second',
      displayName: '第二个账号',
      avatarUrl: null,
      verifiedAt: '2026-09-11T01:00:00.000Z'
    }
  ]
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
  Object.values(apiMocks).forEach((mock) => mock.mockReset())
})

afterEach(() => {
  Modal.destroyAll()
  cleanup()
  document.body.replaceChildren()
})

describe('AccountPage 多账号管理', () => {
  it('展示多个账号并可切换当前账号', async () => {
    const nextState = { ...accountState, selectedAccountId: 'account-2' }
    apiMocks.select.mockResolvedValueOnce(nextState)
    const onChange = vi.fn()

    render(
      React.createElement(
        AntApp,
        null,
        React.createElement(AccountPage, {
          accountState,
          onAccountStateChange: onChange
        })
      )
    )

    expect(screen.getByText('第一个账号')).toBeInTheDocument()
    expect(screen.getByText('第二个账号')).toBeInTheDocument()
    expect(screen.getByText('当前账号')).toBeInTheDocument()

    const secondCard = screen.getByText('第二个账号').closest('.ant-card')
    expect(secondCard).not.toBeNull()
    fireEvent.click(within(secondCard as HTMLElement).getByRole('button', { name: '设为当前' }))

    await waitFor(() => expect(apiMocks.select).toHaveBeenCalledWith('account-2'))
    expect(onChange).toHaveBeenCalledWith(nextState)
  })

  it('可把整段 Cookie 解析成逐项表单后导入', async () => {
    apiMocks.importCookie.mockResolvedValueOnce({
      accounts: [
        ...accountState.accounts,
        {
          ...accountState.accounts[0],
          accountId: 'account-3',
          uid: '10003',
          username: 'third',
          displayName: '第三个账号'
        }
      ],
      selectedAccountId: 'account-3'
    })

    render(
      React.createElement(
        AntApp,
        null,
        React.createElement(AccountPage, {
          accountState,
          onAccountStateChange: vi.fn()
        })
      )
    )

    fireEvent.click(screen.getAllByRole('button', { name: '导入 Cookie' })[0])
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('完整 Cookie'), {
      target: { value: 'Cookie: BAIDUID=abc; BDUSS=secret=value; STOKEN=token123' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '解析并填表' }))

    expect(await within(dialog).findByText('已解析 3 项，可修改后导入')).toBeInTheDocument()
    const names = within(dialog).getAllByLabelText('Cookie 名称') as HTMLInputElement[]
    const values = within(dialog).getAllByLabelText('Cookie 值') as HTMLInputElement[]
    expect(names.map((input) => input.value)).toEqual(['BAIDUID', 'BDUSS', 'STOKEN'])
    expect(values.map((input) => input.value)).toEqual(['abc', 'secret=value', 'token123'])

    fireEvent.click(within(dialog).getByRole('button', { name: '导入并验证' }))
    await waitFor(() =>
      expect(apiMocks.importCookie).toHaveBeenCalledWith({
        accountId: undefined,
        fields: [
          { name: 'BAIDUID', value: 'abc' },
          { name: 'BDUSS', value: 'secret=value' },
          { name: 'STOKEN', value: 'token123' }
        ]
      })
    )
  })

  it('可直接提交整段 Cookie', async () => {
    apiMocks.importCookie.mockResolvedValueOnce(accountState)

    render(
      React.createElement(
        AntApp,
        null,
        React.createElement(AccountPage, {
          accountState,
          onAccountStateChange: vi.fn()
        })
      )
    )

    fireEvent.click(screen.getAllByRole('button', { name: '导入 Cookie' })[0])
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('完整 Cookie'), {
      target: { value: 'BAIDUID=abc; BDUSS=secret; STOKEN=token123' }
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '导入并验证' }))

    await waitFor(() =>
      expect(apiMocks.importCookie).toHaveBeenCalledWith({
        accountId: undefined,
        rawCookie: 'BAIDUID=abc; BDUSS=secret; STOKEN=token123'
      })
    )
  })

  it('导入失败时保留 Cookie 供用户修改后重试', async () => {
    apiMocks.importCookie.mockRejectedValueOnce(new Error('登录状态已失效'))

    render(
      React.createElement(
        AntApp,
        null,
        React.createElement(AccountPage, {
          accountState,
          onAccountStateChange: vi.fn()
        })
      )
    )

    fireEvent.click(screen.getAllByRole('button', { name: '导入 Cookie' })[0])
    const dialog = await screen.findByRole('dialog')
    const input = within(dialog).getByLabelText('完整 Cookie') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: 'BAIDUID=abc; BDUSS=expired' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '导入并验证' }))

    await waitFor(() => expect(apiMocks.importCookie).toHaveBeenCalledOnce())
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(input).toHaveValue('BAIDUID=abc; BDUSS=expired')
  })
})
