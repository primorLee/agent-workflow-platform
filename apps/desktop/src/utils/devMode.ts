/** Check if app is running in local/demo mode.
 * True for Vite development or a packaged self-hosted build with AWP_DEV=1.
 */
declare const __FORCE_DEV_MODE__: boolean | undefined
export const isDevMode: boolean = import.meta.env.DEV || (typeof __FORCE_DEV_MODE__ !== 'undefined' && __FORCE_DEV_MODE__)
