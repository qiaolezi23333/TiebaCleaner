import { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Modal, Radio, Tag, Tooltip } from 'antd'
import { Database, LogOut, ShieldCheck, Trash2 } from 'lucide-react'
import { errorMessage, tiebaClient } from '../api'
import type { AppInfo, UninstallDataMode } from '../types'
import PageHeader from '../components/PageHeader'

const uninstallOptions: Array<{
  value: UninstallDataMode
  icon: React.ReactNode
  title: string
  description: string
}> = [
  {
    value: 'keep',
    icon: <Database size={18} />,
    title: '保留用户数据',
    description: '保留账号登录状态、设置和任务日志'
  },
  {
    value: 'logout',
    icon: <LogOut size={18} />,
    title: '全部退出登录',
    description: '清除所有账号登录状态，保留设置和任务日志'
  },
  {
    value: 'clear',
    icon: <Trash2 size={18} />,
    title: '清除全部数据',
    description: '退出所有账号，并删除设置和任务日志'
  }
]

export default function AboutPage(): React.JSX.Element {
  const { message } = App.useApp()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [loadingInfo, setLoadingInfo] = useState(true)
  const [uninstallOpen, setUninstallOpen] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)
  const [dataMode, setDataMode] = useState<UninstallDataMode>('keep')

  useEffect(() => {
    let mounted = true
    tiebaClient.app
      .info()
      .then((value) => {
        if (mounted) setInfo(value)
      })
      .catch((error) => {
        if (mounted) message.error(errorMessage(error))
      })
      .finally(() => {
        if (mounted) setLoadingInfo(false)
      })
    return () => {
      mounted = false
    }
  }, [message])

  const uninstall = async (): Promise<void> => {
    setUninstalling(true)
    try {
      await tiebaClient.app.uninstall(dataMode)
      message.loading({ content: '正在关闭应用并启动卸载…', duration: 0, key: 'uninstall' })
    } catch (error) {
      message.error(errorMessage(error))
      setUninstalling(false)
    }
  }

  const uninstallButton = (
    <Button
      danger
      icon={<Trash2 size={16} />}
      loading={loadingInfo}
      disabled={!loadingInfo && !info?.canUninstall}
      onClick={() => setUninstallOpen(true)}
    >
      卸载应用
    </Button>
  )

  return (
    <div className="page about-page">
      <PageHeader eyebrow="ABOUT" title="关于贴吧清理助手" />
      <Card className="about-card" bordered={false}>
        <div className="about-brand">
          <span className="about-logo">
            <ShieldCheck size={36} />
          </span>
          <div className="about-product">
            <h2>贴吧清理助手</h2>
            <p>Windows 10/11 x64 安装版</p>
          </div>
          <Tag className="about-version" color="blue" bordered={false}>
            版本 {info?.version || '—'}
          </Tag>
        </div>
        <div className="about-actions">
          <div>
            <strong>卸载</strong>
            <span>可选择是否保留本机账号登录状态和其他数据。</span>
          </div>
          {info?.canUninstall || loadingInfo ? (
            uninstallButton
          ) : (
            <Tooltip title="未检测到当前版本的 MSI 安装信息">{uninstallButton}</Tooltip>
          )}
        </div>
        <div className="about-footnote">
          <Tag bordered={false} icon={<ShieldCheck size={14} />}>
            本地安全工具
          </Tag>
          <p>仅用于管理自己的内容和关系。请遵守法律法规、百度贴吧协议与社区规则。</p>
        </div>
      </Card>

      <Modal
        open={uninstallOpen}
        title="卸载贴吧清理助手"
        width={560}
        okText="开始卸载"
        cancelText="取消"
        okButtonProps={{ danger: true, loading: uninstalling }}
        cancelButtonProps={{ disabled: uninstalling }}
        closable={!uninstalling}
        maskClosable={!uninstalling}
        onCancel={() => setUninstallOpen(false)}
        onOk={() => void uninstall()}
      >
        <Radio.Group
          className="uninstall-options"
          value={dataMode}
          onChange={(event) => setDataMode(event.target.value as UninstallDataMode)}
        >
          {uninstallOptions.map((option) => (
            <Radio key={option.value} value={option.value}>
              <span className="uninstall-option-icon">{option.icon}</span>
              <span className="uninstall-option-copy">
                <strong>{option.title}</strong>
                <span>{option.description}</span>
              </span>
            </Radio>
          ))}
        </Radio.Group>
        <Alert
          className="uninstall-alert"
          type="warning"
          showIcon
          title="卸载开始后应用会自动关闭，随后显示 Windows Installer 进度。"
        />
      </Modal>
    </div>
  )
}
