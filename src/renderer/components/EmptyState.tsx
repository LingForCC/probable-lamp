export function EmptyState() {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 text-slate-400"
      data-testid="empty-state"
    >
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-800 text-3xl">
        💬
      </div>
      <h2 className="text-lg font-semibold text-slate-200">Select a conversation</h2>
      <p className="max-w-xs text-center text-sm">
        Pick a chat from the sidebar to view messages, or create a new team to get started.
      </p>
    </div>
  )
}
