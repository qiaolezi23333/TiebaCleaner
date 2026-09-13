import { CoreError } from './core/errors'

export interface ParsedCookie {
  name: string
  value: string
}

export function parseCookieHeader(input: string): ParsedCookie[] {
  const raw = input.trim().replace(/^cookie\s*:\s*/i, '')
  if (!raw) throw new CoreError('INVALID_INPUT', '请输入 Cookie')
  if (raw.length > 65_536) throw new CoreError('INVALID_INPUT', 'Cookie 内容过长')
  if (/\r|\n/u.test(raw)) throw new CoreError('INVALID_INPUT', 'Cookie 必须是一整行')

  const result = raw.split(';').flatMap((part) => {
    const item = part.trim()
    if (!item) return []
    const separator = item.indexOf('=')
    if (separator <= 0) throw new CoreError('INVALID_INPUT', 'Cookie 格式不正确')
    const name = item.slice(0, separator).trim()
    const value = item.slice(separator + 1).trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) {
      throw new CoreError('INVALID_INPUT', `Cookie 名称不正确：${name.slice(0, 24)}`)
    }
    if (hasControlCharacter(value)) {
      throw new CoreError('INVALID_INPUT', `Cookie ${name} 的值不正确`)
    }
    return [{ name, value }]
  })

  if (result.length === 0) throw new CoreError('INVALID_INPUT', '没有解析到 Cookie')
  return result
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f
  })
}
