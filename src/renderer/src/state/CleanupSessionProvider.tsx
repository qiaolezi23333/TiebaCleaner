import { useCallback, useMemo, useState, type PropsWithChildren, type SetStateAction } from 'react'
import {
  CleanupSessionContext,
  createEmptyCleanupSession,
  type CleanupSessionState
} from './cleanup-session'

export function CleanupSessionProvider({ children }: PropsWithChildren): React.JSX.Element {
  const [sessions, setSessions] = useState<Record<string, CleanupSessionState>>({})

  const setSession = useCallback(
    (key: string, action: SetStateAction<CleanupSessionState>): void => {
      setSessions((current) => {
        const previous = current[key] ?? createEmptyCleanupSession()
        const next = typeof action === 'function' ? action(previous) : action
        if (next === previous) return current
        return { ...current, [key]: next }
      })
    },
    []
  )

  const value = useMemo(() => ({ sessions, setSession }), [sessions, setSession])

  return <CleanupSessionContext.Provider value={value}>{children}</CleanupSessionContext.Provider>
}
