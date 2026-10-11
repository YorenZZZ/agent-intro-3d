// node --test tests/intro.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

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
  assert.ok(clip().length > 100000, 'the clip exists')
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

// Every shipped video is kept as parts (tools/clip-parts.sh): <name>.aa, .ab,
// ... plus <name>.sha256 under Resources/clip/.
const parts = path.join(__dirname, '..', 'Resources', 'clip')
const partsScript = fs.readFileSync(path.join(__dirname, '..', 'tools', 'clip-parts.sh'), 'utf8')
const shippedVideos = /clips=\(\n([\s\S]*?)\n\)/.exec(partsScript)[1].split('\n').map(line => line.trim()).filter(Boolean)
const joinedParts = base => Buffer.concat(fs.readdirSync(parts)
  .filter(name => name.startsWith(`${base}.`) && /\.[a-z]{2}$/.test(name) && name.length === base.length + 3).sort()
  .map(name => fs.readFileSync(path.join(parts, name))))
// Her clip, or (in a fresh clone, before build.sh joins it) its parts.
const clip = () => {
  const file = path.join(web, intro.CLIP)
  return fs.existsSync(file) ? fs.readFileSync(file) : joinedParts(path.basename(intro.CLIP))
}

test('every video in the repository is the one the app plays (parts + SHA-256 per video)', () => {
  assert.ok(shippedVideos.includes(intro.CLIP), 'her intro clip is one of them')
  for (const pet of ['idle', 'sit', 'feet', 'snap', 'click']) assert.ok(shippedVideos.includes(`pet/clips/${pet}.mov`), `pet clip ${pet}`)
  const bases = shippedVideos.map(rel => path.basename(rel))
  assert.equal(new Set(bases).size, bases.length, 'basenames are unique (the parts share one folder)')
  for (const rel of shippedVideos) {
    const base = path.basename(rel)
    const [sum, name] = fs.readFileSync(path.join(parts, `${base}.sha256`), 'utf8').trim().split(/\s+/)
    assert.equal(name, base, `${base}.sha256 names its own video`)
    const joined = joinedParts(base)
    assert.ok(joined.length > 0, `${base} has parts`)
    assert.equal(crypto.createHash('sha256').update(joined).digest('hex'), sum, `${base}: the parts are not the video: run tools/clip-parts.sh split`)
    const file = path.join(web, rel)
    if (fs.existsSync(file)) {
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), sum, `${rel} changed: run tools/clip-parts.sh split`)
    }
  }
})

test('the app waits as long as the page could possibly play (DURATION_MS, the pet path included)', () => {
  const swift = fs.readFileSync(path.join(__dirname, '..', 'Sources', 'main.swift'), 'utf8')
  const seconds = Number(/let durationSeconds = ([\d.]+)/.exec(swift)[1])
  assert.equal(Math.round(seconds * 1000), intro.DURATION_MS)
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8')
  const backdrop = /animation: backdrop ([\d.]+)s/.exec(html)
  assert.equal(Math.round(Number(backdrop[1]) * 1000), intro.DURATION_MS)
})

test('the backdrop times its fade to CORE_MS, not the longer pet-inclusive DURATION_MS', () => {
  // In by 0.2 s, out over the last 0.5 s before CORE_MS: the same moment
  // the plain ending's fade (and the pet ending's hand-off) runs, whether
  // or not DURATION_MS goes on to cover a pet ending afterward.
  const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8')
  const [inBy, outFrom] = [.../@keyframes backdrop \{ 0% \{ opacity: 0 \} ([\d.]+)% \{ opacity: 1 \} ([\d.]+)%/.exec(html)].slice(1).map(Number)
  assert.ok(Math.abs(inBy / 100 * intro.DURATION_MS - 200) < 1, 'the backdrop comes in by 0.2 s')
  assert.ok(Math.abs(outFrom / 100 * intro.DURATION_MS - (intro.CORE_MS - 500)) < 1, 'the backdrop starts its fade 0.5 s before CORE_MS')
  assert.ok(intro.CORE_MS < intro.DURATION_MS, 'CORE_MS leaves room afterward for the pet path')
})

test("her clip lasts until she leaves, at CORE_MS: the same moment the pet ending hands off", () => {
  // The clip's length, from its movie header (mvhd, version 0 or 1).
  const movie = clip()
  const at = movie.indexOf('mvhd')
  const v1 = movie[at + 4] === 1
  const timescale = movie.readUInt32BE(at + (v1 ? 24 : 16))
  const length = v1 ? Number(movie.readBigUInt64BE(at + 28)) : movie.readUInt32BE(at + 20)
  const ends = intro.CLIP_AT_MS + length / timescale * 1000
  // She leaves in the last 0.7 s: her clip plays into that, so she never
  // stands frozen before it, and it is not cut off long before its end.
  assert.ok(ends >= intro.CORE_MS - 700, `her clip ends at ${ends} ms, before she leaves`)
  assert.ok(ends <= intro.CORE_MS + 100, `her clip ends at ${ends} ms, after CORE_MS`)
})

test('DURATION_MS covers CORE_MS plus the exit and landing clips, with a little room', () => {
  const layers = path.join(web, 'layers')
  const mvhdSeconds = file => {
    const movie = fs.readFileSync(file)
    const at = movie.indexOf('mvhd')
    const v1 = movie[at + 4] === 1
    const timescale = movie.readUInt32BE(at + (v1 ? 24 : 16))
    const length = v1 ? Number(movie.readBigUInt64BE(at + 28)) : movie.readUInt32BE(at + 20)
    return length / timescale
  }
  const exitFile = path.join(layers, 'exit.mov')
  const landingFile = path.join(layers, 'landing.mov')
  if (!fs.existsSync(exitFile) || !fs.existsSync(landingFile)) return  // built by tools/build-transition.sh
  const total = intro.CORE_MS + mvhdSeconds(exitFile) * 1000 + intro.SCENE_CLOSE_MS + mvhdSeconds(landingFile) * 1000
  assert.ok(intro.DURATION_MS >= total, `DURATION_MS ${intro.DURATION_MS} is shorter than the pet path (${total.toFixed(0)} ms)`)
  assert.ok(intro.DURATION_MS <= total + 1000, `DURATION_MS ${intro.DURATION_MS} leaves more than 1 s of unexplained room`)
})

test('the pet path holds the scene before any of its closing keyframes, and resumes it where it held', () => {
  // The band's closing keyframes are placed end(s) before SPAN; the earliest
  // must not start before HOLD_AT_MS, or the held scene would freeze half
  // closed. Same for the backdrop, whose fade starts 0.5 s before CORE_MS.
  const source = fs.readFileSync(path.join(web, 'intro.js'), 'utf8')
  const span = intro.CORE_MS - 100
  const earliest = Math.max(...[...source.matchAll(/\bend\(([\d.]+)\)/g)].map(match => Number(match[1])))
  assert.ok(span - earliest * 1000 >= intro.HOLD_AT_MS - 1e-6, `a closing keyframe starts at ${span - earliest * 1000} ms, before HOLD_AT_MS`)
  assert.ok(intro.CORE_MS - 500 >= intro.HOLD_AT_MS, 'the backdrop fades before HOLD_AT_MS')
  assert.equal(intro.HOLD_AT_MS + intro.SCENE_CLOSE_MS, intro.CORE_MS)
  // Scene time: as normal, then still until she has left, then on from there.
  const releaseAt = 14400
  assert.equal(intro.sceneMs(5000, releaseAt), 5000)
  assert.equal(intro.sceneMs(intro.HOLD_AT_MS, releaseAt), intro.HOLD_AT_MS)
  assert.equal(intro.sceneMs(13000, releaseAt), intro.HOLD_AT_MS)
  assert.equal(intro.sceneMs(releaseAt + intro.SCENE_CLOSE_MS, releaseAt), intro.CORE_MS)
})

// --- setPet geometry (pure functions, no DOM) -----------------------------

test('landingLayout places landing.mov\'s canvas so its own pet sub-rect lands exactly on the given rect', () => {
  // The contract's clip frame is 3:4 (512x682); a real rect from setPet has
  // close to that ratio (clamped bbox height, same aspect throughout).
  for (const rect of [{ x: 0, y: 500, w: 195, h: 260 }, { x: 40, y: 700, w: 150, h: 200 }, { x: -10, y: 50, w: 225, h: 300 }]) {
    const { left, top, width, height } = intro.landingLayout(rect)
    // height solves LANDING_BOX.h of it back to rect.h; 9:16 throughout.
    assert.ok(Math.abs(height * intro.LANDING_BOX.h - rect.h) < 1e-9, 'height')
    assert.ok(Math.abs(width / height - 9 / 16) < 1e-9, 'width is 9:16 of height')
    // The sub-rect LANDING_BOX describes within that canvas (left/top/w/h,
    // all in the same window px as rect) lands on rect: left/top/bottom
    // exactly (x0 0, y0+h 1 by construction); width only approximately,
    // since LANDING_BOX.w is independent of rect's own 3:4 ratio (both are
    // measured, not derived from one another) and only coincide this
    // closely because the contract's own geometry is consistent.
    const subLeft = left + intro.LANDING_BOX.x * width
    const subTop = top + intro.LANDING_BOX.y * height
    const subW = intro.LANDING_BOX.w * width
    const subH = intro.LANDING_BOX.h * height
    assert.ok(Math.abs(subLeft - rect.x) < 1e-9, 'sub-rect left')
    assert.ok(Math.abs(subTop - rect.y) < 1e-9, 'sub-rect top')
    assert.ok(Math.abs(subW - rect.w) / rect.w < 0.01, 'sub-rect width within 1%')
    assert.ok(Math.abs(subTop + subH - (rect.y + rect.h)) < 1e-9, 'sub-rect bottom meets rect\'s own bottom')
  }
})

test('petShadowLayout centres the ellipse under her feet, matching pet.js\'s layoutShadow formula', () => {
  const rect = { x: 10, y: 600, w: 242, h: 260 }
  const { left, top, width, height } = intro.petShadowLayout(rect)
  const [x0, y0, x1, y1] = intro.PET_BOX
  assert.ok(Math.abs(width - (x1 - x0) * 1.25 * rect.w) < 1e-9, 'width is 125% of her bbox width (out to both boots)')
  assert.ok(Math.abs(height - width * 0.22) < 1e-9, 'height is 0.22 of the ellipse width')
  // pet.js's layoutShadow must use the very same proportions, or the
  // shadow visibly jumps when the landing hands over to the pet page.
  const petSrc = fs.readFileSync(path.join(web, 'pet', 'pet.js'), 'utf8')
  const body = /function layoutShadow\(\) \{[\s\S]*?\n  \}/.exec(petSrc)[0]
  assert.match(body, /\(x1 - x0\) \* 1\.25\b/, 'pet.js: same width')
  assert.match(body, /width \* 0\.22\b/, 'pet.js: same height')
  const cx = rect.x + (x0 + x1) / 2 * rect.w
  assert.ok(Math.abs(left + width / 2 - cx) < 1e-9, 'centred under her bbox')
  const feetY = rect.y + y1 * rect.h
  assert.ok(Math.abs(top + height / 2 - feetY) < 1e-9, 'vertically centred on her bbox\'s bottom edge')
})

test('the landing ellipse is the same themed gradient as the pet page\'s own #shadow, no glow or outline otherwise', () => {
  const markup = intro.introMarkup({ title: '下午好', line: '测试' }, true)
  assert.match(markup, /id="landingShadow"/, 'the ellipse exists')
  const petCss = fs.readFileSync(path.join(web, 'pet', 'index.html'), 'utf8')
  const introSrc = fs.readFileSync(path.join(web, 'intro.js'), 'utf8')
  const nums = s => [...s.matchAll(/[\d.]+/g)].map(Number)
  // Light: the landing ellipse has no :root of its own to inherit the pet
  // page's --ground-shadow from, so it falls back inline to the same value
  // (radial-gradient(...,var(--ground-shadow,LIGHT),...)).
  const introLight = /\.landingShadow\{[^}]*var\(--ground-shadow,(rgba\([^)]+\))\)/.exec(introSrc)[1]
  const petLight = /:root\s*\{[^}]*--ground-shadow:\s*(rgba\([^;]+\));/.exec(petCss)[1]
  assert.deepEqual(nums(introLight), nums(petLight), 'light ground shadow')
  // Dark: both declare --ground-shadow under the same media query, so the
  // landing ellipse's var(--ground-shadow) resolves to it the same way.
  const introDark = /@media \(prefers-color-scheme:dark\)\{:root\{--ground-shadow:(rgba\([^}]+)\)\}/.exec(introSrc)[1]
  const petDark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{[^}]*--ground-shadow:\s*(rgba\([^;]+)\);/.exec(petCss)[1]
  assert.deepEqual(nums(introDark), nums(petDark), 'dark ground shadow')
  // The gradient shape itself: closest-side, full strength out to 45% of
  // the radius, transparent at the rim -- the same stops on both pages.
  assert.match(introSrc, /\.landingShadow\{border-radius:50%;opacity:0;background:radial-gradient\(closest-side,var\(--ground-shadow,rgba\([^)]+\)\) 45%,rgba\(0,0,0,0\) 100%\)/)
  assert.match(petCss, /#shadow \{[^}]*radial-gradient\(closest-side, var\(--ground-shadow\) 45%, rgba\(0, 0, 0, 0\) 100%\)/)
})

// --- the two endings --------------------------------------------------------

test('without a pet rect, her clip keeps its .cexit fade (today\'s ending, unchanged)', () => {
  const markup = intro.introMarkup({ title: '下午好', line: '测试' }, true)
  assert.match(markup, /<div class="cexit" id="charExit">/, 'the character wrapper keeps its id for setPet to find')
  assert.match(markup, /@keyframes cexit\{0%,[^}]*opacity:1;transform:none\}[^}]*opacity:0;transform:scale\(1\.08\) translateX\(24px\)\}/, 'her fade-toward-camera keyframe is unchanged')
})

test('the pet ending\'s DOM exists but starts inert: hidden, and not yet carrying either clip', () => {
  const markup = intro.introMarkup({ title: '下午好', line: '测试' }, true)
  assert.match(markup, /\.landingWrap\{position:absolute;display:none\}/, 'landingWrap starts hidden')
  assert.match(markup, /id="landingSlot"/, 'a slot exists for the landing clip, mirroring #charSlot for the exit clip')
  assert.match(markup, /id="charSlot"/, '')
  assert.ok(!markup.includes('layers/exit.mov'), 'exit.mov is only ever attached by JS (loadClip), never baked into the markup')
  assert.ok(!markup.includes('layers/landing.mov'), 'same for landing.mov')
})

test('setPet is exported, and a usable rect is required to do anything', () => {
  assert.equal(typeof intro.setPet, 'function')
  // These must not throw even with nothing prepared (no DOM, no clips): a
  // bad or missing rect is simply ignored, same as never calling setPet.
  intro.setPet(null)
  intro.setPet({ x: 0, y: 0, w: 0, h: 0 })
  intro.setPet(undefined)
})

test('a cold launch still gets the pet ending: the app keeps re-sending her spot, the page takes a first one until just before her fade', () => {
  // On a real Claude launch the window is still settling at 'ready', so the
  // pet's rect is not known yet; a one-shot setPet there fell back to the
  // plain ending every time Claude quit and started as two separate events.
  assert.ok(intro.PET_CONFIRM_BY_MS < intro.HOLD_AT_MS, 'a first rect must arrive before her .cexit fade and the scene hold')
  assert.ok(intro.PET_CONFIRM_BY_MS >= intro.HOLD_AT_MS - 1000, 'the window must stay open long enough for a settling window')
  assert.equal(intro.petConfirmable(1500), true)
  assert.equal(intro.petConfirmable(intro.PET_CONFIRM_BY_MS), true)
  assert.equal(intro.petConfirmable(intro.PET_CONFIRM_BY_MS + 1), false)
  assert.equal(intro.petConfirmable(null), true, 'before play() any rect is taken')
  const swift = fs.readFileSync(path.join(__dirname, '..', 'Sources', 'main.swift'), 'utf8')
  assert.match(swift, /petFeed = Timer\.scheduledTimer\(withTimeInterval: 0\.25, repeats: true\)[^\n]*feedPetFrame\(\)/, 'the app re-sends the spot while she plays')
  assert.match(swift, /private func finish[\s\S]*?petFeed\?\.invalidate\(\)/, 'finish() stops re-sending')
})

test('EXIT_CLIP and LANDING_CLIP point at the layers tools/build-transition.sh writes', () => {
  assert.equal(intro.EXIT_CLIP, 'layers/exit.mov')
  assert.equal(intro.LANDING_CLIP, 'layers/landing.mov')
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'build-transition.sh'), 'utf8')
  assert.match(script, /exit\.mov/)
  assert.match(script, /landing\.mov/)
})

test('landing.mov ends on the pet poster at LANDING_BOX, and no clip bakes a shadow', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'tools', 'build-transition.sh'), 'utf8')
  // The poster dissolve is laid where the pet then shows it, or the instant
  // swap at 'landed' would jump.
  const rect = script.match(/--open-rect ([\d.]+),([\d.]+),([\d.]+),([\d.]+)/)
  assert.ok(rect, '--open-rect present')
  const box = intro.LANDING_BOX
  assert.deepEqual(rect.slice(1).map(Number), [box.x, box.y, box.w, box.h])
  assert.match(script, /--open-on "\$root\/Resources\/web\/pet\/clips\/poster\.png"/)
  // A shadow baked into her clip shows as a dark cast on her suit.
  assert.ok(!/^\s*--shadow\b/m.test(script), 'no --shadow in any build command')
})

test('nothing outlives the intro: the embers in front of her fade out with the backdrop', () => {
  const markup = intro.introMarkup({ title: '下午好', line: '测试' }, true)
  // .fx fades everything in it to nothing by the end.
  assert.match(markup, /<div class="fx"><i class="emf /, 'the front embers are inside .fx')
  assert.match(markup, /@keyframes fx\{[^}]*\}[^@]*100%\{opacity:0\}/, '.fx ends at opacity 0')
})

// Only Esc ends the intro early: the corner hint says so, the page has no
// click handler, and Swift's key monitor swallows every other key.
test('only Esc skips the intro: corner hint, no click-to-skip, other keys swallowed', () => {
  const markup = intro.introMarkup({ title: '下午好', line: '测试' }, true)
  assert.match(markup, /id="escHint"[\s\S]*按<span class="escKey">ESC<\/span>跳过/, 'the corner hint')
  const src = fs.readFileSync(path.join(web, 'intro.js'), 'utf8')
  assert.match(src, /\.escHint\{position:fixed;right:\d+px;top:\d+px;[^}]*pointer-events:none/, 'pinned to the top-right corner, never catching clicks')
  assert.match(src, /function handOff\(document\) \{[\s\S]*?hideEscHint\(document\)/, 'gone before she leaps out across that corner')
  const code = src.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n')
  assert.ok(!/mousedown|pointerdown|addEventListener\('click'|post\('skip'\)/.test(code), 'no click or pointer handler ends it')
  const swift = fs.readFileSync(path.join(__dirname, '..', 'Sources', 'main.swift'), 'utf8')
  const monitor = /keys = NSEvent\.addLocalMonitorForEvents\(matching: \.keyDown\)[\s\S]*?\n      \}/.exec(swift)[0]
  assert.match(monitor, /event\.keyCode == 53/, 'Esc ends it')
  assert.ok(!/return event/.test(monitor), 'no key is passed on')
  assert.ok(!/case "skip"/.test(swift), 'no page message skips it')
})
