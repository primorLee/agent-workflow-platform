// ESLint flat config — v1.4.13 introduces the three "no-silent-failure"
// rules mandated by the industrial-grade discipline memory:
//
//   - no-empty { allowEmptyCatch: false }
//       every catch block must at minimum log; silent catches hide outages
//   - @typescript-eslint/no-explicit-any
//       `any` and `as any` are escape hatches; require a narrower shape
//   - @typescript-eslint/ban-ts-comment
//       `@ts-ignore` is banned; `@ts-expect-error` allowed with description
//
// Run: `npm run lint`. The `lint:ci` script fails the build on any warning.

import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import vuePlugin from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

const IGNORES = [
  'dist/**',
  'build/**',
  'build-insiders/**',
  'node_modules/**',
  'public/**',
  'src/locales/**', // i18n JSON-like literal modules
  'electron-builder.insiders.yml',
  'e2e/**',         // playwright artifacts
  '**/*.d.ts',
]

const CORE_RULES = {
  'no-empty': ['error', { allowEmptyCatch: false }],
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/ban-ts-comment': ['error', {
    'ts-expect-error': 'allow-with-description',
    'ts-ignore': true,
    'ts-nocheck': true,
    'ts-check': false,
    minimumDescriptionLength: 5,
  }],
}

export default [
  { ignores: IGNORES },
  // TypeScript (main + renderer shared)
  {
    files: ['electron/**/*.ts', 'src/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        Blob: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        NodeJS: 'readonly',
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        HTMLElement: 'readonly',
        Event: 'readonly',
        CustomEvent: 'readonly',
        MessageEvent: 'readonly',
        WebSocket: 'readonly',
        history: 'readonly',
        location: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        crypto: 'readonly',
        getComputedStyle: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        FileReader: 'readonly',
        File: 'readonly',
        FormData: 'readonly',
        Node: 'readonly',
        EventSource: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        MutationObserver: 'readonly',
        performance: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        global: 'readonly',
        globalThis: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...CORE_RULES,
      // TS handles these better than eslint's core checks.
      'no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },
  // Vue SFCs
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        ecmaVersion: 2022,
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
    },
    plugins: { vue: vuePlugin, '@typescript-eslint': tsPlugin },
    rules: {
      ...CORE_RULES,
      'no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },
  // Tests: loosen the no-explicit-any rule (vitest fixtures genuinely need
  // `any` for internal mock shapes). The no-empty / ban-ts-comment rules
  // still apply.
  {
    files: ['**/__tests__/**', '**/*.spec.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // (v1.4.13 had a warn-level override for 19 legacy renderer files with
  // pre-existing `any`. v1.4.14 swept every one of those files and replaced
  // `any` with structural/unknown types, so the override block is gone and
  // the whole repo enforces `no-explicit-any` at error level.)
]
