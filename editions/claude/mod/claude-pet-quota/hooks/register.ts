// Bridges this account's plan rate-limit usage (from $.session.usage()) to a
// plain JSON file the Claude Intro 3D desktop pet reads with no engine access
// of its own. The pet's Swift side picks the newer of this file and Claude's
// own plan-usage-history.json fallback; see ../../README.md for the file path.
//
// Two triggers write it:
//  - the end of every main-thread turn (session.measure), so the pet always
//    has the reading the last answer brought back;
//  - a click on the pet: it drops refresh-request.json when its own reading
//    is over a minute old, and one session (claimed through
//    refresh-claim.json, so several open sessions do not all answer) sends a
//    one-token Haiku request -- every API response carries the account's
//    current 5-hour/weekly windows -- then writes the fresh reading.
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

// Relative to $HOME; the pet's Swift side reads/writes the same paths.
export const OUTPUT_RELATIVE_PATH =
  'Library/Application Support/Claude Intro 3D/usage.json'
export const REQUEST_RELATIVE_PATH =
  'Library/Application Support/Claude Intro 3D/refresh-request.json'
export const CLAIM_RELATIVE_PATH =
  'Library/Application Support/Claude Intro 3D/refresh-claim.json'

// A reading this recent is answer enough, however often she is clicked (the
// pet applies the same minute before it even asks).
export const FRESH_MS = 60_000
// A request nobody picked up within this long is dropped: the pet has long
// since shown what it had.
export const REQUEST_TTL_MS = 30_000
const POLL_MS = 2_000

export type UsageWindow = {
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type Snapshot = {
  version: 1
  updatedAt: string
  source: 'claude-code-session'
  windows: UsageWindow[]
}

// Pure transform, kept separate from $ so it can be unit-tested with no
// engine at all.
export function toSnapshot(rateLimits: readonly SessionRateLimit[]): Snapshot {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    source: 'claude-code-session',
    // Drop resetsAt rather than write it as `undefined` (JSON.stringify
    // would omit the key anyway, but this keeps the in-memory shape honest).
    windows: rateLimits.map(({ kind, percentUsed, resetsAt }) =>
      resetsAt === undefined ? { kind, percentUsed } : { kind, percentUsed, resetsAt },
    ),
  }
}

// Whether a pending click request still needs answering (all times in epoch
// ms): not one this session already handled, not stale, not already
// answered by a reading written after it, and not within a minute of the
// last reading.
export function shouldRefresh(
  requestedAt: number | undefined,
  lastReadingAt: number | undefined,
  handledAt: number,
  now: number,
): boolean {
  if (requestedAt === undefined || !Number.isFinite(requestedAt)) return false
  if (requestedAt <= handledAt) return false
  if (now - requestedAt > REQUEST_TTL_MS) return false
  if (lastReadingAt !== undefined) {
    if (lastReadingAt >= requestedAt) return false
    if (now - lastReadingAt < FRESH_MS) return false
  }
  return true
}

async function homePath($: EngineInterface, relative: string): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  return home === undefined ? undefined : `${home}/${relative}`
}

async function readJson($: EngineInterface, path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await $.fs.read(path))
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// One $.fs.write, no temp file or process spawn: the file is small and a
// half-written read only ever shows a stale-but-valid snapshot, never a
// torn one, since $.fs.write replaces the whole file in one call.
export async function writeSnapshot(
  $: EngineInterface,
  snapshot: Snapshot,
): Promise<void> {
  const path = await homePath($, OUTPUT_RELATIVE_PATH)
  if (path === undefined) return
  await $.fs.write(path, JSON.stringify(snapshot, null, 2))
}

function writeInBackground($: EngineInterface, rateLimits: readonly SessionRateLimit[]): void {
  void writeSnapshot($, toSnapshot(rateLimits)).catch(error =>
    $.ui.log(`${$.plugin.name}: write failed: ${String(error)}`, { to: 'debug' }),
  )
}

// This load's own name in refresh-claim.json.
const instance = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
let handledAt = 0
let busy = false

async function answerRefreshRequest($: EngineInterface): Promise<void> {
  if (busy) return
  const requestPath = await homePath($, REQUEST_RELATIVE_PATH)
  const outputPath = await homePath($, OUTPUT_RELATIVE_PATH)
  const claimPath = await homePath($, CLAIM_RELATIVE_PATH)
  if (requestPath === undefined || outputPath === undefined || claimPath === undefined) return
  if (!(await $.fs.exists(requestPath))) return

  const request = await readJson($, requestPath)
  const requestedAt = typeof request?.requestedAt === 'number' ? request.requestedAt : undefined
  const reading = await readJson($, outputPath)
  const lastReadingAt = typeof reading?.updatedAt === 'string' ? Date.parse(reading.updatedAt) : undefined
  const now = await $.clock.now()
  if (!shouldRefresh(requestedAt, Number.isNaN(lastReadingAt) ? undefined : lastReadingAt, handledAt, now)) return
  handledAt = requestedAt ?? now

  // Off a subscription (an API key, a gateway) there are no windows to
  // refresh, and a request would only spend that account's money.
  if ((await $.session.usage()).rateLimits.length === 0) return

  busy = true
  try {
    // Claim it, wait a beat, and only go on if no other session's claim
    // landed on top of ours meanwhile.
    await $.fs.write(claimPath, JSON.stringify({ by: instance, requestedAt }))
    await $.clock.sleep(150 + Math.floor(Math.random() * 250))
    const claim = await readJson($, claimPath)
    if (claim?.by !== instance) return

    const reply = await $.model.complete({ model: 'haiku', prompt: 'ok', maxTokens: 1 })
    if (!reply.isAnswered && reply.reason === 'api-error') {
      $.ui.log(`${$.plugin.name}: refresh request failed (${reply.status ?? '?'})`, { to: 'debug' })
    }
    const { rateLimits } = await $.session.usage()
    if (rateLimits.length > 0) await writeSnapshot($, toSnapshot(rateLimits))
  } finally {
    busy = false
  }
}

export const register: Register = on => {
  let poll: { cancel: () => void } | undefined

  // First reading of a brand-new session: $.session.usage() has nothing yet
  // off a subscription, so only write when a rate-limit window is present
  // rather than overwrite a good file from a previous session with nothing.
  on('session.start', async ($, e, next) => {
    try {
      const { rateLimits } = await $.session.usage()
      if (rateLimits.length > 0) writeInBackground($, rateLimits)
      poll?.cancel()
      poll = $.clock.every(POLL_MS, () => {
        void answerRefreshRequest($).catch(error =>
          $.ui.log(`${$.plugin.name}: refresh failed: ${String(error)}`, { to: 'debug' }),
        )
      })
    } catch (error) {
      $.ui.log(`${$.plugin.name}: session.start failed: ${String(error)}`, { to: 'debug' })
    }
    // Never block the session on this: observe and pass the event on.
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    poll?.cancel()
    poll = undefined
    return next(e)
  })

  // session.measure fires after every main-thread turn (and when a window
  // moves a whole point): write each time there is a reading, so the pet's
  // "updated at" follows the conversation, not only the percentages.
  on('session.measure', async ($, e, next) => {
    try {
      if (e.rateLimits.length > 0) writeInBackground($, e.rateLimits)
    } catch (error) {
      $.ui.log(`${$.plugin.name}: session.measure failed: ${String(error)}`, { to: 'debug' })
    }
    return next(e)
  })
}
