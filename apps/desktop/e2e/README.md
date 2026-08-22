# Desktop E2E suites

The public suites are either renderer-local or explicitly adapter-driven. They do not contain production accounts, live tenant probes, retired hosted flows, or domain-specific fixtures.

```bash
npm run build:electron-main
npm run build:awp-cloud-mcp
npm run build-only
npx playwright test --config=playwright.electron.config.ts --list
```

The Electron config lists only suites that launch the built application. Tests that need an external compatible adapter must receive its loopback URL through the documented test environment; no public test defaults to an external host.

Playwright reports and traces are written under ignored local output directories. Never commit captured sessions or account material.