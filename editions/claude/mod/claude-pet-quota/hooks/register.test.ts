import { expect, mock, test } from 'claude-code/testing'
import { FRESH_MS, REQUEST_TTL_MS, shouldRefresh, toSnapshot } from './register'

// --- click-to-refresh decision (pure) ---

const NOW = 1_800_000_000_000

test('shouldRefresh: a fresh click request with an old reading is answered', () => {
  expect(shouldRefresh(NOW - 1_000, NOW - FRESH_MS - 1, 0, NOW)).toBe(true)
  expect(shouldRefresh(NOW - 1_000, undefined, 0, NOW)).toBe(true)
})

test('shouldRefresh: a reading under a minute old is answer enough, however many clicks', () => {
  expect(shouldRefresh(NOW - 1_000, NOW - FRESH_MS + 5_000, 0, NOW)).toBe(false)
})

test('shouldRefresh: never twice for the same request, nor once another session already wrote after it', () => {
  expect(shouldRefresh(NOW - 1_000, undefined, NOW - 1_000, NOW)).toBe(false)
  expect(shouldRefresh(NOW - 5_000, NOW - 2_000, 0, NOW)).toBe(false)
})

test('shouldRefresh: a stale or missing request is dropped', () => {
  expect(shouldRefresh(NOW - REQUEST_TTL_MS - 1, undefined, 0, NOW)).toBe(false)
  expect(shouldRefresh(undefined, undefined, 0, NOW)).toBe(false)
  expect(shouldRefresh(Number.NaN, undefined, 0, NOW)).toBe(false)
})

// --- snapshot shape ---

test('toSnapshot maps kind/percentUsed/resetsAt and stamps the source', () => {
  const snapshot = toSnapshot([
    { kind: 'five_hour', percentUsed: 34, resetsAt: '2026-10-11T20:00:00Z' },
    { kind: 'seven_day', percentUsed: 61.5 },
  ])
  expect(snapshot.version).toBe(1)
  expect(snapshot.source).toBe('claude-code-session')
  expect(snapshot.windows).toEqual([
    { kind: 'five_hour', percentUsed: 34, resetsAt: '2026-10-11T20:00:00Z' },
    { kind: 'seven_day', percentUsed: 61.5 },
  ])
  expect(typeof snapshot.updatedAt).toBe('string')
})

test('toSnapshot drops resetsAt instead of writing it as undefined', () => {
  const snapshot = toSnapshot([{ kind: 'seven_day', percentUsed: 61.5 }])
  const [window] = snapshot.windows
  expect(window === undefined ? false : 'resetsAt' in window).toBe(false)
})

test('toSnapshot of no rate-limit reading yet is an empty window list', () => {
  expect(toSnapshot([]).windows).toEqual([])
})

// Hook-level tests: confirm the hook itself never throws and still lets the
// chain finish, with no real engine beneath `$.session.measure` to answer it
// (a test must supply that bottom itself, as below). `claude-code/testing`
// has no mock for `$.fs` at all (confirmed empirically: there is no
// `mock.fs`, and a dispatched call to the real `$.fs.write` rejects). So
// neither test below can assert a file was actually written; each only
// proves that whichever branch of writeSnapshot it drives into leaves
// session.measure's chain intact.
//
// With HOME set, writeSnapshot clears its own home-undefined guard and
// reaches `$.fs.write`, which rejects (unmocked) into its fire-and-forget
// `.catch` — confirmed empirically: the harness logs
// "[pet-quota] $.ui.log dropped: HooksError: no implementation for ui.log"
// for this case (the .catch's own $.ui.log call has no implementation
// either), and does not for the HOME-unset case below.
test('session.measure with a moved rateLimits does not throw, and next(e) still runs', async ($, on) => {
  mock.env(on, { HOME: '/fake/home/for-test' })

  // Nothing sits beneath the plugins in a test, so the test itself must be
  // the bottom of the chain: answer the event directly instead of calling
  // next(e) again (there is nothing left beneath that to answer it).
  let bottomRan = false
  on('session.measure', ($2, e) => {
    bottomRan = true
    return { changed: e.changed }
  })

  const result = await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 12 }],
    changed: ['rateLimits'],
  })

  expect(result.changed).toEqual(['rateLimits'])
  expect(bottomRan).toBe(true)
})

// With HOME unset, writeSnapshot returns at its own early-return guard
// before ever calling $.fs.write — a different, equally-silent path from
// the one above, and the one `mock.env(on, {})` actually exercises.
test('session.measure still does not throw when HOME is unset (writeSnapshot no-ops)', async ($, on) => {
  mock.env(on, {})

  let bottomRan = false
  on('session.measure', ($2, e) => {
    bottomRan = true
    return { changed: e.changed }
  })

  const result = await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 12 }],
    changed: ['rateLimits'],
  })

  expect(result.changed).toEqual(['rateLimits'])
  expect(bottomRan).toBe(true)
})

// Every turn end writes when there is a reading, not only when a window
// moved a whole point: a measure that only names `context` still passes
// through untouched (and, off a subscription, an empty reading writes nothing).
test('session.measure after an ordinary turn (context only changed) still passes through', async ($, on) => {
  mock.env(on, {})
  let bottomRan = false
  on('session.measure', ($2, e) => {
    bottomRan = true
    return { changed: e.changed }
  })
  const result = await $.session.measure({
    context: { window: 200000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-11T16:00:00Z' }],
    changed: ['context'],
  })
  expect(result.changed).toEqual(['context'])
  expect(bottomRan).toBe(true)
})

test('session.measure with no reading (off a subscription) passes through', async ($, on) => {
  mock.env(on, {})
  let bottomRan = false
  on('session.measure', ($2, e) => {
    bottomRan = true
    return { changed: e.changed }
  })
  const result = await $.session.measure({ context: { window: 200000 }, rateLimits: [], changed: ['context'] })
  expect(result.changed).toEqual(['context'])
  expect(bottomRan).toBe(true)
})
