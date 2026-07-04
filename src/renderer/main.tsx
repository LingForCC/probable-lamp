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

  useEffect(() => {
    const api = getRcm()
    void init(api)
    const offRealtime = api.onRealtimeEvent((env) => applyRealtime(env))
    const offTyping = api.onTypingEvent((p) => applyTyping(p))
    // After a realtime interruption (system wake / socket reconnect), re-run
    // the unread reconcile to pick up events that were missed.
    const offReconcile = api.onRealtimeReconciled(() => void reconcileUnread(api))
    return () => {
      offRealtime()
      offTyping()
      offReconcile()
    }
  }, [init, applyRealtime, applyTyping, reconcileUnread])

  return (
    <StrictMode>
      <App />
    </StrictMode>
  )
}

const el = document.getElementById('root')
if (!el) throw new Error('#root not found')
createRoot(el).render(<Root />)
