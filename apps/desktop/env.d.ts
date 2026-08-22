/// <reference types="vite/client" />

declare const __APP_VERSION__: string
declare const __FORCE_DEV_MODE__: boolean

// Window.electronAPI is authoritatively declared in src/types/window.d.ts
// (ADR-012 T-A041). That file upgrades the type from the legacy
// DesktopBridge to DesktopElectronApi so CC subprocess methods (cc_*)
// are typechecked at call-sites.
