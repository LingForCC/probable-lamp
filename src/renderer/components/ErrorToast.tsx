import { useEffect, useState } from 'react'
import { useAppStore } from '../store/appStore'

/** Shows a transient toast for the latest error in the store. */
export function ErrorToast() {
  const error = useAppStore((s) => s.error)
  const setError = useAppStore((s) => s.setError)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!error) return
    setVisible(true)
    const t = setTimeout(() => {
      setVisible(false)
      setError(null)
    }, 5000)
    return () => clearTimeout(t)
  }, [error, setError])

  if (!error || !visible) return null
  return (
    <div
      data-testid="error-toast"
      className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-red-800 bg-red-950/90 px-4 py-2 text-sm text-red-200 shadow-xl"
    >
      {error}
    </div>
  )
}
