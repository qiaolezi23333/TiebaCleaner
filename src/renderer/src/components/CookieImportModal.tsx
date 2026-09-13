import { useMemo, useState } from 'react'
import { Alert, App, Button, Form, Input, Modal, Space, Tabs, Typography } from 'antd'
import { Braces, Plus, Trash2 } from 'lucide-react'
import type { CookieFieldInput, CookieImportInput } from '../types'

interface CookieImportModalProps {
  open: boolean
  busy?: boolean
  accountId?: string
  onCancel: () => void
  onImport: (input: CookieImportInput) => Promise<void> | void
}

interface CookieFieldsForm {
  cookies: CookieFieldInput[]
}

const initialFields: CookieFieldInput[] = [
  { name: 'BAIDUID', value: '' },
  { name: 'BDUSS', value: '' },
  { name: 'STOKEN', value: '' }
]

function parseCookieHeader(rawCookie: string): CookieFieldInput[] {
  const normalized = rawCookie.trim().replace(/^cookie\s*:\s*/i, '')
  const values = new Map<string, string>()

  for (const segment of normalized.split(';')) {
    const separator = segment.indexOf('=')
    if (separator <= 0) continue
    const name = segment.slice(0, separator).trim()
    const value = segment.slice(separator + 1).trim()
    if (!name || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) continue
    values.set(name, value)
  }

  return [...values].map(([name, value]) => ({ name, value }))
}

export default function CookieImportModal({
  open,
  busy = false,
  accountId,
  onCancel,
  onImport
}: CookieImportModalProps): React.JSX.Element {
  const { message } = App.useApp()
  const [mode, setMode] = useState<'raw' | 'fields'>('raw')
  const [rawCookie, setRawCookie] = useState('')
  const [parsedCount, setParsedCount] = useState(0)
  const [form] = Form.useForm<CookieFieldsForm>()

  const reset = (): void => {
    setMode('raw')
    setRawCookie('')
    setParsedCount(0)
    form.setFieldsValue({ cookies: initialFields })
  }

  const tabItems = useMemo(
    () => [
      { key: 'raw', label: '粘贴整段' },
      { key: 'fields', label: '逐项填表' }
    ],
    []
  )

  const parseAndFill = (): void => {
    const fields = parseCookieHeader(rawCookie)
    if (!fields.length) {
      message.warning('没有解析到有效的 Cookie 键值')
      return
    }
    form.setFieldsValue({ cookies: fields })
    setParsedCount(fields.length)
    setMode('fields')
  }

  const submit = async (): Promise<void> => {
    if (mode === 'raw') {
      if (!parseCookieHeader(rawCookie).length) {
        message.warning('请粘贴完整 Cookie，格式为 name=value; name=value')
        return
      }
      try {
        await onImport({ accountId, rawCookie: rawCookie.trim() })
        reset()
      } catch {
        // The parent reports the validation/network error; keep the entered value for correction.
      }
      return
    }

    const values = await form.validateFields()
    const fields = values.cookies
      .map((field) => ({ name: field.name.trim(), value: field.value.trim() }))
      .filter((field) => field.name && field.value)
    if (!fields.length) {
      message.warning('请至少填写一项 Cookie')
      return
    }
    try {
      await onImport({ accountId, fields })
      reset()
    } catch {
      // Keep the form values so the user can correct and retry them.
    }
  }

  return (
    <Modal
      title={accountId ? '更新 Cookie' : '导入 Cookie 账号'}
      open={open}
      okText={accountId ? '更新并验证' : '导入并验证'}
      cancelText="取消"
      confirmLoading={busy}
      destroyOnHidden
      width={660}
      onOk={() => void submit()}
      onCancel={() => {
        reset()
        onCancel()
      }}
    >
      <Alert
        className="cookie-safety-alert"
        type="warning"
        showIcon
        message="Cookie 等同于登录凭证，请勿发送给他人。"
      />
      <Tabs
        className="cookie-mode-tabs"
        activeKey={mode}
        items={tabItems}
        onChange={(key) => setMode(key as 'raw' | 'fields')}
      />

      {mode === 'raw' ? (
        <>
          <Input.TextArea
            autoFocus
            rows={8}
            value={rawCookie}
            placeholder="BAIDUID=...; BDUSS=...; STOKEN=..."
            autoComplete="off"
            aria-label="完整 Cookie"
            onChange={(event) => setRawCookie(event.target.value)}
          />
          <div className="cookie-modal-actions">
            <Typography.Text type="secondary">可直接导入，也可先解析后检查每一项。</Typography.Text>
            <Button
              icon={<Braces size={16} />}
              disabled={!parseCookieHeader(rawCookie).length}
              onClick={parseAndFill}
            >
              解析并填表
            </Button>
          </div>
        </>
      ) : (
        <Form<CookieFieldsForm>
          form={form}
          initialValues={{ cookies: initialFields }}
          autoComplete="off"
        >
          {parsedCount > 0 && (
            <Typography.Text className="cookie-parsed-count" type="success">
              已解析 {parsedCount} 项，可修改后导入
            </Typography.Text>
          )}
          <Form.List name="cookies">
            {(fields, { add, remove }) => (
              <div className="cookie-field-list">
                {fields.map((field) => (
                  <Space key={field.key} className="cookie-field-row" align="start">
                    <Form.Item
                      {...field}
                      name={[field.name, 'name']}
                      rules={[
                        { required: true, message: '请输入名称' },
                        {
                          pattern: /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/,
                          message: 'Cookie 名称格式不正确'
                        }
                      ]}
                    >
                      <Input aria-label="Cookie 名称" placeholder="名称" spellCheck={false} />
                    </Form.Item>
                    <Form.Item
                      {...field}
                      name={[field.name, 'value']}
                      rules={[{ required: true, message: '请输入值' }]}
                    >
                      <Input.Password aria-label="Cookie 值" placeholder="值" />
                    </Form.Item>
                    <Button
                      type="text"
                      danger
                      aria-label="删除 Cookie 项"
                      icon={<Trash2 size={16} />}
                      onClick={() => remove(field.name)}
                    />
                  </Space>
                ))}
                <Button
                  type="dashed"
                  block
                  icon={<Plus size={16} />}
                  onClick={() => add({ name: '', value: '' })}
                >
                  添加 Cookie 项
                </Button>
              </div>
            )}
          </Form.List>
        </Form>
      )}
    </Modal>
  )
}
