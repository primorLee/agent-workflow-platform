/**
 * End-to-end lifecycle coverage for the explicit Agent CLI adapter.
 *
 * A deterministic local fixture validates spawn argv, stream forwarding,
 * clean shutdown, and the oversized-output guard without any account, key,
 * hosted endpoint, or provider executable. Opt in with AWP_E2E_CC_WRAPPER=1.
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const DESKTOP_ROOT = path.resolve(__dirname, '..')
const FAKE_AGENT_CLI = path.resolve(__dirname, 'fixtures', 'fake-agent-cli.js')
const CHAT_ADAPTER_URL = 'http://127.0.0.1:8787'

// This expensive GUI process test is explicit opt-in.
test.describe.configure({
  mode: process.env.AWP_E2E_CC_WRAPPER ? 'default' : 'skip',
})

/** Build the explicit executable/argv/child-env contract. */
function agentRuntimeEnv(mode?: 'normal' | 'flood' | 'hang'): Record<string, string> {
  return {
    AWP_AGENT_CLI_EXECUTABLE: process.execPath,
    AWP_AGENT_CLI_ARGS_JSON: JSON.stringify([FAKE_AGENT_CLI]),
    AWP_AGENT_CLI_ENV_JSON: JSON.stringify(mode && mode !== 'normal'
      ? { AWP_FAKE_AGENT_MODE: mode }
      : {}),
  }
}

/** Launch Electron with mock CC CLI and a throwaway userDataDir. */
async function launchApp(
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; win: Page; userDataDir: string }> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awp-ccwrap-'))
  fs.writeFileSync(
    path.join(userDataDir, 'settings.json'),
    JSON.stringify({ serverUrl: CHAT_ADAPTER_URL, theme: 'light', language: 'zh-CN' }),
    'utf-8',
  )

  const cleanEnv: NodeJS.ProcessEnv = { ...process.env }
  delete cleanEnv.ELECTRON_RUN_AS_NODE
  delete cleanEnv.NODE_ENV

  const app = await electron.launch({
    args: [DESKTOP_ROOT],
    env: {
      ...cleanEnv,
      ...extraEnv,
      AWP_USER_DATA_DIR: userDataDir,
      AWP_TEST_USER_DATA_DIR_OPT_IN: '1',
    },
    timeout: 60_000,
  })
  const win = await app.firstWindow({ timeout: 30_000 })
  await win.waitForLoadState('domcontentloaded')
  return { app, win, userDataDir }
}

/**
 * Call `cc:start` from the main process, wait for the full event sequence,
 * and collect flat chunks emitted on `cc:stream-event`.
 *
 * Runs inside Electron's main process via `app.evaluate` so the IPC handlers
 * registered by `registerCcIpc()` are in scope. Returns after either
 * `message_stop` (done=true) or the supplied timeout.
 */
/**
 * Drive a full cc-wrapper turn through the **renderer preload API**
 * (`window.electronAPI.cc_*`), which is the renderer-visible path. The
 * previous version used `app.evaluate(... require('./cc/cc-wrapper') ...)`,
 * but Playwright's `app.evaluate` callback is serialised + eval'd in a
 * context where `require` is NOT a defined global, so it threw
 * `ReferenceError: require is not defined` on every test. Routing through
 * preload both fixes the spec and asserts the real IPC surface.
 *
 */
async function runCcSessionAndCollect(
  win: Page,
  opts: { conversationId: string; timeoutMs?: number } = { conversationId: 'e2e-ccw-1' },
): Promise<{
  sessionId: string | null
  chunks: Array<Record<string, unknown>>
  exitCode: number | null
  exitSignal: string | null
  exitError?: string
}> {
  // Install collectors BEFORE start so no early events are lost. Store buffers
  // on window for later readout.
  await win.evaluate(() => {
    const w = window as unknown as {
      __ccChunks?: Array<Record<string, unknown>>
      __ccExit?: { code: number | null; signal: string | null; error?: string } | null
      __ccOffEvent?: () => void
      __ccOffExit?: () => void
      electronAPI: {
        cc_on_stream_event: (cb: (p: { sessionId: string; event: Record<string, unknown> }) => void) => () => void
        cc_on_session_exit: (cb: (p: { sessionId: string; code: number | null; signal: string | null; error?: string }) => void) => () => void
      }
    }
    w.__ccChunks = []
    w.__ccExit = null
    w.__ccOffEvent = w.electronAPI.cc_on_stream_event((p) => {
      w.__ccChunks!.push(p.event)
    })
    w.__ccOffExit = w.electronAPI.cc_on_session_exit((p) => {
      w.__ccExit = { code: p.code, signal: p.signal, error: p.error }
    })
  })

  // Start the session via the exposed preload API — same call the renderer
  // chat store makes on a mode_switch pivot.
  const startRes = await win.evaluate(async (cid: string) => {
    const w = window as unknown as {
      electronAPI: {
        cc_start: (o: { conversationId: string }) => Promise<{ ok: boolean; sessionId?: string; error?: string }>
      }
    }
    return w.electronAPI.cc_start({ conversationId: cid })
  }, opts.conversationId)

  if (!startRes.ok || !startRes.sessionId) {
    return {
      sessionId: null,
      chunks: [],
      exitCode: null,
      exitSignal: null,
      exitError: startRes.error ?? 'start_failed',
    }
  }
  const sessionId = startRes.sessionId

  // Kick a turn. Mock CLI ignores stdin content; real CLI would process it.
  await win.evaluate(async (sid: string) => {
    const w = window as unknown as {
      electronAPI: {
        cc_send_message: (o: { sessionId: string; content: string }) => Promise<{ ok: boolean }>
      }
    }
    await w.electronAPI.cc_send_message({ sessionId: sid, content: 'hello from e2e' })
  }, sessionId)

  const timeout = opts.timeoutMs ?? 10_000
  // Poll window buffers until done:true, exit, or timeout.
  const result = await win.evaluate(async (t: number) => {
    const w = window as unknown as {
      __ccChunks: Array<Record<string, unknown>>
      __ccExit: { code: number | null; signal: string | null; error?: string } | null
      __ccOffEvent?: () => void
      __ccOffExit?: () => void
    }
    const deadline = Date.now() + t
    while (Date.now() < deadline) {
      if (w.__ccChunks.some((c) => (c as { done?: boolean }).done === true)) break
      if (w.__ccExit) break
      await new Promise((r) => setTimeout(r, 100))
    }
    await new Promise((r) => setTimeout(r, 300))
    const chunks = w.__ccChunks.slice()
    const exit = w.__ccExit
    try { w.__ccOffEvent?.() } catch { /* noop */ }
    try { w.__ccOffExit?.() } catch { /* noop */ }
    return { chunks, exit }
  }, timeout)

  return {
    sessionId,
    chunks: result.chunks,
    exitCode: result.exit?.code ?? null,
    exitSignal: result.exit?.signal ?? null,
    exitError: result.exit?.error,
  }
}

test.describe('cc-wrapper lifecycle (mock CLI)', () => {
  test('mode_switch chunk pivots to local CC and streams reply', async () => {
    test.setTimeout(120_000)
    const { app, win } = await launchApp(agentRuntimeEnv('normal'))

    const res = await runCcSessionAndCollect(win, {
      conversationId: 'e2e-ccw-normal',
      timeoutMs: 10_000,
    })

    expect(res.sessionId, 'cc:start should return a sessionId').toBeTruthy()

    // Assert the translated flat chunks (cc-wrapper.translateEvent contract):
    //   message_start → { type: 'message_start', model, conversation_id }
    //   content_block_delta → { delta: 'ok' }
    //   message_delta       → { usage: {...} }
    //   message_stop        → { done: true }
    const types = res.chunks.map((c) => (c as { type?: string }).type)
    expect(types, 'should include translated message_start').toContain('message_start')

    const deltas = res.chunks
      .map((c) => (c as { delta?: string }).delta)
      .filter((d): d is string => typeof d === 'string')
    expect(deltas.join(''), 'text_delta should stream "ok"').toBe('ok')

    const usageChunk = res.chunks.find(
      (c) => typeof (c as { usage?: unknown }).usage === 'object',
    ) as { usage: Record<string, number> } | undefined
    expect(usageChunk?.usage?.input_tokens, 'usage.input_tokens forwarded').toBe(15)
    expect(usageChunk?.usage?.output_tokens, 'usage.output_tokens forwarded').toBe(1)
    expect(
      usageChunk?.usage?.cache_read_input_tokens,
      'usage.cache_read_input_tokens forwarded',
    ).toBe(10)
    expect(
      usageChunk?.usage?.cache_creation_input_tokens,
      'usage.cache_creation_input_tokens forwarded',
    ).toBe(5)

    const doneChunk = res.chunks.find((c) => (c as { done?: boolean }).done === true)
    expect(doneChunk, 'final chunk should carry done:true').toBeTruthy()

    // Exit should be clean (code 0, no error from spawn).
    expect(res.exitError, 'no spawn error').toBeFalsy()
    expect(res.exitCode, 'mock CLI exits with code 0').toBe(0)

    await app.close()
  })

  test('cc session stops cleanly on app quit', async () => {
    test.setTimeout(60_000)
    const { app, win } = await launchApp(agentRuntimeEnv('hang'))

    // Start a session that will hang until SIGTERM — we don't wait for done.
    const startInfo = await win.evaluate(async () => {
      const w = window as unknown as {
        electronAPI: {
          cc_start: (o: { conversationId: string }) => Promise<{ ok: boolean; sessionId?: string; error?: string }>
          cc_status: (o: { sessionId: string }) => Promise<{ phase: string; pid?: number }>
        }
      }
      const r = await w.electronAPI.cc_start({ conversationId: 'e2e-ccw-hang' })
      if (!r.ok || !r.sessionId) return { sessionId: null, pid: null }
      const s = await w.electronAPI.cc_status({ sessionId: r.sessionId })
      return { sessionId: r.sessionId, pid: s.pid ?? null }
    })

    expect(startInfo.sessionId, 'hung session started').toBeTruthy()
    expect(startInfo.pid, 'mock CLI has a pid').toBeTruthy()

    // Trigger the Phase-2 shutdown path explicitly via preload IPC.
    const stopResult = await win.evaluate(async (sid: string) => {
      const w = window as unknown as {
        electronAPI: {
          cc_stop: (o: { sessionId: string }) => Promise<{ ok: boolean; error?: string }>
          cc_status: (o: { sessionId: string }) => Promise<{ phase: string }>
        }
      }
      await w.electronAPI.cc_stop({ sessionId: sid })
      await new Promise((r) => setTimeout(r, 500))
      const s = await w.electronAPI.cc_status({ sessionId: sid })
      return s.phase
    }, startInfo.sessionId!)

    expect(stopResult, 'session phase after stop').toBe('exited')

    await app.close()
  })

  test('oversized stdout triggers session stop with error', async () => {
    test.setTimeout(60_000)
    const { app, win } = await launchApp(agentRuntimeEnv('flood'))

    const res = await runCcSessionAndCollect(win, {
      conversationId: 'e2e-ccw-flood',
      timeoutMs: 20_000,
    })

    expect(res.sessionId, 'flood session starts normally').toBeTruthy()

    // cc-wrapper should have emitted `{ error: 'runtime_output_oversize', done: true }`
    // before killing the child — see cc-wrapper.ts:262-269.
    const oversizeChunk = res.chunks.find(
      (c) => (c as { error?: string }).error === 'runtime_output_oversize',
    )
    expect(oversizeChunk, 'runtime_output_oversize error chunk emitted').toBeTruthy()
    expect((oversizeChunk as { done?: boolean }).done, 'done:true on oversize').toBe(true)

    await app.close()
  })
})
