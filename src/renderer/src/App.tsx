import { useCallback, useEffect, useState } from 'react'
import { App as AntApp, ConfigProvider, Modal, Spin, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import AppShell from './components/AppShell'
import AboutPage from './pages/AboutPage'
import AccountPage from './pages/AccountPage'
import CleanupPage from './pages/CleanupPage'
import DashboardPage from './pages/DashboardPage'
import SettingsPage from './pages/SettingsPage'
import TaskHistoryPage from './pages/TaskHistoryPage'
import { CleanupSessionProvider } from './state/CleanupSessionProvider'
import { tiebaClient } from './api'
import type { AccountState, CleanupKind, NavigationIntent } from './types'
import { EMPTY_ACCOUNT, EMPTY_ACCOUNT_STATE } from './types'

function AppContent(): React.JSX.Element {
  const [activePage, setActivePage] = useState('home')
  const [contentKind, setContentKind] = useState<CleanupKind>('reply')
  const [relationKind, setRelationKind] = useState<CleanupKind>('followingUser')
  const [accountState, setAccountState] = useState<AccountState>(EMPTY_ACCOUNT_STATE)
  const [loadingAccount, setLoadingAccount] = useState(true)

  useEffect(() => {
    let mounted = true
    tiebaClient.account
      .list()
      .then((result) => {
        if (mounted) setAccountState(result)
      })
      .catch(() => {
        if (mounted) setAccountState(EMPTY_ACCOUNT_STATE)
      })
      .finally(() => {
        if (mounted) setLoadingAccount(false)
      })
    return () => {
      mounted = false
    }
  }, [])

  const navigate = useCallback((intent: NavigationIntent): void => {
    if (intent.kind === 'reply' || intent.kind === 'post') setContentKind(intent.kind)
    else if (intent.kind) setRelationKind(intent.kind)
    setActivePage(intent.page)
  }, [])

  const account =
    accountState.accounts.find((item) => item.accountId === accountState.selectedAccountId) ||
    EMPTY_ACCOUNT

  const requestExit = (): void => {
    Modal.confirm({
      title: '退出贴吧清理助手？',
      content: '正在进行的任务将停止，尚未处理的项目不会被删除。',
      okText: '退出',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => tiebaClient.quit()
    })
  }

  let content: React.ReactNode
  if (activePage === 'content') {
    content = (
      <CleanupPage
        key="content-cleanup"
        group="content"
        initialKind={contentKind}
        accountState={accountState}
        onAccountStateChange={setAccountState}
        onKindChange={setContentKind}
      />
    )
  } else if (activePage === 'relations') {
    content = (
      <CleanupPage
        key="relations-cleanup"
        group="relations"
        initialKind={relationKind}
        accountState={accountState}
        onAccountStateChange={setAccountState}
        onKindChange={setRelationKind}
      />
    )
  } else if (activePage === 'account') {
    content = <AccountPage accountState={accountState} onAccountStateChange={setAccountState} />
  } else if (activePage === 'tasks') {
    content = <TaskHistoryPage />
  } else if (activePage === 'settings') {
    content = <SettingsPage />
  } else if (activePage === 'about') {
    content = <AboutPage />
  } else {
    content = <DashboardPage account={account} onNavigate={navigate} />
  }

  return (
    <AppShell activePage={activePage} account={account} onNavigate={navigate} onExit={requestExit}>
      <Spin spinning={loadingAccount} tip="正在检查账号状态">
        {content}
      </Spin>
    </AppShell>
  )
}

function App(): React.JSX.Element {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: theme.defaultAlgorithm,
        token: {
          colorPrimary: '#4f7bea',
          colorInfo: '#4f7bea',
          colorSuccess: '#1f9d73',
          colorWarning: '#e59b35',
          colorError: '#df5353',
          borderRadius: 10,
          colorBgLayout: '#f5f7fb',
          colorBorder: '#e2e7f0',
          fontFamily: '"Segoe UI", "Microsoft YaHei UI", sans-serif'
        },
        components: {
          Button: { controlHeight: 38, fontWeight: 600 },
          Card: { paddingLG: 22 },
          Menu: { itemBorderRadius: 10, itemHeight: 44 },
          Table: { headerBg: '#f7f9fc', headerColor: '#526076' }
        }
      }}
    >
      <AntApp>
        <CleanupSessionProvider>
          <AppContent />
        </CleanupSessionProvider>
      </AntApp>
    </ConfigProvider>
  )
}

export default App
