// node --test tests/pet-handoff.test.cjs
//
// pet.js is a WKWebView runtime: it is never required() for this file the
// way tests/pet.test.cjs does (that only reaches the pure, DOM-free half of
// the module). Here we evaluate the real source with vm, root set to a fake
// `window`, exactly like a browser would load it -- so `start()`, `click()`
// and `play()` run their real DOM code paths, not stand-ins for them.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const petPath = path.join(__dirname, '..', 'Resources', 'web', 'pet', 'pet.js')
const petSource = fs.readFileSync(petPath, 'utf8')
const manifestPath = path.join(__dirname, '..', 'Resources', 'web', 'pet', 'clips', 'clips.sample.json')
const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

// --- fake DOM plumbing -----------------------------------------------------

function makeListenable() {
  const listeners = {}
  return {
    addEventListener(type, fn) {
      ;(listeners[type] || (listeners[type] = [])).push(fn)
    },
    removeEventListener(type, fn) {
      const list = listeners[type]
      if (!list) return
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    fire(type, extra) {
      for (const fn of (listeners[type] || []).slice()) fn(Object.assign({ currentTarget: this, type }, extra))
    },
  }
}

function makeClassList() {
  const set = new Set()
  return { add: v => set.add(v), remove: v => set.delete(v), contains: v => set.has(v) }
}

// A generic element covers div/img; a 'video' element additionally gets the
// handful of HTMLVideoElement members pet.js actually touches. Every call
// that matters to the handOff() bug is recorded into `calls` so assertions
// can read it back without reaching into pet.js's private closure state.
function makeElement(tag, id, calls) {
  const el = Object.assign({ tagName: tag, dataset: {}, style: {}, classList: makeClassList(), innerHTML: '' }, makeListenable())
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 120, height: 160 })
  el.querySelector = sel => (sel === '.tail' ? (el._tail || (el._tail = { style: {} })) : null)
  if (tag === 'video') {
    Object.assign(el, {
      src: '', currentTime: 0, paused: true, ended: false, seeking: false, readyState: 0, muted: false,
      load() { calls.loadCalls.push({ id, clip: el.dataset.clip }) },
      play() { calls.playCalls.push({ id, clip: el.dataset.clip }); el.paused = false; return Promise.resolve() },
      pause() { calls.pauseCalls.push({ id, clip: el.dataset.clip }); el.paused = true },
      requestVideoFrameCallback(cb) { el._rvfc = cb },
    })
  }
  if (tag === 'img') el.decode = () => Promise.resolve()
  return el
}

// pet.js's own setTimeout/clearTimeout, replaced with a queue the test fires
// by hand instead of real wall-clock time (the only delay it ever schedules
// is the constant BLEND*2000+100ms "load the spare element now" timer, plus
// the bubble's 8s auto-hide -- neither needs to elapse for real).
function makeClock() {
  let nextId = 1
  const timers = new Map()
  return {
    setTimeout(fn) { const id = nextId++; timers.set(id, fn); return id },
    clearTimeout(id) { timers.delete(id) },
    fireAll() {
      for (const id of [...timers.keys()]) {
        const fn = timers.get(id)
        timers.delete(id)
        if (fn) fn()
      }
    },
  }
}

function createHarness() {
  const calls = { loadCalls: [], playCalls: [], pauseCalls: [] }
  const messages = []
  const clock = makeClock()
  const elements = {}
  const el = (tag, id) => (elements[id] = makeElement(tag, id, calls))

  const doc = Object.assign(
    { documentElement: { style: { setProperty() {} } }, body: { style: {} }, getElementById: id => elements[id] || null },
    makeListenable()
  )
  el('div', 'frame'); el('img', 'poster'); el('div', 'shadow'); el('div', 'bubble'); el('video', 'videoA'); el('video', 'videoB')

  const sandbox = {}
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.document = doc
  sandbox.innerWidth = 800
  sandbox.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(manifestData))) })
  sandbox.setTimeout = (fn, ms) => clock.setTimeout(fn, ms)
  sandbox.clearTimeout = id => clock.clearTimeout(id)
  sandbox.webkit = { messageHandlers: { pet: { postMessage: msg => messages.push(msg) } } }
  sandbox.console = console

  vm.createContext(sandbox)
  // Keep every idle-vs-pose dice roll on "idle" so only the clip under test
  // moves. `sandbox.Math` is only reachable from inside the context once a
  // script has run there, so this has to go through runInContext too.
  vm.runInContext('Math.random = () => 1', sandbox)
  vm.runInContext(petSource, sandbox, { filename: petPath })

  const setFetch = fetch => { sandbox.fetch = fetch }
  return {
    api: sandbox.ClaudePet, calls, messages, clock, manifest: manifestData,
    videoA: elements.videoA, videoB: elements.videoB, poster: elements.poster, bubble: elements.bubble, setFetch,
  }
}

// Flushes real microtasks (the Promise chains inside pet.js, e.g.
// incoming.play().then(...)), which is independent of the fake clock above.
const flush = () => new Promise(resolve => setImmediate(resolve))

// Simulates the back element's cue-while-paused dance pet.js relies on:
// loadedmetadata seeks it to its first used frame (onMeta, since it is still
// paused), then seeked/canplay mark it ready (cued()'s readyState>=3 check).
function cueBack(video) {
  video.fire('loadedmetadata')
  video.readyState = 4
  video.fire('seeked')
  video.fire('canplay')
}

// Simulates one requestVideoFrameCallback presentation of `video` at
// `frame` (in clip-frame units), driving pet.js's reached()/handOff() chain
// exactly as a real <video> firing rVFC would.
function deliverFrame(video, frame, fps) {
  video.currentTime = frame / fps
  const cb = video._rvfc
  video._rvfc = null
  if (cb) cb(0, { mediaTime: video.currentTime })
}

test('the poster is hidden for good after the first clip frame presents, so a later pose never shows a ghost of her neutral standing pose behind it (regression for the "double figure" bug)', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  await flush()
  const { videoA, poster } = h

  // Before the very first frame is actually presented, the poster must
  // still be showing — it is what covers the gap while the first video
  // fades in (see the stylesheet comment by #poster/.clip-video).
  assert.notEqual(poster.style.display, 'none', 'poster still covers the gap before the first frame presents')

  videoA.fire('playing') // the browser just presented idle's first frame
  assert.equal(videoA.dataset.front, '', 'the first clip is front immediately on "playing"')
  // Hiding is deferred to let the CSS crossfade (BLEND = 0.2s) actually run;
  // hiding it mid-fade would flash the transparent stage background instead
  // of the smooth poster-to-video handover the comment there describes.
  assert.notEqual(poster.style.display, 'none', 'not hidden yet -- the first fade-in is still in flight')

  h.clock.fireAll() // the BLEND-timed hide fires
  assert.equal(poster.style.display, 'none', 'the poster is hidden once the first fade-in has run its course')

  // Before the fix, the poster was never hidden at all: its neutral
  // standing pose kept showing through every later clip's transparent
  // padding (HEVC alpha outside her current silhouette) as a second,
  // ghost figure the instant a pose diverged from that neutral frame —
  // exactly the reported "she appears twice" bug. Playing a pose now must
  // never bring the poster back.
  h.api.play('snap')
  assert.equal(poster.style.display, 'none', 'still hidden once a different-pose clip is queued')
})

test('a video failure brings the poster back rather than leaving a blank panel', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  await flush()
  const { videoA, poster } = h
  videoA.fire('playing')
  h.clock.fireAll()
  assert.equal(poster.style.display, 'none', 'hidden once real playback is under way')

  videoA.fire('error')
  assert.notEqual(poster.style.display, 'none', 'the poster comes back once nothing else can show her')
})

test('one click during idle: the reaction becomes front once, plays to its own `to`, idle follows, and is never reloaded twice', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  await flush()
  const fps = h.manifest.fps
  const { videoA, videoB } = h // front = videoA (idle), back = videoB (idle)
  assert.equal(videoA.dataset.clip, 'idle')
  assert.equal(videoB.dataset.clip, 'idle')

  videoA.currentTime = 5 / fps // idle has been playing a little while already
  h.api.click()
  assert.equal(videoB.dataset.clip, 'click', 'queueClip() cues the reaction onto the back element right away')
  assert.equal(h.calls.loadCalls.filter(c => c.clip === 'click').length, 1)
  cueBack(videoB)

  let before = h.calls.playCalls.length
  deliverFrame(videoA, 37, fps) // idle's next safe frame (40) minus LEAD(2) = 38: not yet
  assert.equal(h.calls.playCalls.length, before, 'no hand-over before the interrupt frame')
  deliverFrame(videoA, 38, fps)
  assert.equal(h.calls.playCalls.length, before + 1, 'the reaction takes over exactly at the interrupt frame')
  await flush()
  assert.equal(videoB.dataset.clip, 'click', 'the reaction is now front')

  // The spare element (videoA) gets reloaded for whatever plays after the
  // reaction. It must be 'idle', not 'click' queued a second time.
  h.clock.fireAll()
  assert.equal(videoA.dataset.clip, 'idle', 'decideNext() must not re-select the just-played reaction')
  assert.equal(h.calls.loadCalls.filter(c => c.clip === 'click').length, 1, 'the reaction clip is loaded exactly once, ever')
  cueBack(videoA)

  before = h.calls.playCalls.length
  deliverFrame(videoB, 43, fps) // click.to(46) - LEAD(2) = 44: not yet
  assert.equal(h.calls.playCalls.length, before, 'the reaction is not cut short before its own `to`')
  deliverFrame(videoB, 44, fps)
  assert.equal(h.calls.playCalls.length, before + 1, 'the reaction hands off only at its own `to`')
  await flush()
  assert.equal(videoA.dataset.clip, 'idle', 'idle follows the reaction')
})

test("ClaudePet.play('snap') -- a pose with an interior safe frame -- plays fully once and returns to idle", async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  await flush()
  const fps = h.manifest.fps
  const { videoA, videoB } = h

  videoA.currentTime = 5 / fps
  h.api.play('snap')
  assert.equal(videoB.dataset.clip, 'snap')
  cueBack(videoB)

  let before = h.calls.playCalls.length
  deliverFrame(videoA, 37, fps) // idle interrupt frame is still 38 here
  assert.equal(h.calls.playCalls.length, before)
  deliverFrame(videoA, 38, fps)
  assert.equal(h.calls.playCalls.length, before + 1)
  await flush()
  assert.equal(videoB.dataset.clip, 'snap', 'snap is now front')

  h.clock.fireAll() // spare element reload: must become idle, ready for after snap
  assert.equal(videoA.dataset.clip, 'idle')
  cueBack(videoA)

  // snap's own safe frames are [1, 20, 58]: frame 20 is an interior point a
  // truncated hand-over would stop at. It must be skipped in favour of
  // snap.to(58) - LEAD(2) = 56.
  before = h.calls.playCalls.length
  deliverFrame(videoB, 18, fps) // interior safe frame (20) - LEAD = 18
  assert.equal(h.calls.playCalls.length, before, 'the interior safe frame must not truncate the pose')
  deliverFrame(videoB, 55, fps)
  assert.equal(h.calls.playCalls.length, before, 'still not at `to` - LEAD')
  deliverFrame(videoB, 56, fps)
  assert.equal(h.calls.playCalls.length, before + 1, 'the pose hands off only at its own `to`')
  await flush()
  assert.equal(videoA.dataset.clip, 'idle', 'idle follows the pose')
})

test('a click during an in-flight hand-over re-aims the new front at its next safe frame (the else-branch), and the reaction still lands cleanly once it actually plays', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  await flush()
  const fps = h.manifest.fps
  const { videoA, videoB } = h
  cueBack(videoB) // the natural idle-to-idle hand-over needs a cued back element

  // Drive the first (idle-to-idle) hand-over into flight, then click before
  // its play().then() settles: `handing` is still true at this instant.
  deliverFrame(videoA, h.manifest.clips.idle.to - h.api.LEAD, fps)
  const playsBeforeClick = h.calls.playCalls.length
  h.api.click()
  assert.equal(h.calls.playCalls.length, playsBeforeClick, 'the click is recorded but cannot act while a hand-over is in flight')
  assert.equal(h.calls.loadCalls.filter(c => c.clip === 'click').length, 0, 'nothing is cued for it yet')

  await flush() // the in-flight hand-over resolves: idle (videoB) becomes the new front
  assert.equal(videoB.dataset.clip, 'idle')

  // decideNext() surfaces the still-pending click request onto the spare
  // element so it can take over at idle's next safe frame: this exercises
  // the else-branch's re-aim of the (non-matching) new front. Note that
  // decideNext() -- unchanged by this fix -- already clears pendingReaction
  // here, so this step alone cannot tell pre- from post-fix pet.js apart.
  h.clock.fireAll()
  assert.equal(videoA.dataset.clip, 'click')

  // The hand-over is no longer in flight now, so a plain click re-arms the
  // already-loaded clip the same direct way an uninterrupted click would --
  // this is what actually lets the eventual hand-over match-check run with
  // pendingReaction still set, the same mechanism scenario 1 exercises.
  h.api.click()
  cueBack(videoA)

  let before = h.calls.playCalls.length
  deliverFrame(videoB, 37, fps) // idle's next safe frame (40) minus LEAD = 38
  assert.equal(h.calls.playCalls.length, before, 'no takeover before the safe-frame interrupt')
  deliverFrame(videoB, 38, fps)
  assert.equal(h.calls.playCalls.length, before + 1, 'the reaction takes over exactly at the safe-frame interrupt')
  await flush()
  assert.equal(videoA.dataset.clip, 'click', 'the reaction is now actually front')

  // Once it truly is front, idle must follow it once -- not the reaction
  // queued at itself a second time by decideNext().
  h.clock.fireAll()
  assert.equal(videoB.dataset.clip, 'idle', 'decideNext() must not re-select the just-played reaction')
})

test('clicking again while the reaction is already playing does not queue it a second time', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  await flush()
  const fps = h.manifest.fps
  const { videoA, videoB } = h

  videoA.currentTime = 5 / fps
  h.api.click()
  cueBack(videoB)
  deliverFrame(videoA, 38, fps)
  await flush()
  assert.equal(videoB.dataset.clip, 'click', 'the reaction is now front, still playing')

  // A second click while it is still showing must be a complete no-op: the
  // `front.dataset.clip === name` guard in queueClip() returns immediately.
  const loadsBefore = h.calls.loadCalls.length
  const playsBefore = h.calls.playCalls.length
  h.api.click()
  assert.equal(h.calls.loadCalls.length, loadsBefore, 'the second click loads nothing')
  assert.equal(h.calls.playCalls.length, playsBefore, 'the second click plays nothing')

  // The real question is what the ALREADY-pending reaction request does once
  // decideNext() is consulted for the spare element: it must resolve to
  // idle, not select the reaction clip all over again.
  h.clock.fireAll()
  assert.equal(videoA.dataset.clip, 'idle', 'decideNext() must not queue the reaction again')
  assert.equal(h.calls.loadCalls.filter(c => c.clip === 'click').length, 1, 'the reaction was loaded exactly once in total')
})

test('dismiss() (a click outside her) closes an open bubble, and is harmless when none is open', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  await flush()

  h.api.dismiss()
  assert.equal(h.bubble.classList.contains('visible'), false)
  h.api.click()
  assert.equal(h.bubble.classList.contains('visible'), true, 'clicking her opens the quota bubble')
  h.api.dismiss()
  assert.equal(h.bubble.classList.contains('visible'), false, 'a click elsewhere closes it')
  h.api.click()
  assert.equal(h.bubble.classList.contains('visible'), true, 'and the next click on her opens it again, not a stale toggle')
})

test('the click message tells Swift whether the quota bubble just opened (so only an opening click refreshes the quota)', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  await flush()
  const clicks = () => h.messages.filter(m => m.type === 'click')
  h.api.click()
  assert.equal(clicks().at(-1).quota, true, 'opening click')
  h.api.click()
  assert.equal(clicks().at(-1).quota, false, 'closing click')
})

test('with the quota switched off (./pet.sh quota off) a click still gets her reaction, but no bubble', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  await flush()
  h.api.click()
  assert.equal(h.bubble.classList.contains('visible'), true, 'on by default')
  h.api.setQuotaEnabled(false)
  assert.equal(h.bubble.classList.contains('visible'), false, 'switching it off closes an open quota bubble')
  h.api.click()
  assert.equal(h.bubble.classList.contains('visible'), false, 'no bubble on click')
  assert.equal(h.messages.filter(m => m.type === 'click').at(-1).quota, false, 'so Swift asks for no refresh either')
  assert.equal(h.videoB.dataset.clip, 'click', 'the reaction is still queued')
  h.api.setQuotaEnabled(true)
  h.api.click()
  assert.equal(h.bubble.classList.contains('visible'), true, 'back on')
})

test('play() behind a clip that has not started yet waits its turn instead of replacing it (feet was lost to snap)', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  await flush()
  const fps = h.manifest.fps
  const { videoA, videoB } = h

  videoA.currentTime = 5 / fps
  h.api.play('feet')
  assert.equal(videoB.dataset.clip, 'feet')
  h.api.play('snap') // feet is still only queued: snap must not take its slot
  assert.equal(videoB.dataset.clip, 'feet', 'the queued pose is not overwritten')
  cueBack(videoB)
  deliverFrame(videoA, 38, fps)
  await flush()
  assert.equal(videoB.dataset.clip, 'feet', 'feet plays')

  h.clock.fireAll()
  assert.equal(videoA.dataset.clip, 'snap', 'snap is next, after feet')
  cueBack(videoA)
  const before = h.calls.playCalls.length
  deliverFrame(videoB, 67, fps) // feet.to(70) - LEAD(2) = 68: feet is not cut short
  assert.equal(h.calls.playCalls.length, before)
  deliverFrame(videoB, 68, fps)
  assert.equal(h.calls.playCalls.length, before + 1)
  await flush()
  assert.equal(videoA.dataset.clip, 'snap', 'snap follows once feet is done')
})

test('a click never swallows the pose that was already lined up next: it plays after the reaction', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  await flush()
  const fps = h.manifest.fps
  const { videoA, videoB } = h

  videoA.currentTime = 5 / fps
  h.api.play('feet')
  h.api.click()
  assert.equal(videoB.dataset.clip, 'click', 'the click reaction answers first')
  cueBack(videoB)
  deliverFrame(videoA, 38, fps)
  await flush()
  assert.equal(videoB.dataset.clip, 'click')

  h.clock.fireAll()
  assert.equal(videoA.dataset.clip, 'feet', 'the displaced pose is next, not lost')
  cueBack(videoA)
  deliverFrame(videoB, 44, fps)
  await flush()
  h.clock.fireAll()
  assert.equal(videoB.dataset.clip, 'idle', 'and idle follows the pose')
})

test('start({manifest}) uses the manifest the app hands over and never fetches (WKWebView cannot fetch file: URLs)', async () => {
  const h = createHarness()
  let fetched = 0
  // A fetch that fails the way WKWebView's does for a file: URL.
  const sandboxFetch = () => { fetched++; return Promise.reject(new TypeError('Load failed')) }
  h.setFetch(sandboxFetch)
  await h.api.start({ autoplay: true, reducedMotion: false, manifest: JSON.parse(JSON.stringify(h.manifest)) })
  await flush()
  assert.equal(fetched, 0)
  assert.ok(h.messages.some(message => message.type === 'ready'), 'ready is posted')
  assert.ok(!h.messages.some(message => message.type === 'error'), 'no error is posted')
})
