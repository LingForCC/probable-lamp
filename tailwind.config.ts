import type { Config } from 'tailwindcss'

export default {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Brand-ish accent (RingCentral magenta family)
        brand: {
          50: '#fff1f5',
          100: '#ffe4ec',
          200: '#fecdd9',
          300: '#fda4bb',
          400: '#fb6f96',
          500: '#f43f73',
          600: '#e11d57',
          700: '#be1247',
          800: '#9f1240',
          900: '#87133b'
        }
      }
    }
  },
  plugins: []
} satisfies Config
