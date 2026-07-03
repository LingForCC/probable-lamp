import { useState } from 'react'
import { useAppStore } from '../store/appStore'
import { getRcm } from '../lib/api'

interface SettingsModalProps {
  onClose: () => void
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const config = useAppStore((s) => s.config)
  const setTheme = useAppStore((s) => s.setTheme)
  const doLogout = useAppStore((s) => s.doLogout)
  const [theme, setLocalTheme] = useState(config?.theme ?? 'system')

  const onTheme = (t: 'light' | 'dark' | 'system') => {
    setLocalTheme(t)
    void setTheme(getRcm(), t)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      data-testid="settings-modal"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">Settings</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <section className="mb-6">
          <h3 className="mb-2 text-sm font-medium text-slate-300">Theme</h3>
          <div className="flex gap-2" data-testid="theme-options">
            {(['light', 'dark', 'system'] as const).map((t) => (
              <button
                key={t}
                data-testid={`theme-${t}`}
                onClick={() => onTheme(t)}
                className={
                  'flex-1 rounded-lg border px-3 py-2 text-sm capitalize ' +
                  (theme === t
                    ? 'border-brand-500 bg-brand-600/20 text-slate-100'
                    : 'border-slate-700 text-slate-300 hover:bg-slate-800')
                }
              >
                {t}
              </button>
            ))}
          </div>
        </section>

        <section className="mb-6">
          <h3 className="mb-2 text-sm font-medium text-slate-300">Connection</h3>
          <dl className="space-y-1 text-sm text-slate-400">
            <div className="flex justify-between">
              <dt>Mode</dt>
              <dd className="font-mono text-slate-200">{config?.apiMode ?? '—'}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Server</dt>
              <dd className="font-mono text-slate-200">{config?.server ?? '—'}</dd>
            </div>
          </dl>
        </section>

        <button
          data-testid="logout-button"
          onClick={() => void doLogout(getRcm())}
          className="w-full rounded-lg border border-red-800 bg-red-950/40 px-4 py-2 text-sm font-medium text-red-300 hover:bg-red-950"
        >
          Log out
        </button>
      </div>
    </div>
  )
}
