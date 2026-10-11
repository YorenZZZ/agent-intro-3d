// node --test tests/intro.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const intro = require('../Resources/web/intro.js')
const web = path.join(__dirname, '..', 'Resources', 'web')

// CJK characters count 1, ASCII about half; the strip holds about 25.
const width = text => [...text].reduce((sum, char) => sum + (/[\x00-\x7f]/.test(char) ? 0.55 : 1), 0)

test('greets by the local hour', () => {
  const at = hour => intro.introText(new Date(2026, 9, 9, hour), () => 0).title
  assert.equal(at(7), '早上好')
  assert.equal(at(12), '中午好')
  assert.equal(at(15), '下午好')
  assert.equal(at(20), '晚上好')
  assert.equal(at(23), '夜深了')
  assert.equal(at(4), '夜深了')
})

test('picks a random line from the right pool', () => {
  const day = intro.introText(new Date(2026, 9, 9, 15), () => 0.999999)
  assert.equal(day.line, intro.LINES[intro.LINES.length - 1])
  const night = intro.introText(new Date(2026, 9, 9, 2), () => 0)
  assert.equal(night.line, intro.NIGHT_LINES[0])
  const seen = new Set(Array.from({ length: 400 }, () => intro.introText(new Date(2026, 9, 9, 15)).line))
  assert.equal(seen.size, intro.LINES.length)
})

test('every greeting fits its strip', () => {
  for (const line of [...intro.LINES, ...intro.NIGHT_LINES]) {
    assert.ok(width(line) <= 16, `${line} is too long`)
  }
})

test('the markup uses every baked layer and escapes the greeting', () => {
  const markup = intro.introMarkup({ title: '下午好', line: '<b>"x"</b>' })
  for (const name of ['body', 'drone', 'title-off', 'title', 'title-hot']) {
    assert.ok(markup.includes(`layers/${name}.webp`), name)
    assert.ok(fs.existsSync(path.join(web, 'layers', `${name}.webp`)), `${name}.webp exists`)
  }
  // Typed out a character at a time, each escaped on its own.
  const greeting = markup.match(/<div class="term greet">([\s\S]*?)<\/div>/)[1].replace(/<[^>]+>/g, '')
  assert.equal(greeting, '&gt;下午好。&lt;b&gt;&quot;x&quot;&lt;/b&gt;')
  assert.ok(!markup.includes('<b>'))
})

test('with her clip, the markup leaves a slot for it instead of the still', () => {
  const markup = intro.introMarkup({ title: '下午好', line: '测试' }, true)
  assert.equal((markup.match(/<i class="moving"><\/i>/g) || []).length, 1)
  assert.ok(markup.includes('layers/drone.webp'), 'drone')
  assert.ok(!markup.includes('layers/body.webp'), 'body only in the still fallback')
  assert.ok(fs.statSync(path.join(web, intro.CLIP)).size > 100000, 'the clip exists')
  const page = fs.readFileSync(path.join(web, 'index.html'), 'utf8')
  assert.match(page, /media-src 'self' file:/, 'the page may load the local clip')
})

test('only transforms and opacity are animated, never filters', () => {
  const markup = intro.introMarkup({ title: '下午好', line: '测试' })
  const keyframes = markup.match(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g)
  assert.ok(keyframes.length > 20)
  for (const block of keyframes) {
    const properties = [...block.matchAll(/([a-z-]+)\s*:/g)].map(match => match[1])
    for (const property of properties) {
      assert.ok(['transform', 'opacity', 'stroke-dashoffset'].includes(property), `${block.slice(0, 40)} animates ${property}`)
    }
  }
  assert.ok(!/<animate/.test(markup), 'no SMIL animation')
  assert.ok(!/feTurbulence|feDisplacementMap|feMorphology/.test(markup), 'no per-frame filters')
})

test('nothing is drawn around her and nothing cuts her off', () => {
  for (const moving of [false, true]) {
    const markup = intro.introMarkup({ title: '下午好', line: '测试' }, moving)
    assert.ok(!/mask-image/.test(markup), 'no mask fades or crops her')
    // No still outline of her either (afterimage, flash silhouette): it
    // cannot follow her clip, so it showed a second wrench and head.
    for (const name of ['shadow', 'hair', 'ghost', 'white']) assert.ok(!markup.includes(`layers/${name}.webp`), `no ${name} layer`)
    assert.ok(!/class="burst"/.test(markup), 'no glow behind her')
    // No light rays fanning out from behind her either (it read as a stage light).
    assert.ok(!/class="[^"]*\brays\b/.test(markup), 'no rays behind her')
    assert.ok(!/class="ghost/.test(markup), 'no afterimages')
  }
  for (const name of ['shadow', 'hair', 'ghost', 'white']) assert.ok(!fs.existsSync(path.join(web, 'layers', `${name}.webp`)), `${name}.webp is gone`)
  const clip = fs.readFileSync(path.join(__dirname, '..', 'tools', 'build-clip.py'), 'utf8')
  assert.ok(!/def with_rim|RIM =/.test(clip), 'the clip gets no rim light')
})

test('the lettering stays centred in any window; her whole movement fills it, never cut', () => {
  for (const [w, h] of [[1280, 800], [1152, 1024], [1600, 900], [1920, 1080], [3440, 1440], [900, 1400], [2560, 1440], [1152, 2048], [1000, 700]]) {
    const { scale, left, top, grow, rise, sides } = intro.layout(w, h)
    const bandTop = (h - 300 * scale) / 2 + top * scale
    const bandLeft = (w - 800 * scale) / 2 + left * scale
    const y = band => bandTop + band * scale
    const x = band => bandLeft + band * scale
    const her = v => -37 + (v + 37) * grow - rise
    // The middle of the lettering (y 168) is the middle of the window.
    assert.ok(Math.abs(y(168) - h / 2) < 0.5, `${w}x${h}: lettering off centre`)
    // The wrench lifted overhead (PEAK, measured on her clip) stays inside the window's top.
    assert.ok(y(her(intro.PEAK)) >= 0, `${w}x${h}: the wrench leaves the window`)
    // Her thighs (y 563) reach the bottom edge; her box's bottom edge (y 577) never shows.
    assert.ok(y(her(563)) >= h - 0.5, `${w}x${h}: her thighs do not reach the bottom`)
    assert.ok(y(her(577)) >= h - 0.5, `${w}x${h}: her bottom edge shows`)
    if (w / h < 1.3) assert.ok(y(her(intro.PEAK)) < 0.06 * h || grow === 1.35, `${w}x${h}: room left above the wrench`)
    // She stands 1.15 times the lettering's size (the size chosen), more only
    // where the window is too narrow for that.
    assert.ok(grow >= 1.15 - 1e-9 && grow <= 1.35, `${w}x${h}: grow ${grow}`)
    // Her furthest reach (RIGHT at grow 1, from x 855) and the data columns stay on screen.
    assert.ok(x(855 + (intro.RIGHT - 855) * grow) <= w, `${w}x${h}: her elbow is cut`)
    // The data columns and the lettering, moved left of her lifted wrench (x -144 on).
    assert.ok(x(-144) >= -0.5, `${w}x${h}: the left side is cut`)
    assert.ok(Math.abs(x(sides[0])) < 0.5 && Math.abs(x(sides[1]) - w) < 0.5, `${w}x${h}: sides`)
  }
})

test('the app waits as long as the page plays, and her clip lasts until she leaves', () => {
  const swift = fs.readFileSync(path.join(__dirname, '..', 'Sources', 'main.swift'), 'utf8')
  const seconds = Number(/let durationSeconds = ([\d.]+)/.exec(swift)[1])
  assert.equal(Math.round(seconds * 1000), intro.DURATION_MS)
  // The page's backdrop: in by 0.2 s, out over the last 0.5 s.
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8')
  const backdrop = /animation: backdrop ([\d.]+)s/.exec(html)
  assert.equal(Math.round(Number(backdrop[1]) * 1000), intro.DURATION_MS)
  const [inBy, outFrom] = [.../@keyframes backdrop \{ 0% \{ opacity: 0 \} ([\d.]+)% \{ opacity: 1 \} ([\d.]+)%/.exec(html)].slice(1).map(Number)
  assert.ok(Math.abs(inBy / 100 * intro.DURATION_MS - 200) < 1, 'the backdrop comes in by 0.2 s')
  assert.ok(Math.abs((1 - outFrom / 100) * intro.DURATION_MS - 500) < 1, 'the backdrop goes over the last 0.5 s')
  // The clip's length, from its movie header (mvhd, version 0 or 1).
  const movie = fs.readFileSync(path.join(web, intro.CLIP))
  const at = movie.indexOf('mvhd')
  const v1 = movie[at + 4] === 1
  const timescale = movie.readUInt32BE(at + (v1 ? 24 : 16))
  const length = v1 ? Number(movie.readBigUInt64BE(at + 28)) : movie.readUInt32BE(at + 20)
  const ends = intro.CLIP_AT_MS + length / timescale * 1000
  // She leaves in the last 0.7 s: her clip plays into that, so she never
  // stands frozen before it, and it is not cut off long before its end.
  assert.ok(ends >= intro.DURATION_MS - 700, `her clip ends at ${ends} ms, before she leaves`)
  assert.ok(ends <= intro.DURATION_MS + 100, `her clip ends at ${ends} ms, after the intro`)
})

test('nothing outlives the intro: the embers in front of her fade out with the backdrop', () => {
  const markup = intro.introMarkup({ title: '下午好', line: '测试' }, true)
  // .fx fades everything in it to nothing by the end.
  assert.match(markup, /<div class="fx"><i class="emf /, 'the front embers are inside .fx')
  assert.match(markup, /@keyframes fx\{[^}]*\}[^@]*100%\{opacity:0\}/, '.fx ends at opacity 0')
})
