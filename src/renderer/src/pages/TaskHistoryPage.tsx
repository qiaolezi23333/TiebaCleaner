import { useCallback, useEffect, useState } from 'react'
import type { TableColumnsType } from 'antd'
import { App, Button, Card, Empty, Modal, Space, Table, Tag, Tooltip } from 'antd'
import { RefreshCw, Trash2 } from 'lucide-react'
import dayjs from 'dayjs'
import { tiebaClient, errorMessage } from '../api'
import type { CleanupKind, TaskLogEntry } from '../types'
import PageHeader from '../components/PageHeader'

const kindLabels: Record<CleanupKind, string> = {
  reply: '回复',
  post: '主题帖',
  followingUser: '关注用户',
  followingForum: '关注贴吧',
  follower: '粉丝'
}

const levelMeta = {
  info: { color: 'blue', text: '信息' },
  success: { color: 'success', text: '成功' },
  warning: { color: 'warning', text: '警告' },
  error: { color: 'error', text: '失败' }
} as const

export default function TaskHistoryPage(): React.JSX.Element {
  const { message } = App.useApp()
  const [items, setItems] = useState<TaskLogEntry[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setItems(await tiebaClient.tasks.list())
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    let mounted = true
    tiebaClient.tasks
      .list()
      .then((entries) => {
        if (mounted) setItems(entries)
      })
      .catch((error) => {
        if (mounted) message.error(errorMessage(error))
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    const unsubscribe = tiebaClient.events.onLog((entry) => {
      setItems((current) => [entry, ...current.filter((item) => item.id !== entry.id)])
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [message])

  const clear = (): void => {
    Modal.confirm({
      title: '清空全部任务日志？',
      content: '这不会恢复已删除的内容，清空后的日志无法找回。',
      okText: '清空日志',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        await tiebaClient.tasks.clear()
        setItems([])
        message.success('任务日志已清空')
      }
    })
  }

  const columns: TableColumnsType<TaskLogEntry> = [
    {
      title: '时间',
      dataIndex: 'timestamp',
      width: 172,
      render: (value: string) => dayjs(value).format('YYYY-MM-DD HH:mm:ss')
    },
    {
      title: '级别',
      dataIndex: 'level',
      width: 88,
      render: (value: TaskLogEntry['level']) => (
        <Tag color={levelMeta[value].color} bordered={false}>
          {levelMeta[value].text}
        </Tag>
      )
    },
    {
      title: '类型',
      dataIndex: 'kind',
      width: 110,
      render: (kind?: CleanupKind) => (kind ? kindLabels[kind] : '系统')
    },
    {
      title: '记录',
      dataIndex: 'message',
      ellipsis: { showTitle: false },
      render: (value: string) => (
        <Tooltip placement="topLeft" title={value}>
          <span>{value}</span>
        </Tooltip>
      )
    },
    {
      title: '项目',
      dataIndex: 'itemId',
      width: 126,
      ellipsis: true,
      render: (value?: string) => value || '—'
    }
  ]

  return (
    <div className="page task-page">
      <PageHeader
        eyebrow="HISTORY"
        title="任务记录"
        extra={
          <Space>
            <Button icon={<RefreshCw size={16} />} onClick={() => void load()}>
              刷新
            </Button>
            <Button danger icon={<Trash2 size={16} />} disabled={!items.length} onClick={clear}>
              清空日志
            </Button>
          </Space>
        }
      />
      <Card className="table-card" bordered={false}>
        <Table<TaskLogEntry>
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          locale={{ emptyText: <Empty description="还没有任务记录" /> }}
          pagination={{
            pageSize: 15,
            showSizeChanger: false,
            showTotal: (total) => `共 ${total} 条`
          }}
          scroll={{ x: 800 }}
        />
      </Card>
    </div>
  )
}
