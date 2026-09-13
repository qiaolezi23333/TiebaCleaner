import { CoreError } from './errors'

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

export interface ParsedTime {
  timestamp: string | null
  timeLabel: string | null
  timeKnown: boolean
}

export interface DateRange {
  startMs: number | null
  endMs: number | null
}

function localDate(year: number, month: number, day: number, hour = 0, minute = 0): Date | null {
  const date = new Date(year, month - 1, day, hour, minute, 0, 0)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null
  }
  return date
}

export function parseFilterRange(startDate?: string, endDate?: string): DateRange {
  const parseBoundary = (input: string | undefined, endOfDay: boolean): number | null => {
    if (!input) return null
    const dateOnly = input.match(DATE_ONLY)
    if (dateOnly) {
      const value = localDate(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]))
      if (!value) throw new CoreError('INVALID_INPUT', `无效日期：${input}`)
      if (endOfDay) value.setHours(23, 59, 59, 999)
      return value.getTime()
    }
    const value = new Date(input)
    if (Number.isNaN(value.getTime())) throw new CoreError('INVALID_INPUT', `无效日期：${input}`)
    return value.getTime()
  }

  const range = {
    startMs: parseBoundary(startDate, false),
    endMs: parseBoundary(endDate, true)
  }
  if (range.startMs !== null && range.endMs !== null && range.startMs > range.endMs) {
    throw new CoreError('INVALID_INPUT', '开始日期不能晚于结束日期')
  }
  return range
}

/** Parses the date formats currently found on Tieba history pages. */
export function parseTiebaTime(raw: string | undefined, now = new Date()): ParsedTime {
  const label = raw?.replace(/\s+/g, ' ').trim() || null
  if (!label) return { timestamp: null, timeLabel: null, timeKnown: false }

  let value: Date | null = null
  let match = label.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{2}))?/)
  if (match) {
    value = localDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      Number(match[4] ?? 0),
      Number(match[5] ?? 0)
    )
  } else {
    match = label.match(/(?:今天|今日)\s*(\d{1,2}):(\d{2})/)
    if (match) {
      value = localDate(
        now.getFullYear(),
        now.getMonth() + 1,
        now.getDate(),
        Number(match[1]),
        Number(match[2])
      )
    } else {
      match = label.match(/昨天\s*(\d{1,2}):(\d{2})/)
      if (match) {
        value = localDate(
          now.getFullYear(),
          now.getMonth() + 1,
          now.getDate(),
          Number(match[1]),
          Number(match[2])
        )
        value?.setDate(value.getDate() - 1)
      } else {
        match = label.match(/(?:^|\s)(\d{1,2})[-/.月](\d{1,2})(?:日)?(?:\s+(\d{1,2}):(\d{2}))?/)
        if (match) {
          value = localDate(
            now.getFullYear(),
            Number(match[1]),
            Number(match[2]),
            Number(match[3] ?? 0),
            Number(match[4] ?? 0)
          )
          // Around New Year, a December item on a January page belongs to the previous year.
          if (value && value.getTime() > now.getTime() + 24 * 60 * 60 * 1000)
            value.setFullYear(value.getFullYear() - 1)
        }
      }
    }
  }

  if (!value || Number.isNaN(value.getTime())) {
    return { timestamp: null, timeLabel: label, timeKnown: false }
  }
  return { timestamp: value.toISOString(), timeLabel: label, timeKnown: true }
}
