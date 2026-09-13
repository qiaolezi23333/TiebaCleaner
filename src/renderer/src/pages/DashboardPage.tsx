import { useEffect, useState } from 'react'
import { Avatar, Button, Card, Col, Row, Statistic, Tag } from 'antd'
import {
  ArrowRight,
  CircleUserRound,
  Clock3,
  Eraser,
  Link2Off,
  ListChecks,
  LogIn,
  ShieldCheck
} from 'lucide-react'
import { tiebaClient } from '../api'
import type { AccountSummary, NavigationIntent, TaskLogEntry } from '../types'
import PageHeader from '../components/PageHeader'

interface DashboardProps {
  account: AccountSummary
  onNavigate: (intent: NavigationIntent) => void
}

export default function DashboardPage({ account, onNavigate }: DashboardProps): React.JSX.Element {
  const [logs, setLogs] = useState<TaskLogEntry[]>([])

  useEffect(() => {
    void tiebaClient.tasks
      .list()
      .then(setLogs)
      .catch(() => undefined)
  }, [])

  const successCount = logs.filter((item) => item.level === 'success').length
  const failedCount = logs.filter((item) => item.level === 'error').length

  return (
    <div className="page dashboard-page">
      <PageHeader
        eyebrow="OVERVIEW"
        title={`晚上好，${account.displayName || account.username || '欢迎使用'}`}
        extra={
          account.loggedIn ? (
            <Tag className="large-tag" color="success" icon={<ShieldCheck size={14} />}>
              账号已验证
            </Tag>
          ) : (
            <Button
              type="primary"
              icon={<LogIn size={17} />}
              onClick={() => onNavigate({ page: 'account' })}
            >
              登录贴吧
            </Button>
          )
        }
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={15}>
          <Card className="hero-card" bordered={false}>
            <div className="hero-copy">
              <span className="hero-icon">
                <ListChecks size={28} />
              </span>
              <div>
                <Tag bordered={false} color="blue">
                  三步完成清理
                </Tag>
                <h3>查找、预览、确认</h3>
                <p>按日期、关键词和贴吧筛选历史内容，只勾选你确认要处理的项目。</p>
              </div>
            </div>
            <div className="hero-actions">
              <Button
                type="primary"
                icon={<Eraser size={17} />}
                onClick={() => onNavigate({ page: 'content', kind: 'reply' })}
              >
                清理历史内容
              </Button>
              <Button
                icon={<Link2Off size={17} />}
                onClick={() => onNavigate({ page: 'relations', kind: 'followingUser' })}
              >
                管理关注关系
              </Button>
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={9}>
          <Card className="account-overview" bordered={false}>
            <div className="account-overview-top">
              <Avatar size={54} src={account.avatarUrl} icon={<CircleUserRound size={28} />} />
              <div>
                <strong>{account.displayName || account.username || '尚未登录'}</strong>
                <span>{account.uid ? `UID ${account.uid}` : '连接账号后即可开始查询'}</span>
              </div>
            </div>
            <Button type="link" onClick={() => onNavigate({ page: 'account' })}>
              {account.loggedIn ? '管理账号' : '前往登录'} <ArrowRight size={15} />
            </Button>
          </Card>
        </Col>
      </Row>

      <section className="section-block">
        <div className="section-heading">
          <div>
            <h3>任务概况</h3>
          </div>
          <Button type="text" onClick={() => onNavigate({ page: 'tasks' })}>
            查看任务记录 <ArrowRight size={15} />
          </Button>
        </div>
        <Row gutter={[16, 16]}>
          <Col xs={24} sm={8}>
            <Card className="stat-card" bordered={false}>
              <Statistic
                title="本机日志"
                value={logs.length}
                prefix={<Clock3 size={20} />}
                suffix="条"
              />
            </Card>
          </Col>
          <Col xs={24} sm={8}>
            <Card className="stat-card success" bordered={false}>
              <Statistic
                title="成功操作"
                value={successCount}
                prefix={<ShieldCheck size={20} />}
                suffix="条"
              />
            </Card>
          </Col>
          <Col xs={24} sm={8}>
            <Card className="stat-card warning" bordered={false}>
              <Statistic
                title="失败记录"
                value={failedCount}
                prefix={<ListChecks size={20} />}
                suffix="条"
              />
            </Card>
          </Col>
        </Row>
      </section>
    </div>
  )
}
