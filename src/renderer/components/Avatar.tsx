import { colorFromString, initials } from '../lib/utils'

interface AvatarProps {
  name: string
  src?: string
  size?: number
  online?: boolean
}

export function Avatar({ name, src, size = 36, online }: AvatarProps) {
  const dim = { width: size, height: size }
  if (src) {
    return (
      <div className="relative shrink-0" style={dim}>
        <img
          src={src}
          alt={name}
          style={dim}
          className="rounded-full object-cover"
          onError={(e) => {
            const img = e.currentTarget as HTMLImageElement
            img.style.display = 'none'
          }}
        />
        {online && <OnlineDot size={size} />}
      </div>
    )
  }
  return (
    <div
      className="relative flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ ...dim, background: colorFromString(name || '?') }}
      aria-hidden
    >
      <span style={{ fontSize: size * 0.4 }}>{initials(name || '?')}</span>
      {online && <OnlineDot size={size} />}
    </div>
  )
}

function OnlineDot({ size }: { size: number }) {
  return (
    <span
      className="absolute bottom-0 right-0 rounded-full border-2 border-slate-950 bg-emerald-500"
      style={{ width: size * 0.28, height: size * 0.28 }}
    />
  )
}
