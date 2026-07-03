import '@testing-library/jest-dom/vitest'

// jsdom doesn't implement matchMedia; App.tsx uses it for the 'system' theme.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false
      }) as unknown as MediaQueryList
  })
}

// jsdom lacks URL.createObjectURL/revokeObjectURL (used by some components).
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = (() => 'blob:mock') as typeof URL.createObjectURL
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
}
