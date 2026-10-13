'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const petDir = path.join(__dirname, '..', 'Resources', 'web', 'pet')
const api = require(path.join(petDir, 'pet.js'))
const lines = require(path.join(petDir, 'chatter-lines.js'))
const manifest = JSON.parse(fs.readFileSync(path.join(petDir, 'clips', 'clips.sample.json'), 'utf8'))

function listenable() {
  const listeners = new Map()
  return {
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]) },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn)) },
    fire(type, fields = {}) { for (const fn of listeners.get(type) || []) fn({ type, ...fields }) },
  }
}

function element(id) {
  const classes = new Set()
  const tail = { style: {} }
  const el = Object.assign({
    style: { setProperty(name, value) { this[name] = value } },
    dataset: {}, innerHTML: '',
    classList: {
      add(...names) { names.forEach(name => classes.add(name)) },
      remove(...names) { names.forEach(name => classes.delete(name)) },
      contains(name) { return classes.has(name) },
      toggle(name, force) {
        const add = force === undefined ? !classes.has(name) : force
        if (add) classes.add(name); else classes.delete(name)
        return add
      },
    },
    querySelector(selector) { return selector === '.tail' ? tail : null },
    decode() { return Promise.resolve() },
    pause() {},
  }, listenable())
  el.getBoundingClientRect = () => {
    const left = id === 'frame' ? 160 : parseFloat(el.style.left) || 0
    const top = id === 'frame' ? 140 : parseFloat(el.style.top) || 0
    const width = id === 'frame' ? 120 : 200
    const height = id === 'frame' ? 160 : 64
    return { left, top, width, height, right: left + width, bottom: top + height }
  }
  return el
}

function clock() {
  let now = 1000000
  let serial = 0
  const timers = new Map()
  return {
    get now() { return now },
    setTimeout(fn, delay = 0) { const id = ++serial; timers.set(id, { at: now + delay, fn }); return id },
    clearTimeout(id) { timers.delete(id) },
    get size() { return timers.size },
    advance(ms) {
      const until = now + ms
      let calls = 0
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        assert.ok(++calls < 1000, 'timers must not spin without advancing the clock')
        const [id, timer] = next
        timers.delete(id)
        now = timer.at
        timer.fn()
      }
      now = until
    },
  }
}

async function harness({ autoplay = true, withLines = true } = {}) {
  const time = clock()
  const messages = []
  const elements = Object.fromEntries(['frame', 'poster', 'shadow', 'bubble', 'videoA', 'videoB'].map(id => [id, element(id)]))
  const sandbox = Object.assign({
    document: Object.assign({
      documentElement: element('html'), body: element('body'),
      getElementById(id) { return elements[id] || null },
    }, listenable()),
    innerWidth: 440, innerHeight: 360,
    setTimeout: (...args) => time.setTimeout(...args),
    clearTimeout: id => time.clearTimeout(id),
    Date: class extends Date { static now() { return time.now } },
    webkit: { messageHandlers: { pet: { postMessage(message) { messages.push(message) } } } },
    console,
  }, listenable())
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext('Math.random = () => 0', sandbox)
  if (withLines) vm.runInContext(fs.readFileSync(path.join(petDir, 'chatter-lines.js'), 'utf8'), sandbox)
  vm.runInContext(fs.readFileSync(path.join(petDir, 'pet.js'), 'utf8'), sandbox)
  await sandbox.CodexPet.start({ manifest: structuredClone(manifest), reducedMotion: true, autoplay })
  assert.equal(messages.some(message => message.type === 'error'), false)
  const bubble = elements.bubble
  return {
    api: sandbox.CodexPet, time, bubble, messages, root: sandbox,
    visible: () => bubble.classList.contains('visible'),
    isQuota: () => bubble.innerHTML.includes('Codex 订阅额度'),
  }
}

test('the mechanic has exactly 100 nonempty, unique lines', () => {
  assert.equal(lines.length, 100)
  assert.ok(lines.every(line => typeof line === 'string' && line.trim() === line && line.length > 0))
  assert.equal(new Set(lines).size, 100)
})

test('random chatter waits between 45 and 90 seconds, including the boundary rolls', () => {
  assert.equal(api.CHATTER_MIN_MS, 45000)
  assert.equal(api.CHATTER_MAX_MS, 90000)
  assert.equal(api.CHATTER_SECONDS, 7)
  assert.equal(api.randomChatterDelay(() => 0), 45000)
  assert.equal(api.randomChatterDelay(() => 1), 90000)
  for (const value of [0.01, 0.25, 0.5, 0.75, 0.999999]) {
    const delay = api.randomChatterDelay(() => value)
    assert.ok(delay >= 45000 && delay <= 90000)
  }
})

test('a shuffle bag visits every line before repeating and avoids adjacent repeats across bags', () => {
  for (const roll of [0, 0.5, 0.999999]) {
    const pick = api.createChatterPicker(lines, () => roll)
    const first = Array.from({ length: 100 }, () => pick())
    const second = Array.from({ length: 100 }, () => pick())
    assert.deepEqual(new Set(first), new Set(lines))
    assert.deepEqual(new Set(second), new Set(lines))
    assert.notEqual(first.at(-1), second[0])
  }
})

test('reduced-motion pets still show one static line for 7 seconds, then wait afresh', async () => {
  const h = await harness()
  h.time.advance(44999)
  assert.equal(h.visible(), false)
  h.time.advance(1)
  assert.equal(h.visible(), true)
  assert.equal(h.isQuota(), false)
  h.time.advance(6999)
  assert.equal(h.visible(), true)
  h.time.advance(1)
  assert.equal(h.visible(), false)
  h.time.advance(44999)
  assert.equal(h.visible(), false)
  h.time.advance(1)
  assert.equal(h.visible(), true)
})

test('hidden time never accumulates toward the next line; reveal starts a fresh interval', async () => {
  const h = await harness()
  h.time.advance(44000)
  h.api.setVisible(false)
  h.time.advance(180000)
  assert.equal(h.visible(), false)
  assert.equal(h.api.chatter(), false, 'preview cannot show on a hidden pet')
  h.api.setVisible(true)
  h.time.advance(44999)
  assert.equal(h.visible(), false)
  h.time.advance(1)
  assert.equal(h.visible(), true)
  h.api.setVisible(false)
  assert.equal(h.visible(), false, 'hiding clears a currently visible line too')
})

test('repeated visible notifications do not postpone the next line forever', async () => {
  const h = await harness()
  h.time.advance(20000)
  h.api.setVisible(true)
  h.time.advance(20000)
  h.api.setVisible(true)
  h.time.advance(5000)
  assert.equal(h.visible(), true)
})

test('intro preparation cancels speech until the pet is revealed after landing', async () => {
  const h = await harness()
  assert.equal(h.api.chatter(), true)
  h.api.prepareForIntro()
  assert.equal(h.visible(), false)
  h.time.advance(180000)
  assert.equal(h.visible(), false)
  h.api.setVisible(true)
  h.time.advance(5000)
  assert.equal(h.visible(), false, 'the standing hold is quiet')
  h.time.advance(40000)
  assert.equal(h.visible(), true)
})

test('quota replaces chatter immediately and retains its own full lifetime', async () => {
  const h = await harness()
  assert.equal(h.api.chatter(), true)
  assert.equal(h.bubble.classList.contains('chatter'), true)
  h.api.showQuota()
  assert.equal(h.visible(), true)
  assert.equal(h.isQuota(), true)
  assert.equal(h.bubble.classList.contains('chatter'), false, 'quota switches back to its own appearance')
  assert.equal(h.api.chatter(), false, 'speech never replaces quota')
  h.time.advance(7000)
  assert.equal(h.visible(), true, 'the previous chatter timeout cannot hide quota')
  h.time.advance(1000)
  assert.equal(h.visible(), false)
  h.time.advance(44999)
  assert.equal(h.visible(), false)
  h.time.advance(1)
  assert.equal(h.visible(), true)
  assert.equal(h.isQuota(), false)
})

test('hover cannot keep chatter visible, but a hovered quota stays readable without interruptions', async () => {
  const h = await harness()
  h.api.chatter()
  h.bubble.fire('mouseenter')
  h.time.advance(7000)
  assert.equal(h.visible(), false)
  h.api.showQuota()
  h.bubble.fire('mouseenter')
  h.time.advance(180000)
  assert.equal(h.visible(), true)
  assert.equal(h.isQuota(), true)
  h.bubble.fire('mouseleave')
  h.time.advance(8000)
  assert.equal(h.visible(), false)
  h.time.advance(45000)
  assert.equal(h.visible(), true)
  assert.equal(h.isQuota(), false)
})

test('clicking her while she talks opens quota on the first click', async () => {
  const h = await harness()
  h.api.chatter()
  h.api.click()
  assert.equal(h.visible(), true)
  assert.equal(h.isQuota(), true)
  assert.equal(h.messages.at(-1).quota, true)
})

test('manual speech also has priority and random speech resumes after dismissal', async () => {
  const h = await harness()
  h.time.advance(44000)
  h.api.say('先把这颗小螺丝递给我。', 120)
  h.time.advance(90000)
  assert.equal(h.visible(), true)
  assert.ok(h.bubble.innerHTML.includes('先把这颗小螺丝递给我。'))
  assert.equal(h.api.chatter(), false)
  h.api.dismiss()
  h.time.advance(44999)
  assert.equal(h.visible(), false)
  h.time.advance(1)
  assert.equal(h.visible(), true)
})

test('the chatter bubble passes mouse input through, while quota remains interactive', async () => {
  const h = await harness()
  h.api.chatter()
  const rect = h.bubble.getBoundingClientRect()
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  h.api.pointer(null, null)
  h.api.pointer(x, y)
  assert.equal(h.messages.at(-1).inside, false)
  h.api.showQuota()
  h.api.pointer(x, y)
  assert.equal(h.messages.at(-1).inside, true)
})

test('a clipped viewport hides chatter instead of forcing it over the character', async () => {
  const h = await harness()
  h.api.chatter()
  assert.equal(h.visible(), true)
  h.api.setViewport({ left: 0, top: 130, width: 440, height: 230 })
  assert.equal(h.visible(), false, '64px speech cannot fit above her head in 23px of visible space')
  assert.equal(h.api.chatter(), false)
  h.api.setViewport({ left: 0, top: 0, width: 100, height: 360 })
  assert.equal(h.api.chatter(), false, 'speech must also fit horizontally')
  h.api.setViewport({ left: 0, top: 0, width: 440, height: 360 })
  assert.equal(h.api.chatter(), true)
})

test('no line library means no speech timers, and a non-autoplay page stays quiet', async () => {
  const absent = await harness({ withLines: false })
  assert.equal(absent.time.size, 0)
  absent.time.advance(180000)
  assert.equal(absent.visible(), false)
  const hidden = await harness({ autoplay: false })
  assert.equal(hidden.time.size, 0)
  hidden.time.advance(180000)
  assert.equal(hidden.visible(), false)
  hidden.api.setVisible(true)
  hidden.time.advance(45000)
  assert.equal(hidden.visible(), true)
})
