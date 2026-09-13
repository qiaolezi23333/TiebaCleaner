import { createContext, useCallback, useContext, type Dispatch, type SetStateAction } from 'react'
import type { Dayjs } from 'dayjs'
import type {
  CleanupKind,
  CleanupProgress,
  PreviewResult,
  TaskLogEntry
} from '../../../shared/types'

export interface CleanupFilterDraft {
  dateRange?: [Dayjs | null, Dayjs | null] | null
  keyword?: string
  forumName?: string
  maxPages?: number
}

export interface CleanupSessionState {
  filterValues: CleanupFilterDraft
  preview: PreviewResult | null
  selectedIds: string[]
  pageSize: number
  currentPage: number
  scanning: boolean
  submitting: boolean
  progress: CleanupProgress | null
  liveLogs: TaskLogEntry[]
}

export interface CleanupSessionContextValue {
  sessions: Record<string, CleanupSessionState>
  setSession: (key: string, action: SetStateAction<CleanupSessionState>) => void
}

export const CleanupSessionContext = createContext<CleanupSessionContextValue | null>(null)

export function createEmptyCleanupSession(): CleanupSessionState {
  return {
    filterValues: {},
    preview: null,
    selectedIds: [],
    pageSize: 20,
    currentPage: 1,
    scanning: false,
    submitting: false,
    progress: null,
    liveLogs: []
  }
}

export function useCleanupSession(
  accountId: string,
  kind: CleanupKind
): [CleanupSessionState, Dispatch<SetStateAction<CleanupSessionState>>, string] {
  const context = useContext(CleanupSessionContext)
  if (!context) {
    throw new Error('useCleanupSession must be used inside CleanupSessionProvider')
  }

  const key = `${encodeURIComponent(accountId || 'anonymous')}:${kind}`
  const session = context.sessions[key] ?? createEmptyCleanupSession()
  const setStoredSession = context.setSession
  const setSession = useCallback<Dispatch<SetStateAction<CleanupSessionState>>>(
    (action) => setStoredSession(key, action),
    [key, setStoredSession]
  )

  return [session, setSession, key]
}
