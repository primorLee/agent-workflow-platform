export interface DesktopStartupOptions {
  createWindow: () => void
  startOptionalServices: () => Promise<void>
  onOptionalServiceError: (error: unknown) => void
}

/**
 * Make the privileged application window available before optional background
 * services begin. A slow or stalled adapter must never prevent the local UI
 * from opening.
 */
export function startDesktopUi(options: DesktopStartupOptions): void {
  options.createWindow()
  void Promise.resolve()
    .then(options.startOptionalServices)
    .catch(options.onOptionalServiceError)
}