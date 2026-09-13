import { useMemo, useState } from 'react'
import { App, Avatar, Button, Divider, Select, Space, Typography } from 'antd'
import { CircleUserRound, Cookie, LogIn } from 'lucide-react'
import { errorMessage, tiebaClient } from '../api'
import type { AccountState, CookieImportInput } from '../types'
import CookieImportModal from './CookieImportModal'

interface AccountSelectorProps {
  accountState: AccountState
  disabled?: boolean
  onAccountStateChange: (state: AccountState) => void
}

export default function AccountSelector({
  accountState,
  disabled = false,
  onAccountStateChange
}: AccountSelectorProps): React.JSX.Element {
  const { message } = App.useApp()
  const [busy, setBusy] = useState<'select' | 'login' | 'cookie' | null>(null)
  const [cookieOpen, setCookieOpen] = useState(false)

  const options = useMemo(
    () =>
      accountState.accounts.map((account) => ({
        value: account.accountId,
        label: (
          <div className="account-select-option">
            <Avatar size={24} src={account.avatarUrl} icon={<CircleUserRound size={15} />} />
            <span>{account.displayName || account.username || `账号 ${account.uid || ''}`}</span>
            {!account.loggedIn && <Typography.Text type="danger">需登录</Typography.Text>}
          </div>
        ),
        searchText: `${account.displayName || ''} ${account.username || ''} ${account.uid || ''}`
      })),
    [accountState.accounts]
  )

  const select = async (accountId: string): Promise<void> => {
    setBusy('select')
    try {
      onAccountStateChange(await tiebaClient.account.select(accountId))
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const login = async (): Promise<void> => {
    setBusy('login')
    try {
      const result = await tiebaClient.account.openLogin()
      onAccountStateChange(result)
      const loggedInAccount = result.accounts.find((account) => {
        const before = accountState.accounts.find((item) => item.accountId === account.accountId)
        return (
          account.loggedIn &&
          (!before || !before.loggedIn || before.verifiedAt !== account.verifiedAt)
        )
      })
      if (loggedInAccount) message.success('账号已登录')
      else message.warning('未检测到新的登录账号')
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  const importCookie = async (input: CookieImportInput): Promise<void> => {
    setBusy('cookie')
    try {
      const result = await tiebaClient.account.importCookie(input)
      onAccountStateChange(result)
      const previousIds = new Set(accountState.accounts.map((account) => account.accountId))
      const imported = result.accounts.find(
        (account) => !previousIds.has(account.accountId) && account.loggedIn
      )
      if (imported) {
        setCookieOpen(false)
        message.success('Cookie 账号已添加')
      } else {
        message.warning('未能验证 Cookie 登录状态')
      }
    } catch (error) {
      message.error(errorMessage(error))
      throw error
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="query-account-selector">
        <Typography.Text strong>查询账号</Typography.Text>
        <Select
          className="query-account-select"
          aria-label="查询账号"
          value={accountState.selectedAccountId || undefined}
          options={options}
          placeholder="选择已登录账号"
          loading={busy === 'select'}
          disabled={disabled}
          optionLabelProp="label"
          optionFilterProp="searchText"
          showSearch
          onChange={(accountId) => void select(accountId)}
          popupRender={(menu) => (
            <div className="account-select-dropdown-footer">
              {menu}
              <Divider />
              <Space className="account-select-dropdown-actions">
                <Button
                  type="text"
                  block
                  icon={<LogIn size={15} />}
                  loading={busy === 'login'}
                  disabled={disabled}
                  onClick={() => void login()}
                >
                  登录新账号
                </Button>
                <Button
                  type="text"
                  block
                  icon={<Cookie size={15} />}
                  disabled={disabled}
                  onClick={() => setCookieOpen(true)}
                >
                  导入 Cookie
                </Button>
              </Space>
            </div>
          )}
        />
      </div>
      <CookieImportModal
        open={cookieOpen}
        busy={busy === 'cookie'}
        onCancel={() => setCookieOpen(false)}
        onImport={importCookie}
      />
    </>
  )
}
