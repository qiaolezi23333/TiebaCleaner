import { useEffect, useMemo, useState } from 'react'
import type { TableColumnsType } from 'antd'
import {
  Alert,
  App,
  Avatar,
  Button,
  Card,
  DatePicker,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography
} from 'antd'
import {
  CircleStop,
  ExternalLink,
  ListFilter,
  Search,
  ShieldAlert,
  Trash2,
  UsersRound,
  X
} from 'lucide-react'
import dayjs from 'dayjs'
import { tiebaClient, errorMessage } from '../api'
import type {
  AccountState,
  CleanupItem,
  CleanupKind,
  PreviewResult,
  QueryFilter,
  TaskStatus
} from '../types'
import PageHeader from '../components/PageHeader'
import AccountSelector from '../components/AccountSelector'
import { useCleanupSession, type CleanupFilterDraft } from '../state/cleanup-session'

type CleanupGroup = 'content' | 'relations'

interface CleanupPageProps {
  group: CleanupGroup
  initialKind: CleanupKind
  accountState: AccountState
  onAccountStateChange: (state: AccountState) => void
  onKindChange: (kind: CleanupKind) => void
}

interface FilterFormValues extends CleanupFilterDraft {
  maxPages: number
}

const contentTabs = [
  { key: 'reply', label: '我的回复' },
  { key: 'post', label: '我的主题帖' }
]

const relationTabs = [
  { key: 'followingUser', label: '关注用户' },
  { key: 'followingForum', label: '关注贴吧' },
  { key: 'follower', label: '我的粉丝' }
]

const kindNames: Record<CleanupKind, string> = {
  reply: '回复',
  post: '主题帖',
  followingUser: '关注用户',
  followingForum: '关注贴吧',
  follower: '粉丝'
}

const actionNames: Record<CleanupKind, string> = {
  reply: '删除回复',
  post: '删除主题帖',
  followingUser: '取消关注',
  followingForum: '退出贴吧',
  follower: '移除粉丝'
}

const statusMeta: Record<string, { text: string; color: string }> = {
  pending: { text: '待处理', color: 'default' },
  succeeded: { text: '已成功', color: 'success' },
  failed: { text: '失败', color: 'error' },
  skipped: { text: '已跳过', color: 'warning' }
}

const terminalStatuses: TaskStatus[] = ['completed', 'limited', 'cancelled', 'failed']
const tablePageSizeOptions = [20, 50, 100, 200]

function formatReason(reason?: PreviewResult['stopReason']): string {
  const labels: Record<NonNullable<PreviewResult['stopReason']>, string> = {
    completed: '已扫描完成',
    emptyPage: '没有更多结果',
    sourceHidden: '官方接口未返回回复',
    beforeStartDate: '已到达开始日期',
    maxPages: '已达到页数上限',
    cancelled: '扫描已停止'
  }
  return reason ? labels[reason] : '已完成'
}

function statusLabel(status: TaskStatus): string {
  return {
    scanning: '正在扫描',
    ready: '等待执行',
    running: '正在执行',
    cancelling: '正在停止',
    completed: '执行完成',
    limited: '已触发平台限制',
    cancelled: '已停止',
    failed: '任务失败'
  }[status]
}

function formattedTimestamp(item: CleanupItem): string | null {
  if (!item.timeKnown || !item.timestamp) return null
  const value = dayjs(item.timestamp)
  return value.isValid() ? value.format('YYYY-MM-DD HH:mm') : item.timeLabel
}

function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'tieba.baidu.com'
      ? url.toString()
      : null
  } catch {
    return null
  }
}

export default function CleanupPage({
  group,
  initialKind,
  accountState,
  onAccountStateChange,
  onKindChange
}: CleanupPageProps): React.JSX.Element {
  const { message } = App.useApp()
  const [form] = Form.useForm<FilterFormValues>()
  const tabs = group === 'content' ? contentTabs : relationTabs
  const safeInitialKind = tabs.some((tab) => tab.key === initialKind) ? initialKind : tabs[0].key
  const kind = safeInitialKind as CleanupKind
  const selectedAccount =
    accountState.accounts.find(
      (candidate) => candidate.accountId === accountState.selectedAccountId
    ) || null
  const accountId = selectedAccount?.accountId || ''
  const [session, setSession, sessionKey] = useCleanupSession(accountId, kind)
  const [defaultMaxPages, setDefaultMaxPages] = useState(20)

  const {
    filterValues,
    preview,
    selectedIds,
    pageSize,
    currentPage,
    scanning,
    submitting,
    progress,
    liveLogs
  } = session

  const taskRunning =
    submitting || (progress ? ['running', 'cancelling'].includes(progress.status) : false)

  useEffect(() => {
    const offProgress = tiebaClient.events.onTaskEvent((event) =>
      setSession((current) => ({ ...current, progress: event }))
    )
    const offLog = tiebaClient.events.onLog((entry) => {
      setSession((current) => ({
        ...current,
        liveLogs: [...current.liveLogs.slice(-199), entry]
      }))
    })
    return () => {
      offProgress()
      offLog()
    }
  }, [setSession])

  useEffect(() => {
    tiebaClient.settings
      .get()
      .then((settings) => setDefaultMaxPages(settings.maxPages))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    form.setFieldsValue({
      dateRange: filterValues.dateRange ?? null,
      keyword: filterValues.keyword ?? '',
      forumName: filterValues.forumName ?? '',
      maxPages: filterValues.maxPages ?? defaultMaxPages
    })
  }, [
    defaultMaxPages,
    filterValues.dateRange,
    filterValues.forumName,
    filterValues.keyword,
    filterValues.maxPages,
    form,
    sessionKey
  ])

  const changeKind = (nextKind: CleanupKind): void => {
    onKindChange(nextKind)
  }

  const query = async (values: FilterFormValues): Promise<void> => {
    if (!selectedAccount?.loggedIn || !accountId) {
      message.warning('请选择已登录的贴吧账号')
      return
    }
    const filter: QueryFilter = {
      kind,
      keyword: values.keyword?.trim() || undefined,
      forumName: group === 'content' ? values.forumName?.trim() || undefined : undefined,
      startDate: values.dateRange?.[0]?.format('YYYY-MM-DD'),
      endDate: values.dateRange?.[1]?.format('YYYY-MM-DD'),
      maxPages: Math.min(100, Math.max(1, values.maxPages || 20))
    }
    setSession((current) => ({
      ...current,
      scanning: true,
      preview: null,
      selectedIds: [],
      currentPage: 1,
      progress: null
    }))
    try {
      const result = await tiebaClient.cleanup.query(accountId, filter)
      setSession((current) => ({
        ...current,
        preview: result,
        selectedIds: result.items
          .filter((item) => group === 'relations' || item.timeKnown)
          .map((item) => item.id),
        currentPage: 1
      }))
      if (result.items.length) message.success(`查询完成，共找到 ${result.items.length} 项`)
      else message.info('没有找到符合条件的项目')
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setSession((current) => ({ ...current, scanning: false }))
    }
  }

  const executeCleanup = async (
    selectedAccountId: string,
    previewId: string,
    itemIds: string[]
  ): Promise<void> => {
    setSession((current) => ({ ...current, submitting: true }))
    try {
      const result = await tiebaClient.cleanup.start(selectedAccountId, previewId, itemIds)
      const resultMap = new Map(result.results.map((item) => [item.itemId, item.status]))
      setSession((current) => ({
        ...current,
        progress: { ...result, currentItemId: null },
        selectedIds: itemIds.filter((itemId) => !resultMap.has(itemId)),
        preview: current.preview
          ? {
              ...current.preview,
              items: current.preview.items.map((item) => ({
                ...item,
                status: resultMap.get(item.id) || item.status
              }))
            }
          : null
      }))
      if (result.status === 'completed') {
        const onlyResult = result.results.length === 1 ? result.results[0] : null
        if (onlyResult?.status === 'failed') {
          message.error(onlyResult.message || '所选项目处理失败')
        } else {
          message.success(onlyResult?.message || `处理完成：成功 ${result.succeeded} 项`)
        }
      } else if (result.status === 'limited')
        message.warning(result.results.at(-1)?.message || '已触发平台限制，任务已停止')
      else if (result.status === 'cancelled') message.info('任务已停止')
      else message.error(result.results.at(-1)?.message || '任务未能完成，请查看日志')
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setSession((current) => ({ ...current, submitting: false }))
    }
  }

  const startCleanup = (): void => {
    if (!preview || !selectedIds.length || !accountId) return
    const selectedAccountId = accountId
    const previewId = preview.previewId
    const itemIds = selectedIds.map(String)
    const unknownCount = preview.items.filter(
      (item) => selectedIds.includes(item.id) && !item.timeKnown
    ).length
    Modal.confirm({
      title: `确认${actionNames[kind]} ${selectedIds.length} 项？`,
      width: 520,
      icon: <ShieldAlert className="confirm-icon" size={24} />,
      content: (
        <div className="confirm-copy">
          <p>此操作无法撤销。程序将逐项执行，并在遇到平台限制时立即停止。</p>
          {unknownCount > 0 && (
            <Alert
              type="warning"
              showIcon
              message={`已选中 ${unknownCount} 项时间未知的内容，请再次核对。`}
            />
          )}
        </div>
      ),
      okText: `确认${actionNames[kind]}`,
      cancelText: '返回检查',
      okButtonProps: { danger: true },
      onOk: () => void executeCleanup(selectedAccountId, previewId, itemIds)
    })
  }

  const selectAllContentResults = (): void => {
    if (!preview) return
    const selectableItems = preview.items.filter((item) => item.status === 'pending')
    const unknownCount = selectableItems.filter((item) => !item.timeKnown).length

    Modal.confirm({
      title: `全选全部 ${selectableItems.length} 项查询结果？`,
      width: 520,
      icon: <ShieldAlert className="confirm-icon" size={24} />,
      content: (
        <div className="confirm-copy">
          <p>这会覆盖当前选择，并选中本次查询中所有仍可处理的内容。</p>
          <Alert
            type="warning"
            showIcon
            message={
              unknownCount > 0
                ? `其中 ${unknownCount} 项时间未知，可能不在日期筛选范围内。`
                : '请确认你确实要选择全部查询结果。'
            }
            description="请先核对内容；后续删除操作无法撤销，执行前仍会再次确认。"
          />
        </div>
      ),
      okText: `确认全选 ${selectableItems.length} 项`,
      cancelText: '返回检查',
      okButtonProps: { danger: true },
      onOk: () =>
        setSession((current) => ({
          ...current,
          selectedIds: selectableItems.map((item) => item.id)
        }))
    })
  }

  const stopTask = async (): Promise<void> => {
    try {
      await tiebaClient.cleanup.stop()
      message.info('停止请求已发送，当前项目完成后将停止')
    } catch (error) {
      message.error(errorMessage(error))
    }
  }

  const columns = useMemo<TableColumnsType<CleanupItem>>(() => {
    const mainColumn = {
      title: group === 'content' ? '内容' : kind === 'followingForum' ? '贴吧' : '用户',
      key: 'content',
      width: group === 'content' ? 420 : 520,
      render: (_: unknown, item: CleanupItem) => (
        <div className="result-content-cell">
          {group === 'content' && (
            <Avatar size={38} src={item.avatarUrl}>
              {(item.displayName || '贴').slice(0, 1)}
            </Avatar>
          )}
          <div className="result-main">
            {group === 'content' && item.title ? (
              <Tooltip
                title={item.title}
                placement="topLeft"
                mouseEnterDelay={0.2}
                classNames={{ root: 'full-comment-tooltip' }}
              >
                <strong>{item.title}</strong>
              </Tooltip>
            ) : (
              <strong>{item.displayName || item.forumName || '未命名项目'}</strong>
            )}
            {item.summary && (
              <Tooltip title={item.summary} placement="topLeft">
                <span>{item.summary}</span>
              </Tooltip>
            )}
            {group === 'content' && item.displayName && (
              <span className="result-author">发布者：{item.displayName}</span>
            )}
          </div>
        </div>
      )
    }
    const cols: TableColumnsType<CleanupItem> = [mainColumn]
    if (group === 'content') {
      cols.push({
        title: '贴吧',
        dataIndex: 'forumName',
        width: 132,
        render: (value?: string) => (
          <Tooltip title={value} placement="topLeft">
            <span className="result-forum">{value || '—'}</span>
          </Tooltip>
        )
      })
      cols.push({
        title: '时间',
        key: 'time',
        width: 156,
        render: (_: unknown, item: CleanupItem) => {
          const label = formattedTimestamp(item)
          return label ? (
            <span className="result-time">{label}</span>
          ) : (
            <Tag color="warning" bordered={false}>
              时间未知
            </Tag>
          )
        }
      })
    }
    cols.push({
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: CleanupItem['status']) => {
        const meta = statusMeta[value] || statusMeta.pending
        return (
          <Tag color={meta.color} bordered={false}>
            {meta.text}
          </Tag>
        )
      }
    })
    cols.push({
      title: '',
      dataIndex: 'sourceUrl',
      width: 48,
      render: (value: string) => {
        const sourceUrl = safeSourceUrl(value)
        return sourceUrl ? (
          <Tooltip title="打开原页面">
            <Button
              type="text"
              size="small"
              aria-label="打开原页面"
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              icon={<ExternalLink size={16} />}
            />
          </Tooltip>
        ) : null
      }
    })
    return cols
  }, [group, kind])

  const percent = progress?.total ? Math.round((progress.completed / progress.total) * 100) : 0
  const latestOperationMessage =
    progress && terminalStatuses.includes(progress.status)
      ? [...liveLogs]
          .reverse()
          .find((entry) => ['item.succeeded', 'item.failed', 'task.limited'].includes(entry.event))
          ?.message
      : undefined

  return (
    <div className="page cleanup-page">
      <PageHeader
        eyebrow={group === 'content' ? 'CONTENT CLEANUP' : 'RELATION CLEANUP'}
        title={group === 'content' ? '内容清理' : '关系清理'}
      />

      {!selectedAccount?.loggedIn && (
        <Alert
          className="page-alert"
          type="warning"
          showIcon
          message="尚未登录贴吧账号"
          description="请从下方选择账号，或登录新的账号。"
        />
      )}

      <Card className="filter-card" bordered={false}>
        <AccountSelector
          accountState={accountState}
          disabled={taskRunning || scanning}
          onAccountStateChange={onAccountStateChange}
        />
        <Tabs activeKey={kind} items={tabs} onChange={(key) => changeKind(key as CleanupKind)} />
        <Form<FilterFormValues>
          form={form}
          className="filter-form"
          layout="vertical"
          initialValues={{ maxPages: 20 }}
          onValuesChange={(_changedValues, values) =>
            setSession((current) => ({ ...current, filterValues: values }))
          }
          onFinish={(values) => void query(values)}
        >
          {group === 'content' && (
            <Form.Item name="dateRange" label="发布日期">
              <DatePicker.RangePicker
                allowEmpty={[true, true]}
                placeholder={['开始日期', '结束日期']}
                disabledDate={(current) => current.isAfter(dayjs(), 'day')}
              />
            </Form.Item>
          )}
          <Form.Item name="keyword" label={group === 'content' ? '内容关键词' : '名称关键词'}>
            <Input allowClear prefix={<Search size={15} />} placeholder="留空表示不限" />
          </Form.Item>
          {group === 'content' && (
            <Form.Item name="forumName" label="贴吧名称">
              <Input allowClear placeholder="例如：摄影吧" />
            </Form.Item>
          )}
          <Form.Item name="maxPages" label="最多扫描">
            <InputNumber min={1} max={100} addonAfter="页" />
          </Form.Item>
          <Form.Item className="filter-submit">
            <Space>
              <Button
                type="primary"
                htmlType="submit"
                icon={<ListFilter size={17} />}
                loading={scanning}
                disabled={!selectedAccount?.loggedIn || taskRunning}
              >
                查询并预览
              </Button>
              <Button
                icon={<X size={16} />}
                onClick={() => {
                  form.resetFields()
                  form.setFieldValue('maxPages', defaultMaxPages)
                  setSession((current) => ({
                    ...current,
                    filterValues: { maxPages: defaultMaxPages },
                    preview: null,
                    selectedIds: [],
                    currentPage: 1,
                    progress: null
                  }))
                }}
              >
                重置
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>

      <Card
        className="table-card results-card"
        bordered={false}
        title={
          <div className="results-title">
            <span>{kindNames[kind]}查询结果</span>
            {preview && (
              <Typography.Text type="secondary">
                扫描 {preview.scannedPages} 页 · {formatReason(preview.stopReason)}
              </Typography.Text>
            )}
          </div>
        }
        extra={
          preview?.items.length ? (
            <Space wrap>
              <Button
                type="link"
                onClick={() =>
                  setSession((current) => ({
                    ...current,
                    selectedIds: preview.items
                      .filter(
                        (item) =>
                          item.status === 'pending' && (group === 'relations' || item.timeKnown)
                      )
                      .map((item) => item.id)
                  }))
                }
              >
                {group === 'content' ? '全选时间明确项' : '全选查询结果'}
              </Button>
              {group === 'content' && (
                <Button danger type="link" onClick={selectAllContentResults}>
                  全选全部查询结果
                </Button>
              )}
              <Button
                type="link"
                onClick={() => setSession((current) => ({ ...current, selectedIds: [] }))}
              >
                取消选择
              </Button>
              <Button
                danger
                type="primary"
                icon={group === 'content' ? <Trash2 size={16} /> : <UsersRound size={16} />}
                disabled={!selectedIds.length || taskRunning}
                onClick={startCleanup}
              >
                {actionNames[kind]}（{selectedIds.length}）
              </Button>
            </Space>
          ) : null
        }
      >
        <Table<CleanupItem>
          className="results-table"
          rowKey="id"
          dataSource={preview?.items || []}
          columns={columns}
          loading={scanning}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={preview ? '没有找到符合条件的项目' : '设置筛选条件后点击“查询并预览”'}
              />
            )
          }}
          rowSelection={{
            selectedRowKeys: selectedIds,
            preserveSelectedRowKeys: true,
            onChange: (keys) =>
              setSession((current) => ({
                ...current,
                selectedIds: keys.map(String)
              })),
            getCheckboxProps: (item) => ({
              disabled: item.status !== 'pending' || taskRunning,
              title:
                !item.timeKnown && group === 'content'
                  ? '该项目时间未知，请手动核对后选择'
                  : undefined
            })
          }}
          pagination={{
            pageSize,
            current: currentPage,
            pageSizeOptions: tablePageSizeOptions,
            showSizeChanger: true,
            onChange: (nextPage, nextPageSize) =>
              setSession((current) => ({
                ...current,
                currentPage: nextPageSize === current.pageSize ? nextPage : 1,
                pageSize: nextPageSize
              })),
            showTotal: (total) => `共 ${total} 项`
          }}
          tableLayout="fixed"
          scroll={{ x: group === 'content' ? 880 : 700 }}
        />
      </Card>

      {(progress || liveLogs.length > 0) && (
        <Card className="activity-card" bordered={false}>
          {progress && (
            <div className="progress-panel">
              <div className="progress-heading">
                <div>
                  <strong>{latestOperationMessage || statusLabel(progress.status)}</strong>
                  <span>
                    已处理 {progress.completed}/{progress.total} · 成功 {progress.succeeded} · 失败{' '}
                    {progress.failed}
                  </span>
                </div>
                {taskRunning && (
                  <Button danger icon={<CircleStop size={16} />} onClick={() => void stopTask()}>
                    停止任务
                  </Button>
                )}
              </div>
              <Progress
                percent={percent}
                status={
                  progress.status === 'failed'
                    ? 'exception'
                    : terminalStatuses.includes(progress.status)
                      ? 'success'
                      : 'active'
                }
              />
            </div>
          )}
          <div className="live-log-heading">
            <strong>运行日志</strong>
            <Button
              type="text"
              size="small"
              onClick={() => setSession((current) => ({ ...current, liveLogs: [] }))}
            >
              清空显示
            </Button>
          </div>
          <div className="live-log" role="log" aria-live="polite">
            {liveLogs.length ? (
              liveLogs.map((entry) => (
                <div key={entry.id} className={`log-row log-${entry.level}`}>
                  <span>{dayjs(entry.timestamp).format('HH:mm:ss')}</span>
                  <strong>{entry.level.toUpperCase()}</strong>
                  <p>{entry.message}</p>
                </div>
              ))
            ) : (
              <span className="log-empty">任务开始后，详细信息会显示在这里。</span>
            )}
          </div>
        </Card>
      )}
    </div>
  )
}
