import type { TaskLogEntry } from '../../shared/types'

export interface CoreLogger {
  log(entry: TaskLogEntry): void | Promise<void>
}

export const noopLogger: CoreLogger = { log: () => undefined }

const SENSITIVE_KEY_VALUE = /\b(cookie|bduss|stoken|tbs)\s*[:=]\s*[^\s;&,}]+/gi
const LONG_TOKEN = /\b[A-Za-z0-9_%+/=-]{48,}\b/g

/** Final defence before a core log crosses a process or persistence boundary. */
export function redactLogText(value: string): string {
  return value.replace(SENSITIVE_KEY_VALUE, '$1=[REDACTED]').replace(LONG_TOKEN, '[REDACTED]')
}
