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
    let frameId = 0
    const frameCallbacks = new Map()
    Object.assign(el, {
      src: '', currentTime: 0, paused: true, ended: false, seeking: false, readyState: 0, muted: false,
      load() { calls.loadCalls.push({ id, clip: el.dataset.clip }) },
      play() { calls.playCalls.push({ id, clip: el.dataset.clip }); el.paused = false; return Promise.resolve() },
      pause() { calls.pauseCalls.push({ id, clip: el.dataset.clip }); el.paused = true },
      _frameCallbacks: frameCallbacks,
      requestVideoFrameCallback(cb) { const id = ++frameId; frameCallbacks.set(id, cb); return id },
      cancelVideoFrameCallback(id) { frameCallbacks.delete(id) },
    })
  }
  if (tag === 'img') el.decode = () => Promise.resolve()
  return el
}

// Playback, fade and standing-hold timers run against a controllable clock.
function makeClock() {
  let nextId = 1
  let now = 1000000
  const timers = new Map()
  return {
    get now() { return now },
    setTimeout(fn, ms = 0) { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id },
    clearTimeout(id) { timers.delete(id) },
    fireAll() {
      for (const id of [...timers.keys()]) {
        const timer = timers.get(id)
        timers.delete(id)
        if (timer) timer.fn()
      }
    },
    advance(ms) {
      const until = now + ms
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, timer] = next
        timers.delete(id)
        now = timer.at
        timer.fn()
      }
      now = until
    },
  }
}

// A callback scheduled during a frame belongs to the next compositor frame,
// so a double rAF acknowledgement cannot accidentally complete in one step.
function makeAnimationFrames(clock) {
  let nextId = 1
  const callbacks = new Map()
  return {
    request(fn) { const id = nextId++; callbacks.set(id, fn); return id },
    cancel(id) { callbacks.delete(id) },
    capture() { return [...callbacks.values()] },
    step() {
      const pending = [...callbacks.values()]
      callbacks.clear()
      pending.forEach(fn => fn(clock.now))
    },
  }
}

function createHarness() {
  const calls = { loadCalls: [], playCalls: [], pauseCalls: [] }
  const messages = []
  const clock = makeClock()
  const raf = makeAnimationFrames(clock)
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
  sandbox.requestAnimationFrame = fn => raf.request(fn)
  sandbox.cancelAnimationFrame = id => raf.cancel(id)
  sandbox.webkit = { messageHandlers: { pet: { postMessage: msg => messages.push(msg) } } }
  sandbox.console = console
  sandbox.Date = class extends Date { static now() { return clock.now } }

  vm.createContext(sandbox)
  // Keep every idle-vs-pose dice roll on "idle" so only the clip under test
  // moves. `sandbox.Math` is only reachable from inside the context once a
  // script has run there, so this has to go through runInContext too.
  vm.runInContext('Math.random = () => 1', sandbox)
  vm.runInContext(petSource, sandbox, { filename: petPath })

  const setFetch = fetch => { sandbox.fetch = fetch }
  const setRandom = value => { vm.runInContext(`Math.random = () => ${Number(value)}`, sandbox) }
  return {
    api: sandbox.CodexPet, calls, messages, clock, raf, manifest: manifestData,
    videoA: elements.videoA, videoB: elements.videoB, poster: elements.poster, bubble: elements.bubble, setFetch, setRandom,
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
  const callbacks = [...video._frameCallbacks.values()]
  video._frameCallbacks.clear()
  callbacks.forEach(cb => cb(0, { mediaTime: video.currentTime }))
}

const paintedMessages = h => h.messages.filter(message => message.type === 'painted')

test('the poster is hidden for good after the first clip frame presents, so a later pose never shows a ghost of her neutral standing pose behind it (regression for the "double figure" bug)', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  await flush()
  const { videoA, poster } = h

  // Before the very first frame is actually presented, the poster must
  // still be showing — it is what covers the gap while the first video
  // fades in (see the stylesheet comment by #poster/.clip-video).
  assert.notEqual(poster.style.display, 'none', 'poster still covers the gap before the first frame presents')

  videoA.fire('playing') // playback state is not proof that a decoded frame was composited
  assert.equal(videoA.dataset.front, undefined, 'playing alone must not expose an undecoded video')
  deliverFrame(videoA, 0, h.manifest.fps)
  assert.equal(videoA.dataset.front, '', 'the first clip is front once its actual first frame is delivered')
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
  deliverFrame(videoA, 0, h.manifest.fps)
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

test("CodexPet.play('snap') -- a pose with an interior safe frame -- plays fully once and returns to idle", async () => {
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

test('a click during the outgoing fade cannot queue the pose that just finished for a second time', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  const { videoA, videoB } = h
  const fps = h.manifest.fps

  h.api.play('feet')
  cueBack(videoB)
  deliverFrame(videoA, h.manifest.clips.idle.to, fps)
  await flush()
  h.clock.advance(500)
  cueBack(videoA)
  deliverFrame(videoB, h.manifest.clips.feet.to, fps)
  await flush()
  assert.equal(videoA.dataset.front, '', 'feet has finished and idle is now front')

  // The old feet element remains underneath idle during the fade; it is
  // not an unplayed next action, even though its dataset still names feet.
  h.api.click()
  cueBack(videoB)
  deliverFrame(videoA, h.manifest.clips.idle.to, fps)
  await flush()
  h.clock.advance(500)
  assert.equal(videoB.dataset.clip, 'click', 'the requested reaction plays')
  assert.equal(videoA.dataset.clip, 'idle', 'the finished feet pose must not be resurrected behind the reaction')
  cueBack(videoA)
  deliverFrame(videoB, h.manifest.clips.click.to, fps)
  await flush()
  assert.equal(h.calls.playCalls.filter(call => call.clip === 'feet').length, 1)
})

test('successive random poses differ even across the intervening standing loops', async () => {
  const h = createHarness()
  h.setRandom(0)
  await h.api.start({ autoplay: true, reducedMotion: false })
  let front = h.videoA
  let back = h.videoB
  const poses = []

  for (let transition = 0; transition < 18 && poses.length < 6; transition++) {
    h.clock.advance(h.api.MIN_POSE_GAP + 1)
    cueBack(back)
    deliverFrame(front, h.manifest.clips[front.dataset.clip].to, h.manifest.fps)
    await flush()
    ;[front, back] = [back, front]
    if (h.manifest.clips[front.dataset.clip].kind === 'pose') {
      assert.notEqual(front.dataset.clip, poses.at(-1), 'standing between actions must not erase the previous pose')
      poses.push(front.dataset.clip)
    }
    h.clock.advance(500)
  }

  assert.equal(poses.length, 6, 'the test must actually play several random poses')
})

test('a fresh intro retains the last pose actually shown when selecting its first random action', async () => {
  const h = createHarness()
  h.setRandom(0)
  await h.api.start({ autoplay: true, reducedMotion: false })
  cueBack(h.videoB)
  deliverFrame(h.videoA, h.manifest.clips.idle.to, h.manifest.fps)
  await flush()
  assert.equal(h.videoB.dataset.clip, 'sit')
  assert.equal(h.videoB.dataset.front, '', 'sit has actually started, not merely been preloaded')

  h.api.setVisible(false)
  h.api.prepareForIntro()
  h.clock.advance(h.api.MIN_POSE_GAP + 1)
  h.api.setVisible(true)
  await flush()
  h.clock.advance(h.api.INTRO_IDLE_MS - 1)
  assert.equal(h.videoB.dataset.clip, 'idle', 'the complete five-second standing hold remains intact')
  h.clock.advance(1)
  assert.equal(h.videoB.dataset.clip, 'feet', 'the first eligible action excludes the pose shown before this intro')
  cueBack(h.videoB)
  deliverFrame(h.videoA, h.manifest.clips.idle.to, h.manifest.fps)
  await flush()
  assert.equal(h.videoB.dataset.front, '')
  assert.equal(h.calls.playCalls.filter(call => call.clip === 'sit').length, 1)
})

test('an explicit play request may repeat a pose after returning to standing', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  const { videoA, videoB } = h
  const fps = h.manifest.fps

  h.api.play('feet')
  cueBack(videoB)
  deliverFrame(videoA, h.manifest.clips.idle.to, fps)
  await flush()
  h.clock.advance(500)
  cueBack(videoA)
  deliverFrame(videoB, h.manifest.clips.feet.to, fps)
  await flush()
  h.clock.advance(500)

  h.api.play('feet')
  cueBack(videoB)
  deliverFrame(videoA, h.manifest.clips.idle.to, fps)
  await flush()
  assert.equal(videoB.dataset.front, '', 'explicit playback still takes over normally')
  assert.equal(videoB.dataset.clip, 'feet')
  assert.equal(h.calls.playCalls.filter(call => call.clip === 'feet').length, 2, 'the no-repeat rule only limits automatic choices')
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


test('a real quota bubble renders subscription rows and escapes labels', async () => {
  const h = createHarness()
  await h.api.start({ manifest: h.manifest, reducedMotion: true })
  h.api.setQuota({ source: 'codex', updatedAt: new Date().toISOString(), windows: [
    { label: '本周 <script>', percentRemaining: 99 },
  ] })
  h.api.click()
  assert.match(h.bubble.innerHTML, /Codex 订阅额度/)
  assert.match(h.bubble.innerHTML, /剩余 99%/)
  assert.match(h.bubble.innerHTML, /本周 &lt;script&gt;/)
  assert.match(h.bubble.innerHTML, /width:99%/)
  assert.doesNotMatch(h.bubble.innerHTML, /HolySheep|MiMo|<script>/)
})

test('an intro waits for the actual reveal, stands for five seconds, then allows the normal random next action', async () => {
  const h = createHarness()
  h.setRandom(0) // every permitted random roll selects sit
  h.api.prepareForIntro() // may arrive before start() on a cold launch
  await h.api.start({ autoplay: false, reducedMotion: false })
  assert.deepEqual(h.calls.loadCalls, [{ id: 'videoA', clip: 'idle' }, { id: 'videoB', clip: 'idle' }], 'both idle clips begin buffering while the intro owns the screen')
  cueBack(h.videoA)
  cueBack(h.videoB)
  h.clock.advance(20000) // buffering/intro time does not spend the standing hold
  assert.equal(h.calls.playCalls.length, 0)
  assert.equal(paintedMessages(h).length, 0, 'hidden prebuffering cannot release the landing overlay')

  h.api.setVisible(true)
  await flush()
  assert.equal(h.calls.loadCalls.length, 2, 'reveal reuses the buffered clips without another load')
  assert.equal(h.videoA.dataset.clip, 'idle')
  assert.equal(h.videoB.dataset.clip, 'idle')
  h.clock.advance(h.api.INTRO_IDLE_MS - 1)
  assert.equal(h.videoB.dataset.clip, 'idle', 'no random pose is even queued during the standing hold')
  h.clock.advance(1)
  assert.equal(h.videoB.dataset.clip, 'sit', 'normal random scheduling opens after five seconds')
  assert.ok(!h.calls.playCalls.some(call => call.clip === 'sit'), 'the next action still waits for idle to finish')
  cueBack(h.videoB)
  deliverFrame(h.videoA, h.manifest.clips.idle.to - h.api.LEAD, h.manifest.fps)
  await flush()
  assert.equal(h.videoB.dataset.front, '', 'the random pose begins at the idle boundary')
})

test('a short idle loop remains standing across multiple boundaries until the five-second intro hold expires', async () => {
  const h = createHarness()
  h.setRandom(0)
  await h.api.start({ autoplay: false, reducedMotion: false })
  h.api.prepareForIntro()
  h.api.setVisible(true)
  await flush()
  const boundary = h.manifest.clips.idle.to - h.api.LEAD
  cueBack(h.videoB)
  h.clock.advance(2000)
  deliverFrame(h.videoA, boundary, h.manifest.fps)
  await flush()
  h.clock.advance(500) // the spare clip is prepared after the crossfade
  assert.equal(h.videoA.dataset.clip, 'idle')
  cueBack(h.videoA)
  h.clock.advance(1499)
  deliverFrame(h.videoB, boundary, h.manifest.fps)
  await flush()
  h.clock.advance(500)
  assert.ok(h.calls.playCalls.every(call => call.clip === 'idle'), 'all playback before five seconds stays standing')
  h.clock.advance(501)
  assert.equal(h.videoB.dataset.clip, 'sit')
})

test('a new intro discards a previously seated pose and its queued actions, while ordinary hide/show preserves them', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  h.api.play('sit')
  cueBack(h.videoB)
  deliverFrame(h.videoA, h.manifest.clips.idle.to, h.manifest.fps)
  await flush()
  h.videoB.currentTime = 2
  h.api.setVisible(false)
  const beforeResume = h.calls.loadCalls.length
  h.api.setVisible(true)
  assert.equal(h.videoB.currentTime, 2, 'an ordinary show resumes the same pose frame')
  assert.equal(h.calls.loadCalls.length, beforeResume, 'ordinary show does not reload or reset clips')

  h.api.play('feet')
  h.api.play('snap')
  h.api.setVisible(false)
  h.api.prepareForIntro()
  assert.notEqual(h.poster.style.display, 'none', 'the standing poster covers the hidden reset')
  const afterReset = h.calls.loadCalls.length
  h.clock.advance(20000)
  assert.equal(h.calls.loadCalls.length, afterReset, 'old timers cannot refill the queue during the intro')
  h.api.setVisible(true)
  await flush()
  assert.equal(h.videoA.dataset.clip, 'idle')
  assert.equal(h.videoB.dataset.clip, 'idle')
  assert.equal(h.videoB.dataset.front, undefined, 'the old seated video is no longer front')
  assert.ok(h.calls.loadCalls.slice(afterReset).every(call => call.clip === 'idle'), 'no stale explicit action survives the entrance reset')
})

test('a handoff promise completed after an intro reset cannot restore the old pose or schedule more work', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  deliverFrame(h.videoA, 0, h.manifest.fps)
  let finishOldPlay
  h.videoB.play = () => {
    h.calls.playCalls.push({ id: 'videoB', clip: h.videoB.dataset.clip })
    h.videoB.paused = false
    return new Promise(resolve => { finishOldPlay = resolve })
  }
  h.api.play('sit')
  cueBack(h.videoB)
  deliverFrame(h.videoA, h.manifest.clips.idle.to, h.manifest.fps)
  assert.equal(typeof finishOldPlay, 'function', 'the old sit handoff is in flight')
  h.api.prepareForIntro()
  h.api.setVisible(true)
  deliverFrame(h.videoA, 0, h.manifest.fps)
  const loadsAfterReset = h.calls.loadCalls.length
  finishOldPlay()
  await flush()
  h.clock.advance(1000)
  assert.equal(h.videoA.dataset.front, '', 'new standing playback remains front')
  assert.equal(h.videoB.dataset.front, undefined, 'the stale promise cannot bring sit back')
  assert.equal(h.calls.loadCalls.length, loadsAfterReset, 'the stale promise cannot schedule a follow-up load')
})

test('a reset cancels the old first-frame poster timer and explicit clicks still respond during the standing hold', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  deliverFrame(h.videoA, 0, h.manifest.fps)
  h.api.prepareForIntro()
  h.clock.advance(1000)
  assert.notEqual(h.poster.style.display, 'none', 'the old fade completion cannot hide the reset poster')
  h.api.setVisible(true)
  h.api.click()
  assert.equal(h.videoB.dataset.clip, 'click', 'a user click is allowed immediately')
  cueBack(h.videoB)
  deliverFrame(h.videoA, h.manifest.clips.idle.to, h.manifest.fps)
  await flush()
  assert.equal(h.videoB.dataset.front, '', 'the explicit reaction plays within the five-second hold')
})

test('temporary occlusion during the intro standing hold does not restart its five-second clock', async () => {
  const h = createHarness()
  h.setRandom(0)
  await h.api.start({ autoplay: false, reducedMotion: false })
  h.api.prepareForIntro()
  h.api.setVisible(true)
  h.clock.advance(2000)
  h.api.setVisible(false)
  h.clock.advance(1000)
  h.api.setVisible(true)
  h.clock.advance(1999)
  assert.equal(h.videoB.dataset.clip, 'idle')
  h.clock.advance(1)
  assert.equal(h.videoB.dataset.clip, 'sit', 'the original reveal owns the deadline')
})

test('a slow first decoded frame keeps the landing overlay until the video fade and two compositor frames finish', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  h.videoA.fire('playing')
  h.api.setVisible(true) // a repeated native show is not a painted frame either
  h.clock.advance(1200)
  h.raf.step()
  h.raf.step()
  assert.equal(paintedMessages(h).length, 0, 'a decoder taking longer than 500 ms must not release the intro')
  assert.equal(h.videoA.dataset.front, undefined, 'the undecoded video stays transparent')
  assert.notEqual(h.poster.style.display, 'none', 'the poster still covers first-frame decoding')

  deliverFrame(h.videoA, h.manifest.clips.idle.from, h.manifest.fps)
  assert.equal(h.videoA.dataset.front, '', 'an actual presented video frame starts the fade')
  h.clock.advance(249)
  h.raf.step()
  h.raf.step()
  assert.equal(paintedMessages(h).length, 0, 'a presented frame alone does not end the CSS fade')
  assert.notEqual(h.poster.style.display, 'none')
  h.clock.advance(1)
  assert.equal(h.poster.style.display, 'none', 'the poster leaves after the 250 ms fade')
  assert.equal(paintedMessages(h).length, 0, 'the frame must also survive compositor scheduling')
  h.raf.step()
  assert.equal(paintedMessages(h).length, 0, 'one animation frame is not sufficient')
  h.raf.step()
  assert.equal(paintedMessages(h).length, 1, 'only the fully presented idle releases the landing overlay')
})

test('a warm intro starts buffering idle while hidden and preserves that buffer through reveal', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: false, reducedMotion: false })
  h.api.prepareForIntro()
  assert.equal(h.videoA.dataset.clip, 'idle')
  assert.equal(h.videoB.dataset.clip, 'idle')
  assert.equal(h.calls.loadCalls.length, 2)
  assert.equal(h.calls.playCalls.length, 0, 'preparation only loads/seeks, never advances the idle clip')
  cueBack(h.videoA)
  cueBack(h.videoB)
  assert.ok(h.videoA.currentTime >= h.manifest.clips.idle.from / h.manifest.fps && h.videoA.currentTime < (h.manifest.clips.idle.from + 1) / h.manifest.fps, 'metadata seeks the prebuffered front within its first used frame')
  const bufferedTime = h.videoA.currentTime
  h.clock.advance(20000)
  h.raf.step()
  h.raf.step()
  assert.equal(paintedMessages(h).length, 0)
  h.api.setVisible(true)
  await flush()
  assert.equal(h.calls.loadCalls.length, 2, 'reveal must not reset the decoder that was prepared during the intro')
  assert.equal(h.videoA.currentTime, bufferedTime)
  assert.equal(h.calls.playCalls.length, 1)
  assert.equal(h.calls.playCalls[0].clip, 'idle')
})

test('a first-frame callback delivered after hiding cannot paint, but resuming still waits for a fresh frame', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  const staleFrames = [...h.videoA._frameCallbacks.values()]
  h.api.setVisible(false)
  staleFrames.forEach(callback => callback(0, { mediaTime: 1 / h.manifest.fps }))
  h.videoA.fire('playing')
  h.clock.advance(1000)
  h.raf.step()
  h.raf.step()
  assert.equal(paintedMessages(h).length, 0)
  assert.equal(h.videoA.dataset.front, undefined, 'a delayed hidden frame cannot reveal an unready front')

  h.api.setVisible(true)
  h.raf.step()
  h.raf.step()
  assert.equal(paintedMessages(h).length, 0, 'showing again still needs an actual frame')
  deliverFrame(h.videoA, h.manifest.clips.idle.from, h.manifest.fps)
  h.clock.advance(250)
  h.raf.step()
  h.raf.step()
  assert.equal(paintedMessages(h).length, 1, 'the resumed clip can complete its fresh handshake')
})

test('an old first-frame callback cannot finish a new intro after a reset', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  const staleFrames = [...h.videoA._frameCallbacks.values()]
  h.api.prepareForIntro()
  h.api.setVisible(true)
  staleFrames.forEach(callback => callback(0, { mediaTime: 1 / h.manifest.fps }))
  h.clock.advance(1000)
  h.raf.step()
  h.raf.step()
  assert.equal(paintedMessages(h).length, 0, 'callbacks from the old entrance cannot release the new one')
  assert.equal(h.videoA.dataset.front, undefined)
  assert.notEqual(h.poster.style.display, 'none')

  deliverFrame(h.videoA, h.manifest.clips.idle.from, h.manifest.fps)
  h.clock.advance(250)
  h.raf.step()
  h.raf.step()
  assert.equal(paintedMessages(h).length, 1)
})

test('a hide or intro reset between compositor frames invalidates the pending painted acknowledgement', async () => {
  for (const change of ['hide', 'reset']) {
    const h = createHarness()
    await h.api.start({ autoplay: true, reducedMotion: false })
    deliverFrame(h.videoA, h.manifest.clips.idle.from, h.manifest.fps)
    h.clock.advance(250)
    h.raf.step()
    const staleCompositorCallbacks = h.raf.capture()
    assert.ok(staleCompositorCallbacks.length, 'the second compositor frame has been queued')
    if (change === 'hide') h.api.setVisible(false)
    else {
      h.api.prepareForIntro()
      h.api.setVisible(true)
    }
    staleCompositorCallbacks.forEach(callback => callback(h.clock.now))
    assert.equal(paintedMessages(h).length, 0, `${change} must invalidate the pending acknowledgement`)
  }
})

test('a first-frame fade finishing while hidden cannot release the landing overlay', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  deliverFrame(h.videoA, h.manifest.clips.idle.from, h.manifest.fps)
  h.clock.advance(249)
  h.api.setVisible(false)
  h.clock.advance(1000)
  h.raf.step()
  h.raf.step()
  assert.equal(paintedMessages(h).length, 0)
  h.api.setVisible(true)
  deliverFrame(h.videoA, h.manifest.clips.idle.from, h.manifest.fps)
  h.clock.advance(250)
  h.raf.step()
  h.raf.step()
  assert.equal(paintedMessages(h).length, 1, 'a subsequent visible frame can still release the intro')
})

test('reduced motion and a failed decoder acknowledge the visible poster after two compositor frames', async () => {
  for (const reducedMotion of [true, false]) {
    const h = createHarness()
    await h.api.start({ autoplay: true, reducedMotion })
    if (!reducedMotion) h.videoA.fire('error')
    assert.notEqual(h.poster.style.display, 'none', 'the poster is the visible fallback')
    assert.equal(paintedMessages(h).length, 0)
    h.raf.step()
    assert.equal(paintedMessages(h).length, 0)
    h.raf.step()
    assert.equal(paintedMessages(h).length, 1, `${reducedMotion ? 'reduced motion' : 'video failure'} must not strand the intro overlay`)
  }
})

test('the slow-decoder fallback confirms a painted poster without exposing an unready video', async () => {
  const h = createHarness()
  await h.api.start({ autoplay: true, reducedMotion: false })
  h.clock.advance(2000)
  h.raf.step()
  h.raf.step()
  assert.equal(paintedMessages(h).length, 0, 'elapsed time alone cannot prove that anything painted')
  h.api.confirmPosterPainted()
  assert.equal(h.videoA.dataset.front, undefined, 'the fallback keeps the undecoded video transparent')
  assert.notEqual(h.poster.style.display, 'none', 'the fallback keeps the standing poster visible')
  assert.equal(paintedMessages(h).length, 0)
  h.raf.step()
  assert.equal(paintedMessages(h).length, 0)
  h.raf.step()
  assert.equal(paintedMessages(h).length, 1, 'the explicit fallback still waits for the poster to paint')

  deliverFrame(h.videoA, h.manifest.clips.idle.from, h.manifest.fps)
  assert.equal(h.videoA.dataset.front, '', 'the eventual decoded video starts its normal fade')
  h.clock.advance(249)
  assert.notEqual(h.poster.style.display, 'none', 'the fallback poster continues to cover the fade')
  h.clock.advance(1)
  assert.equal(h.poster.style.display, 'none', 'normal playback takes over once the fade ends')
})
