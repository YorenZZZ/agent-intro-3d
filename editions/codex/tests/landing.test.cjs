// node --test tests/landing.test.cjs
// Exercise the browser runtime, including the actual prepare/play/seek paths.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const filename = path.join(__dirname, '..', 'Resources', 'web', 'intro.js')
const source = fs.readFileSync(filename, 'utf8')
const flush = () => new Promise(resolve => setImmediate(resolve))

function element(tag) {
  const listeners = new Map()
  const classes = new Set()
  const node = {
    tagName: tag.toUpperCase(), style: {}, dataset: {}, children: [], parentNode: null,
    classList: { add: name => classes.add(name), contains: name => classes.has(name) },
    addEventListener(type, fn, options = {}) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push({ fn, once: options.once })
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter(entry => entry.fn !== fn))
    },
    fire(type) {
      for (const entry of [...(listeners.get(type) || [])]) {
        if (entry.once) listeners.set(type, listeners.get(type).filter(item => item !== entry))
        entry.fn({ type, currentTarget: node })
      }
    },
    appendChild(child) {
      child.remove()
      node.children.push(child)
      child.parentNode = node
      return child
    },
    insertBefore(child, before) {
      child.remove()
      node.children.splice(node.children.indexOf(before), 0, child)
      child.parentNode = node
    },
    remove() {
      if (node.parentNode) node.parentNode.children.splice(node.parentNode.children.indexOf(node), 1)
      node.parentNode = null
    },
    replaceWith(child) {
      const parent = node.parentNode
      parent.insertBefore(child, node)
      node.remove()
    },
    querySelectorAll() { return [] },
  }
  Object.defineProperty(node, 'innerHTML', {
    set() { for (const child of [...node.children]) child.remove() },
  })
  return node
}

function createHarness({ videoFrames = true } = {}) {
  let now = 0
  let nextId = 1
  const timers = new Map()
  const rafs = new Map()
  const videos = []
  const images = []
  const messages = []
  const ids = Object.fromEntries(['stage', 'band', 'charSlot', 'charExit', 'escHint',
    'landingWrap', 'landingSlot', 'landingShadow'].map(id => [id, element('div')]))
  // Only the slots the runtime touches need a DOM implementation; the
  // browser's CSS animation and layout engines are outside this regression.
  ids.landingWrap.appendChild(ids.landingSlot)
  ids.landingWrap.appendChild(ids.landingShadow)
  ids.stage.querySelector = selector => {
    assert.equal(selector, '.moving')
    return ids.charSlot.appendChild(element('i'))
  }
  const doc = {
    body: element('body'), getElementById: id => ids[id] || null,
    getAnimations: () => [],
    createElement(tag) {
      const video = element(tag)
      assert.equal(tag, 'video')
      let currentTime = 0
      const frames = new Map()
      Object.assign(video, {
        duration: 4.67, readyState: 4, seeking: false, paused: true, playCalls: 0, pauseCalls: 0, seekCalls: [],
        load() {
          queueMicrotask(() => {
            video.fire('loadedmetadata')
            video.fire('canplaythrough')
          })
        },
        play() { video.paused = false; video.playCalls++; return Promise.resolve() },
        pause() { video.paused = true; video.pauseCalls++ },
        present(ms, currentMs = ms) {
          currentTime = currentMs / 1000
          const pending = [...frames.values()]
          frames.clear()
          for (const callback of pending) callback(now, { mediaTime: ms / 1000 })
          return pending
        },
      })
      Object.defineProperty(video, 'currentTime', {
        get: () => currentTime,
        set: value => {
          currentTime = value
          video.seeking = true
          video.seekCalls.push(value)
          queueMicrotask(() => {
            video.seeking = false
            video.fire('seeked')
          })
        },
      })
      if (videoFrames) video.requestVideoFrameCallback = callback => {
        const id = nextId++
        frames.set(id, callback)
        return id
      }
      videos.push(video)
      return video
    },
  }
  const clock = {
    advance(ms) {
      const until = now + ms
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [id, timer] = next
        timers.delete(id)
        now = timer.at
        timer.fn()
      }
      now = until
    },
    frame() {
      now += 16
      const pending = [...rafs.values()]
      rafs.clear()
      for (const callback of pending) callback(now)
    },
  }
  const sandbox = {
    document: doc, innerWidth: 1280, innerHeight: 800,
    performance: { now: () => now },
    setTimeout(fn, ms) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame(fn) { const id = nextId++; rafs.set(id, fn); return id },
    cancelAnimationFrame: id => rafs.delete(id),
    addEventListener() {}, matchMedia: () => ({ matches: false }),
    webkit: { messageHandlers: { intro: { postMessage: message => messages.push(message) } } },
    Image: function () {
      const image = element('img')
      image.decode = () => Promise.resolve()
      images.push(image)
      return image
    },
  }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename })
  const api = sandbox.CodexIntro
  const h = {
    api, doc, ids, messages, clock, images, videos,
    get clip() { return videos.find(video => video.src === api.CLIP) },
    get exit() { return videos.find(video => video.src === api.EXIT_CLIP) },
    get landing() { return videos.find(video => video.src === api.LANDING_CLIP) },
    async start(rect = { x: 37, y: 521, w: 193, h: 258 }) {
      await api.prepare()
      h.clip.duration = 12
      h.exit.duration = 2.4
      api.setPet(rect)
      await api.play(doc)
      clock.frame()
    },
    enterLanding() {
      clock.advance(api.HOLD_AT_MS)
      h.clip.fire('ended')
      h.exit.fire('ended')
      clock.advance(api.SCENE_CLOSE_MS)
      assert.equal(ids.landingWrap.style.display, 'block')
    },
    async seekLanding(ms) {
      const landingAt = api.CLIP_AT_MS + h.clip.duration * 1000 + h.exit.duration * 1000 + api.SCENE_CLOSE_MS
      const seeking = api.seek(landingAt + ms)
      // seek() waits for seeked and two browser paint opportunities.
      await flush()
      clock.frame()
      clock.frame()
      await seeking
    },
    paint(ms, currentMs) {
      h.landing.present(ms, currentMs)
      if (!videoFrames) clock.frame()
    },
    visibleState() {
      return {
        visible: h.landing.style.visibility !== 'hidden',
        shadow: Number(ids.landingShadow.style.opacity),
      }
    },
    landedCount() { return messages.filter(message => message === 'landed').length },
  }
  return h
}

test('the complete landing uses one buffered video at the latest pet rect', async () => {
  const h = createHarness()
  await h.start()
  const rect = { x: -11, y: 487, w: 197.25, h: 263.75 }
  h.api.setPet(rect)
  h.enterLanding()
  assert.equal(h.videos.filter(video => video.src === h.api.LANDING_CLIP).length, 1)
  assert.equal(h.landing.parentNode, h.ids.landingSlot)
  assert.equal(h.ids.landingSlot.children.length, 1)
  for (const [key, value] of Object.entries(h.api.landingLayout(rect))) {
    assert.equal(parseFloat(h.ids.landingWrap.style[key]), value)
  }
  assert.equal(h.landing.currentTime, 0)
  assert.deepEqual(h.landing.seekCalls, [], 'preparation must not cue past the landing pose')
  assert.deepEqual(h.visibleState(), { visible: true, shadow: 0 })
})

for (const videoFrames of [true, false]) {
  const timing = videoFrames ? 'video frame callback' : 'animation frame fallback'
  test(`touchdown and getting up play continuously until the actual end (${timing})`, async () => {
    const h = createHarness({ videoFrames })
    await h.start()
    h.enterLanding()
    assert.equal(h.landing.playCalls, 1)
    const initialPauses = h.landing.pauseCalls
    for (const ms of [600, 960, 1100, 1279, 1280, 1500, 2000, 2700, 3000, 4000, 4670]) {
      h.paint(ms)
      assert.equal(h.landing.currentTime, ms / 1000, `the source timeline remains continuous at ${ms}ms`)
      assert.deepEqual(h.landing.seekCalls, [], `no pose is skipped at ${ms}ms`)
      assert.equal(h.landing.pauseCalls, initialPauses, `no pose is cut short at ${ms}ms`)
      assert.equal(h.landing.paused, false)
      assert.equal(h.landing.playCalls, 1)
      assert.equal(h.visibleState().visible, true)
      assert.equal(h.landedCount(), 0, `no native handoff before ended at ${ms}ms`)
    }
    h.landing.fire('ended')
    assert.equal(h.landedCount(), 1, 'the full landing ends before the pet is revealed')
    assert.equal(h.landing.paused, true)
    h.landing.fire('ended')
    h.paint(600)
    assert.equal(h.landedCount(), 1, 'late callbacks cannot repeat the native handoff')
    assert.equal(h.visibleState().shadow, 1, 'late callbacks cannot rewind the completed shadow')
    assert.equal(h.landing.playCalls, 1)
  })

  test(`slow decoding cannot complete landing on wall-clock time (${timing})`, async () => {
    const h = createHarness({ videoFrames })
    await h.start()
    h.enterLanding()
    h.clock.advance(6000)
    h.paint(600, videoFrames ? 2000 : 600)
    assert.deepEqual(h.visibleState(), { visible: true, shadow: 0 }, 'shadow follows the presented media timestamp')
    assert.equal(h.landedCount(), 0)
    assert.equal(h.landing.paused, false)
    h.paint(2000)
    assert.equal(h.landedCount(), 0, 'touchdown remains part of the uninterrupted video')
    assert.deepEqual(h.landing.seekCalls, [])
  })

  test(`recordings seek the complete source timeline and match live shadows (${timing})`, async () => {
    const live = createHarness({ videoFrames })
    const recording = createHarness({ videoFrames })
    await Promise.all([live.start(), recording.start()])
    live.enterLanding()
    for (const ms of [0, 600, 960, 1100, 1240, 1279, 1280, 1500, 2000, 2700, 3000, 4000, 4670, 6000]) {
      live.paint(ms)
      await recording.seekLanding(ms)
      assert.deepEqual(recording.visibleState(), live.visibleState(), `same shadow at ${ms}ms`)
      assert.equal(recording.landing.currentTime, Math.min(recording.landing.duration, ms / 1000),
        `the source timeline includes touchdown and getting up at ${ms}ms`)
      assert.equal(recording.landing.paused, true)
    }
    assert.equal(recording.landing.playCalls, 0, 'frozen recordings never start the landing video')
    recording.landing.fire('ended')
    recording.clock.advance(6000)
    assert.equal(recording.landedCount(), 0, 'frozen recordings cannot trigger the native handoff')
  })

  test(`freezing during landing suppresses scheduled frame and ended callbacks (${timing})`, async () => {
    const h = createHarness({ videoFrames })
    await h.start()
    h.enterLanding()
    h.paint(1100)
    await h.seekLanding(1240)
    const frozenState = h.visibleState()
    h.paint(2000)
    h.landing.fire('ended')
    assert.deepEqual(h.visibleState(), frozenState, 'queued live frames cannot change the selected recording frame')
    assert.equal(h.landing.playCalls, 1)
    assert.equal(h.landing.paused, true)
    assert.equal(h.landedCount(), 0)
    await h.seekLanding(3000)
    h.landing.fire('ended')
    assert.equal(h.landedCount(), 0, 'getting-up frames are also safe to inspect without revealing the pet')
  })
}

test('the Esc hint stays hidden until native readiness and hides when readiness is revoked', async () => {
  const h = createHarness()
  await h.start()
  assert.equal(h.ids.escHint.hidden, true, 'playing alone does not imply that Codex is ready')
  h.api.setSkipEnabled(true)
  assert.equal(h.ids.escHint.hidden, false, 'native readiness makes the hint visible')
  h.api.setSkipEnabled(false)
  assert.equal(h.ids.escHint.hidden, true, 'lost readiness removes the hint')
})

test('native readiness received before play is applied to the inserted Esc hint', async () => {
  const h = createHarness()
  h.api.setSkipEnabled(true)
  await h.start()
  assert.equal(h.ids.escHint.hidden, false)
})

test('native readiness during the exit enables the Esc hint and revocation hides it', async () => {
  const h = createHarness()
  await h.start()
  assert.equal(h.ids.escHint.hidden, true)
  h.clip.fire('ended')
  h.api.setSkipEnabled(true)
  assert.equal(h.ids.escHint.hidden, false, 'late native readiness opens the hint during the exit jump')
  assert.equal(h.ids.escHint.classList.contains('off'), false, 'the exit must not leave the hint visually dismissed')
  h.api.setSkipEnabled(false)
  assert.equal(h.ids.escHint.hidden, true, 'revoked readiness still removes the hint during the exit')
})
