/**
 * Channel + userData bootstrap — MUST be the first import in main.ts.
 *
 * Runs at module load time (before any other import can fire its top-level
 * code). Derives Stable/Insiders/Dev from app.getName() (available
 * immediately in Electron main, no whenReady required) and sets both:
 *   - process.env.AWP_CHANNEL — read by config.ts without electron dep
 *   - app.setPath('userData') — so Electron internals (session, cache,
 *     crash dumps) go to the right place
 *
 * Do NOT import anything from ../utils/ or ../ipc/ here; this module is
 * the universal prerequisite. Only electron + node built-ins.
 */
import { app } from 'electron'
import path from 'node:path'
import os from 'node:os'

const productName = app.getName()
const isInsiders = productName.toLowerCase().includes('insiders')
const isDev =
  !app.isPackaged ||
  process.env.NODE_ENV === 'development' ||
  process.argv.includes('--dev')

const dirName = isDev ? '.awp-dev' : isInsiders ? '.awp-insiders' : '.awp'
const defaultDir = path.join(os.homedir(), dirName)
const envOverride = process.env.AWP_USER_DATA_DIR?.trim()
const allowTestOverride = !app.isPackaged && process.env.AWP_TEST_USER_DATA_DIR_OPT_IN === '1'
if (allowTestOverride && envOverride && !path.isAbsolute(envOverride)) {
  throw new Error('test_user_data_dir_must_be_absolute')
}
export const awpDir = allowTestOverride && envOverride ? path.resolve(envOverride) : defaultDir

process.env.AWP_CHANNEL = isInsiders ? 'insiders' : 'stable'
process.env.AWP_RESOLVED_USER_DATA_DIR = awpDir
app.setPath('userData', awpDir)

export const isInsidersChannel = isInsiders
export const isDevMode = isDev
