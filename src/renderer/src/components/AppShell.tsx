import type { PropsWithChildren, ReactNode } from 'react'
import { Avatar, Button, Layout, Menu, Tag, Tooltip } from 'antd'
import {
  BadgeInfo,
  CircleUserRound,
  Clock3,
  DoorOpen,
  Eraser,
  Home,
  Link2Off,
  Settings,
  ShieldCheck
} from 'lucide-react'
import type { AccountSummary, NavigationIntent } from '../types'

interface AppShellProps extends PropsWithChildren {
  activePage: string
  account: AccountSummary
  onNavigate: (intent: NavigationIntent) => void
  onExit: () => void
}

const menuItems = [
  { key: 'home', icon: <Home size={19} />, label: '主页' },
  { key: 'content', icon: <Eraser size={19} />, label: '内容清理' },
  { key: 'relations', icon: <Link2Off size={19} />, label: '关系清理' },
  { key: 'account', icon: <CircleUserRound size={19} />, label: '账号管理' },
  { key: 'tasks', icon: <Clock3 size={19} />, label: '任务记录' },
  { type: 'divider' as const },
  { key: 'settings', icon: <Settings size={19} />, label: '设置' },
  { key: 'about', icon: <BadgeInfo size={19} />, label: '关于' }
]

function AccountPill({
  account,
  onClick
}: {
  account: AccountSummary
  onClick: () => void
}): ReactNode {
  const name = account.displayName || account.username || '未登录'
  return (
    <button className="account-pill" type="button" onClick={onClick}>
      <Avatar size={36} src={account.avatarUrl} icon={<CircleUserRound size={22} />} />
      <span className="account-copy">
        <strong>{name}</strong>
        <span>{account.loggedIn ? '贴吧账号已连接' : '点击登录贴吧账号'}</span>
      </span>
      <Tag color={account.loggedIn ? 'success' : 'default'} bordered={false}>
        {account.loggedIn ? '在线' : '离线'}
      </Tag>
    </button>
  )
}

export default function AppShell({
  activePage,
  account,
  onNavigate,
  onExit,
  children
}: AppShellProps): React.JSX.Element {
  return (
    <Layout className="app-shell">
      <Layout.Sider width={218} theme="light" className="app-sidebar">
        <div className="brand" aria-label="贴吧清理助手">
          <span className="brand-mark">
            <ShieldCheck size={23} strokeWidth={2.25} />
          </span>
          <span className="brand-text">
            <strong>贴吧清理助手</strong>
            <small>安全管理你的内容</small>
          </span>
        </div>
        <Menu
          className="side-menu"
          mode="inline"
          selectedKeys={[activePage]}
          items={menuItems}
          onClick={({ key }) => onNavigate({ page: key })}
        />
        <Tooltip title="退出应用" placement="right">
          <Button
            className="exit-button"
            type="text"
            icon={<DoorOpen size={19} />}
            onClick={onExit}
          >
            退出
          </Button>
        </Tooltip>
      </Layout.Sider>
      <Layout className="workspace">
        <Layout.Header className="app-header">
          <div>
            <span className="eyebrow">LOCAL DESKTOP TOOL</span>
            <h1>贴吧清理助手</h1>
          </div>
          <AccountPill account={account} onClick={() => onNavigate({ page: 'account' })} />
        </Layout.Header>
        <Layout.Content className="app-content">
          <div className="content-scroll">{children}</div>
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
