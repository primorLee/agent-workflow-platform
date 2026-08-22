import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    // 2026-06-10 CI fix: the vitest default 5s testTimeout flakes on loaded
    // 2-core CI runners (fork-pool contention — observed 5006ms on tests
    // that take <200ms in isolation: driver-check, no-remote-executor,
    // AdminOnboardingEvents). 15s keeps genuine hangs failing fast enough
    // while removing the load-flake class.
    testTimeout: 15_000,
    // Keep Playwright specs (top-level e2e/*.spec.ts + fixtures) out of vitest,
    // but allow co-located unit tests under e2e/helpers/__tests__/.
    exclude: [
      'e2e/*.spec.ts',
      'e2e/fixtures/**',
      'node_modules/**',
      'dist-electron/**',
      'dist/**',
    ],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // 2026-06-10 audit Round 2: route `electron` to a CJS string-export
      // stub under vitest. Real node_modules/electron/index.js THROWS at
      // import when the binary is absent (CI installs with
      // ELECTRON_SKIP_BINARY_DOWNLOAD=1) — that single throw failed 8 spec
      // files CI-only via the utils/config → credentials →
      // safe-storage-compat import chain while dev machines (binary
      // present, string export) stayed green. The stub reproduces the dev
      // semantics in both environments; per-spec vi.mock('electron', ...)
      // factories still take precedence. See vitest.electron-stub.cjs.
      electron: resolve(__dirname, 'vitest.electron-stub.cjs'),
    },
  },
})
