import { useState } from 'react'
import { Alert, App, Avatar, Button, Card, Empty, Modal, Space, Tag, Typography } from 'antd'
import { CircleUserRound, Cookie, LogIn, LogOut, RefreshCw, ShieldCheck } from 'lucide-react'
import dayjs from 'dayjs'
import { tiebaClient, errorMessage } from '../api'
import type { AccountState, CookieImportInput } from '../types'
import CookieImportModal from '../components/CookieImportModal'
import PageHeader from '../components/PageHeader'

interface AccountPageProps {
  accountState: AccountState
  onAccountStateChange: (state: AccountState) => void
}

export default function AccountPage({
  accountState,
  onAccountStateChange
}: AccountPageProps): React.JSX.Element {
  const { message } = App.useApp()
  const [cookieOpen, setCookieOpen] = useState(false)
  const [cookieTargetId, setCookieTargetId] = useState<string | undefined>()
  const [loading, setLoading] = useState<string | null>(null)

  const runAccountAction = async (
    key: string,
    action: () => Promise<AccountState>,
    successText: string,
    verifiedAccountId?: string
  ): Promise<void> => {
    setLoading(key)
    try {
      const result = await action()
      onAccountStateChange(result)
      const verifiedAccount = verifiedAccountId
        ? result.accounts.find((account) => account.accountId === verifiedAccountId)
        : undefined
      if (verifiedAccountId && !verifiedAccount?.loggedIn) {
        message.warning('该账号需要重新登录或更新 Cookie')
      } else {
        message.success(successText)
      }
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setLoading(null)
    }
  }

  const importCookie = async (input: CookieImportInput): Promise<void> => {
    setLoading('cookie')
    try {
      const result = await tiebaClient.account.importCookie(input)
      onAccountStateChange(result)
      const imported = input.accountId
        ? result.accounts.find((account) => account.accountId === input.accountId)
        : result.accounts.find(
            (account) =>
              !accountState.accounts.some((item) => item.accountId === account.accountId) &&
              account.loggedIn
          )
      if (imported?.loggedIn) {
        setCookieOpen(false)
        setCookieTargetId(undefined)
        message.success(input.accountId ? 'Cookie 已更新' : 'Cookie 账号已添加')
      } else {
        message.warning('未能验证 Cookie 登录状态')
      }
    } catch (error) {
      message.error(errorMessage(error))
      throw error
    } finally {
      setLoading(null)
    }
  }

  const removeAccount = (accountId: string, name: string): void => {
    Modal.confirm({
      title: `移除“${name}”？`,
      content: '这会清除该账号在本应用中的登录状态。',
      okText: '移除账号',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () =>
        runAccountAction(
          `logout:${accountId}`,
          () => tiebaClient.account.logout(accountId),
          '账号已移除'
        )
    })
  }

  const login = async (): Promise<void> => {
    setLoading('login')
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
      setLoading(null)
    }
  }

  return (
    <div className="page account-page">
      <PageHeader
        eyebrow="ACCOUNT"
        title="账号管理"
        extra={
          <Space>
            <Button
              type="primary"
              icon={<LogIn size={17} />}
              loading={loading === 'login'}
              onClick={() => void login()}
            >
              登录新账号
            </Button>
            <Button
              icon={<Cookie size={17} />}
              disabled={loading !== null}
              onClick={() => {
                setCookieTargetId(undefined)
                setCookieOpen(true)
              }}
            >
              导入 Cookie
            </Button>
          </Space>
        }
      />

      {loading === 'login' && (
        <Alert
          className="login-progress-alert"
          type="info"
          showIcon
          message="请在登录窗口完成验证"
        />
      )}

      {accountState.accounts.length ? (
        <div className="account-grid">
          {accountState.accounts.map((account) => {
            const selected = account.accountId === accountState.selectedAccountId
            const name = account.displayName || account.username || `账号 ${account.uid || ''}`
            return (
              <Card
                key={account.accountId}
                className={`account-list-card${selected ? ' selected' : ''}`}
                bordered={false}
              >
                <div className="account-card-main">
                  <div className="avatar-wrap">
                    <Avatar
                      size={62}
                      src={account.avatarUrl}
                      icon={<CircleUserRound size={31} />}
                    />
                    <span className={account.loggedIn ? 'status-dot online' : 'status-dot'} />
                  </div>
                  <div className="account-identity">
                    <div className="account-title-row">
                      <h3>{name}</h3>
                      {selected && (
                        <Tag color="blue" bordered={false}>
                          当前账号
                        </Tag>
                      )}
                      <Tag color={account.loggedIn ? 'success' : 'error'} bordered={false}>
                        {account.loggedIn ? '已登录' : '需重新登录'}
                      </Tag>
                    </div>
                    <Typography.Text type="secondary">
                      {account.uid ? `UID ${account.uid}` : account.username || '贴吧账号'}
                      {account.verifiedAt
                        ? ` · 验证于 ${dayjs(account.verifiedAt).format('MM-DD HH:mm')}`
                        : ''}
                    </Typography.Text>
                  </div>
                </div>
                <Space className="account-card-actions" wrap>
                  {!selected && (
                    <Button
                      type="primary"
                      ghost
                      loading={loading === `select:${account.accountId}`}
                      disabled={!account.loggedIn || loading !== null}
                      onClick={() =>
                        void runAccountAction(
                          `select:${account.accountId}`,
                          () => tiebaClient.account.select(account.accountId),
                          `已切换到 ${name}`
                        )
                      }
                    >
                      设为当前
                    </Button>
                  )}
                  <Button
                    icon={<LogIn size={15} />}
                    loading={loading === `login:${account.accountId}`}
                    disabled={loading !== null}
                    onClick={() =>
                      void runAccountAction(
                        `login:${account.accountId}`,
                        () => tiebaClient.account.openLogin(account.accountId),
                        '账号已重新登录',
                        account.accountId
                      )
                    }
                  >
                    重新登录
                  </Button>
                  <Button
                    icon={<RefreshCw size={15} />}
                    loading={loading === `verify:${account.accountId}`}
                    disabled={loading !== null}
                    onClick={() =>
                      void runAccountAction(
                        `verify:${account.accountId}`,
                        () => tiebaClient.account.verify(account.accountId),
                        '账号状态已更新',
                        account.accountId
                      )
                    }
                  >
                    验证
                  </Button>
                  <Button
                    icon={<Cookie size={15} />}
                    disabled={loading !== null}
                    onClick={() => {
                      setCookieTargetId(account.accountId)
                      setCookieOpen(true)
                    }}
                  >
                    更新 Cookie
                  </Button>
                  <Button
                    danger
                    icon={<LogOut size={15} />}
                    disabled={loading !== null}
                    onClick={() => removeAccount(account.accountId, name)}
                  >
                    移除
                  </Button>
                </Space>
              </Card>
            )
          })}
        </div>
      ) : (
        <Card className="account-empty-card" bordered={false}>
          <Empty description="还没有贴吧账号">
            <Button type="primary" icon={<LogIn size={16} />} onClick={() => void login()}>
              登录第一个账号
            </Button>
          </Empty>
        </Card>
      )}

      <Alert
        className="security-alert"
        type="info"
        showIcon
        icon={<ShieldCheck size={20} />}
        message="Cookie 等同于登录凭证，请勿发送给他人；任务执行前会再次确认。"
      />

      <CookieImportModal
        open={cookieOpen}
        busy={loading === 'cookie'}
        accountId={cookieTargetId}
        onCancel={() => {
          setCookieOpen(false)
          setCookieTargetId(undefined)
        }}
        onImport={importCookie}
      />
    </div>
  )
}
