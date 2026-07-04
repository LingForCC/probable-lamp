import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { getRcm } from './lib/api'
import { useAppStore } from './store/appStore'

function Root() {
  const init = useAppStore((s) => s.init)
  const applyRealtime = useAppStore((s) => s.applyRealtime)
  const applyTyping = useAppStore((s) => s.applyTyping)
  const reconcileUnread = useAppStore((s) => s.reconcileUnread)
  const applyAuthState = useAppStore((s) => s.applyAuthState)

  useEffect(() => {
    const api = getRcm()
    void init(api)
    const offRealtime = api.onRealtimeEvent((env) => applyRealtime(env))
    const offTyping = api.onTypingEvent((p) => applyTyping(p))
    // After a realtime interruption (system wake / socket reconnect), re-run
    // the unread reconcile to pick up events that were missed.
    const offReconcile = api.onRealtimeReconciled(() => void reconcileUnread(api))
    // Main pushes auth-state changes (auto-login result, login, logout). This is
    // how the renderer learns the boot-time JWT exchange finished.
    const offAuth = api.onAuthStateChanged((state) => applyAuthState(api, state))
    return () => {
      offRealtime()
      offTyping()
      offReconcile()
      offAuth()
    }
  }, [init, applyRealtime, applyTyping, reconcileUnread, applyAuthState])

  return (
    <StrictMode>
      <App />
    </StrictMode>
  )
}

const el = document.getElementById('root')
if (!el) throw new Error('#root not found')
createRoot(el).render(<Root />)
