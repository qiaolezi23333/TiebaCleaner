import type { CoreErrorCode, SerializedCoreError } from '../../shared/types'

const SAFE_MESSAGES: Record<CoreErrorCode, string> = {
  AUTH_EXPIRED: '登录状态已失效，请重新登录',
  NETWORK_TIMEOUT: '请求超时，请检查网络或代理设置',
  NETWORK_ERROR: '网络请求失败',
  HTTP_ERROR: '贴吧服务返回异常状态',
  PARSE_FAILED: '页面结构发生变化，暂时无法解析',
  RATE_LIMIT: '已触发贴吧删除频率或每日上限',
  DELETE_FAILED: '操作未成功',
  INVALID_INPUT: '输入参数无效',
  BUSY: '已有清理任务正在运行',
  PREVIEW_EXPIRED: '预览已过期，请重新查询',
  ITEM_NOT_FOUND: '所选项目不在当前预览中',
  CANCELLED: '操作已停止'
}

export class CoreError extends Error {
  readonly name = 'CoreError'

  constructor(
    readonly code: CoreErrorCode,
    message = SAFE_MESSAGES[code],
    readonly options: { retryable?: boolean; status?: number; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause })
  }

  get retryable(): boolean {
    return this.options.retryable ?? false
  }

  get status(): number | undefined {
    return this.options.status
  }

  serialize(): SerializedCoreError {
    return {
      name: 'CoreError',
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.status === undefined ? {} : { status: this.status })
    }
  }
}

export function toCoreError(error: unknown): CoreError {
  if (error instanceof CoreError) return error

  if (error instanceof Error) {
    const text = `${error.name} ${error.message}`.toLowerCase()
    if (text.includes('timeout') || text.includes('timed out') || text.includes('abort')) {
      return new CoreError('NETWORK_TIMEOUT', undefined, { retryable: true, cause: error })
    }
    return new CoreError('NETWORK_ERROR', undefined, { retryable: true, cause: error })
  }

  return new CoreError('NETWORK_ERROR', undefined, { retryable: true, cause: error })
}

export function assertHttpOk(status: number): void {
  if (status >= 200 && status < 400) return
  if (status === 401 || status === 403) {
    throw new CoreError('AUTH_EXPIRED', undefined, { status })
  }
  throw new CoreError('HTTP_ERROR', undefined, { retryable: status >= 500, status })
}
