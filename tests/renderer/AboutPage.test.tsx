/* @vitest-environment jsdom */

import React from 'react'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { App as AntApp } from 'antd'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AboutPage from '../../src/renderer/src/pages/AboutPage'

const apiMocks = vi.hoisted(() => ({
  info: vi.fn(),
  uninstall: vi.fn()
}))

vi.mock('../../src/renderer/src/api', () => ({
  tiebaClient: { app: apiMocks },
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
}))

beforeEach(() => {
  apiMocks.info.mockReset().mockResolvedValue({ version: '2.1.9', canUninstall: true })
  apiMocks.uninstall.mockReset().mockResolvedValue(undefined)
})

afterEach(() => cleanup())

describe('AboutPage', () => {
  it('显示真实版本并允许选择卸载时的数据处理方式', async () => {
    render(React.createElement(AntApp, null, React.createElement(AboutPage)))

    expect(await screen.findByText('版本 2.1.9')).toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: '卸载应用' }))

    expect(screen.getByRole('radio', { name: /保留用户数据/u })).toBeChecked()
    expect(screen.getByRole('radio', { name: /全部退出登录/u })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /清除全部数据/u })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /全部退出登录/u }))
    fireEvent.click(screen.getByRole('button', { name: '开始卸载' }))
    await waitFor(() => expect(apiMocks.uninstall).toHaveBeenCalledWith('logout'))
  })
})
