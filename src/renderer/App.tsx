import { useEffect } from 'react'
import { getRcm } from './lib/api'
import { useAppStore } from './store/appStore'
import { LoginScreen } from './components/LoginScreen'
import { Sidebar } from './components/Sidebar'
import { ChatView } from './components/ChatView'
import { EmptyState } from './components/EmptyState'
import { SettingsModal } from './components/SettingsModal'
import { ErrorToast } from './components/ErrorToast'
import { CreateTeamModal } from './components/CreateTeamModal'
import { useState } from 'react'

export function App() {
  const auth = useAppStore((s) => s.auth)
  const config = useAppStore((s) => s.config)
  const activeChatId = useAppStore((s) => s.activeChatId)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [createTeamOpen, setCreateTeamOpen] = useState(false)

  // Apply theme class to <html>.
  useEffect(() => {
    const theme = config?.theme ?? 'system'
    const root = document.documentElement
    const apply = (dark: boolean) => root.classList.toggle('dark', dark)
    if (theme === 'dark') apply(true)
    else if (theme === 'light') apply(false)
    else {
      const mql = window.matchMedia('(prefers-color-scheme: dark)')
      apply(mql.matches)
      const handler = (e: MediaQueryListEvent) => apply(e.matches)
      mql.addEventListener('change', handler)
      return () => mql.removeEventListener('change', handler)
    }
  }, [config?.theme])

  if (auth.status === 'loggedOut' || auth.status === 'error') {
    return (
      <>
        <LoginScreen />
        <ErrorToast />
      </>
    )
  }
  if (auth.status === 'authenticating') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-slate-950 text-slate-300">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-600 border-t-brand-500" />
          <p>Connecting…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-slate-950 text-slate-100">
      <Sidebar
        onOpenSettings={() => setSettingsOpen(true)}
        onNewTeam={() => setCreateTeamOpen(true)}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        {activeChatId ? <ChatView /> : <EmptyState />}
      </main>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {createTeamOpen && (
        <CreateTeamModal api={getRcm()} onClose={() => setCreateTeamOpen(false)} />
      )}
      <ErrorToast />
    </div>
  )
}
