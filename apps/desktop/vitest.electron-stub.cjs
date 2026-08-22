/**
 * vitest-only stub for the `electron` package (wired via resolve.alias in
 * vitest.config.ts — never used by the real build).
 *
 * Why this exists (2026-06-10 audit Round 2, runs 27278875633/27278875481):
 * under plain Node the real `node_modules/electron/index.js` exports the
 * BINARY PATH STRING — and THROWS ("Electron failed to install correctly")
 * when the binary was never downloaded. CI runs `npm ci` with
 * ELECTRON_SKIP_BINARY_DOWNLOAD=1, so every spec whose import graph touches
 * `electron` without a local vi.mock died CI-only while staying green on
 * dev machines (the chain that killed 8 spec files: utils/config →
 * credentials → safe-storage-compat → `import { safeStorage } from
 * 'electron'`).
 *
 * The stub replicates the DEV-MACHINE semantics exactly: a CJS string
 * export, so `import { app } from 'electron'` yields `undefined` through
 * the ESM interop — same as when the binary is installed. Specs that
 * vi.mock('electron', factory) are unaffected (the factory wins over the
 * alias target). Do NOT add named exports here — code under test must keep
 * mocking what it needs explicitly.
 */
module.exports = '/vitest-electron-stub/no-real-binary'
