/**
 * Renderer-facing IPC for the provider-neutral Agent CLI runtime adapter.
 *
 * Runtime acquisition is disabled by default. The status reports `external`
 * only for an explicitly configured local executable, `managed` only for an
 * explicitly configured signed manifest, and `disabled` otherwise.
 */

import { ipcMain } from 'electron'
import {
  checkAndUpdate,
  getCliPath,
  getProgress,
  getStatusSnapshot,
  type RuntimeProgress,
  type StatusSnapshot,
  type UpdateResult,
} from './cc-runtime-updater'
import { log } from '../utils/logger'

const STATUS_CHANNEL = 'cc-runtime:status'
const CHECK_NOW_CHANNEL = 'cc-runtime:check-now'
const FORCE_UPDATE_CHANNEL = 'cc-runtime:force-update'
const GET_CLI_PATH_CHANNEL = 'cc-runtime:get-cli-path'
const PROGRESS_SNAPSHOT_CHANNEL = 'bridge:cc-runtime-progress'

export function registerCcRuntimeHandlers(): void {
  // Idempotent registration supports tests and main-process soft restarts.
  for (const channel of [
    STATUS_CHANNEL,
    CHECK_NOW_CHANNEL,
    FORCE_UPDATE_CHANNEL,
    GET_CLI_PATH_CHANNEL,
    PROGRESS_SNAPSHOT_CHANNEL,
  ]) {
    ipcMain.removeHandler(channel)
  }

  ipcMain.handle(STATUS_CHANNEL, (): StatusSnapshot => {
    try {
      return getStatusSnapshot()
    } catch (error) {
      log(
        `[cc-runtime:status] error: ${error instanceof Error ? error.message : String(error)}`,
      )
      return {
        currentVersion: null,
        lastCheckMs: 0,
        lastUpdateMs: 0,
        updating: false,
        available: false,
        source: 'disabled',
      }
    }
  })

  ipcMain.handle(CHECK_NOW_CHANNEL, async (): Promise<UpdateResult> => {
    try {
      return await checkAndUpdate({ force: false })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`[cc-runtime:check-now] error: ${message}`)
      return { updated: false, error: message }
    }
  })

  ipcMain.handle(FORCE_UPDATE_CHANNEL, async (): Promise<UpdateResult> => {
    if (process.env.AWP_AGENT_RUNTIME_FORCE_UPDATE_OPT_IN !== '1') {
      return { updated: false, error: 'force_update_requires_explicit_opt_in' }
    }
    try {
      return await checkAndUpdate({ force: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`[cc-runtime:force-update] error: ${message}`)
      return { updated: false, error: message }
    }
  })

  ipcMain.handle(GET_CLI_PATH_CHANNEL, (): string | null => {
    try {
      return getCliPath()
    } catch (error) {
      log(
        `[cc-runtime:get-cli-path] error: ${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    }
  })

  ipcMain.handle(PROGRESS_SNAPSHOT_CHANNEL, (): RuntimeProgress => getProgress())

  log('[cc-runtime-handlers] IPC handlers registered')
}