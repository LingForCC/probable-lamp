import { getRcm } from '../lib/api'
import { useAppStore } from '../store/appStore'

export function LoginScreen() {
  const doLogin = useAppStore((s) => s.doLogin)
  const auth = useAppStore((s) => s.auth)
  const config = useAppStore((s) => s.config)
  const isMock = config?.apiMode === 'mock'

  return (
    <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-brand-950 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900/70 p-8 shadow-2xl backdrop-blur">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-600 text-2xl font-black text-white shadow-lg shadow-brand-900/50">
            RC
          </div>
          <h1 className="text-xl font-bold text-slate-100">RC Messenger</h1>
          <p className="mt-1 text-sm text-slate-400">
            {isMock
              ? 'Demo mode — no RingCentral account needed.'
              : 'Connect your RingCentral account to start messaging.'}
          </p>
        </div>

        {auth.status === 'error' && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-300">
            {auth.message}
          </div>
        )}

        <button
          data-testid="login-button"
          onClick={() => void doLogin(getRcm())}
          className="w-full rounded-lg bg-brand-600 px-4 py-2.5 font-semibold text-white transition hover:bg-brand-500 active:scale-[0.99] disabled:opacity-50"
          disabled={auth.status === 'authenticating'}
        >
          {isMock ? 'Enter demo' : 'Retry connection'}
        </button>

        {!isMock && (
          <p className="mt-4 text-center text-xs text-slate-500">
            The app connects automatically using the configured{' '}
            <code className="rounded bg-slate-800 px-1">RC_JWT</code>. If the
            connection fails, check your JWT and try again.
          </p>
        )}
        {isMock && (
          <p className="mt-4 text-center text-xs text-slate-500">
            Set <code className="rounded bg-slate-800 px-1">RC_JWT</code> and{' '}
            <code className="rounded bg-slate-800 px-1">RC_API_MODE=real</code> to use a real account.
          </p>
        )}
      </div>
    </div>
  )
}
