import { useEffect, useState } from 'react'
import { Alert, App, Button, Card, Form, Input, InputNumber, Radio, Skeleton, Space } from 'antd'
import { RotateCcw, Save, ShieldCheck } from 'lucide-react'
import { tiebaClient, errorMessage } from '../api'
import type { AppSettings } from '../types'
import { DEFAULT_SETTINGS } from '../types'
import PageHeader from '../components/PageHeader'

export default function SettingsPage(): React.JSX.Element {
  const { message } = App.useApp()
  const [form] = Form.useForm<AppSettings>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const proxyMode = Form.useWatch('proxyMode', form)

  useEffect(() => {
    void tiebaClient.settings
      .get()
      .then((settings) => form.setFieldsValue(settings))
      .catch((error) => message.error(errorMessage(error)))
      .finally(() => setLoading(false))
  }, [form, message])

  const save = async (values: AppSettings): Promise<void> => {
    setSaving(true)
    try {
      const saved = await tiebaClient.settings.save(values)
      form.setFieldsValue(saved)
      message.success('设置已保存')
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const reset = (): void => {
    form.setFieldsValue(DEFAULT_SETTINGS)
    message.info('已恢复推荐值，点击保存后生效')
  }

  return (
    <div className="page settings-page">
      <PageHeader eyebrow="PREFERENCES" title="设置" />
      <Card className="form-card" bordered={false}>
        <Skeleton loading={loading} active paragraph={{ rows: 8 }}>
          <Form<AppSettings>
            form={form}
            layout="vertical"
            initialValues={DEFAULT_SETTINGS}
            requiredMark={false}
            onFinish={(values) => void save(values)}
          >
            <div className="form-section">
              <div className="form-section-title">
                <h3>网络连接</h3>
                <p>默认跟随 Windows 系统代理。</p>
              </div>
              <Form.Item name="proxyMode" label="代理模式">
                <Radio.Group optionType="button" buttonStyle="solid">
                  <Radio.Button value="system">跟随系统</Radio.Button>
                  <Radio.Button value="direct">直接连接</Radio.Button>
                  <Radio.Button value="manual">手动代理</Radio.Button>
                </Radio.Group>
              </Form.Item>
              {proxyMode === 'manual' && (
                <Form.Item
                  name="manualProxyUrl"
                  label="代理地址"
                  rules={[
                    { required: true, message: '请输入代理地址' },
                    {
                      pattern: /^(https?|socks5):\/\/[^\s]+$/i,
                      message: '请输入 http://、https:// 或 socks5:// 开头的地址'
                    }
                  ]}
                >
                  <Input placeholder="例如：http://proxy.example:7890" />
                </Form.Item>
              )}
              <Form.Item
                name="requestTimeoutMs"
                label="请求超时"
                extra="单次请求超过此时间后停止等待。"
                rules={[{ required: true }]}
              >
                <InputNumber min={5000} max={120000} step={1000} addonAfter="毫秒" />
              </Form.Item>
            </div>

            <div className="form-divider" />
            <div className="form-section">
              <div className="form-section-title">
                <h3>执行节奏</h3>
                <p>所有删除操作串行执行，同一时间只处理一项。</p>
              </div>
              <div className="settings-grid">
                <Form.Item name="scanIntervalMs" label="扫描请求间隔" rules={[{ required: true }]}>
                  <InputNumber min={100} max={10000} step={50} addonAfter="毫秒" />
                </Form.Item>
                <Form.Item
                  name="deleteIntervalMs"
                  label="删除操作间隔"
                  rules={[{ required: true }]}
                >
                  <InputNumber min={500} max={60000} step={100} addonAfter="毫秒" />
                </Form.Item>
                <Form.Item
                  name="maxPages"
                  label="默认扫描页数"
                  extra="最多允许扫描 100 页。"
                  rules={[{ required: true }]}
                >
                  <InputNumber min={1} max={100} addonAfter="页" />
                </Form.Item>
              </div>
            </div>

            <Alert
              type="info"
              showIcon
              icon={<ShieldCheck size={19} />}
              message="安全建议"
              description="建议保留 1200 毫秒或更长的删除间隔。删除请求超时后不会自动重试，以免重复操作。"
            />
            <Space className="form-actions">
              <Button type="primary" htmlType="submit" icon={<Save size={17} />} loading={saving}>
                保存设置
              </Button>
              <Button icon={<RotateCcw size={17} />} onClick={reset}>
                恢复推荐值
              </Button>
            </Space>
          </Form>
        </Skeleton>
      </Card>
    </div>
  )
}
