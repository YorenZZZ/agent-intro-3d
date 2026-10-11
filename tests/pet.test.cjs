// node --test tests/pet.test.cjs
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const pet = require('../Resources/web/pet/pet.js')
const petDir = path.join(__dirname, '..', 'Resources', 'web', 'pet')

// A small deterministic rng: returns each queued value once, then repeats
// the last one (so a test can under-supply values for calls it does not
// care about).
function queueRng(values) {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)]
}

// Same fixed pseudo-random stream intro.test.cjs's source (intro.js) uses,
// for a reproducible statistical sanity check.
function stream(seed) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

test('maskHit decodes the hex grid: row-major, MSB-first, dilated frame window', () => {
  const mask = { every: 10, cols: 4, rows: 4, frames: ['6F66', '0000', 'FFFF'] }
  // Entry 0 ("6F66"): row0=0110, row1=1111, row2=0110, row3=0110.
  assert.equal(pet.maskHit(mask, 0, 0.1, 0.1), false, 'row0 col0 is unset')
  assert.equal(pet.maskHit(mask, 0, 0.3, 0.1), true, 'row0 col1 is set')
  assert.equal(pet.maskHit(mask, 0, 0.6, 0.3), true, 'row1 is all set')
  assert.equal(pet.maskHit(mask, 0, 0.9, 0.9), false, 'row3 col3 is unset')
  // Entry 1 ("0000") and entry 2 ("FFFF") cover later frame windows: the
  // same (u, v) reads differently depending on which window the frame falls
  // in, not just on the pixel position.
  assert.equal(pet.maskHit(mask, 15, 0.6, 0.3), false, 'frame 15 falls in the all-unset window')
  assert.equal(pet.maskHit(mask, 25, 0.1, 0.1), true, 'frame 25 falls in the all-set window')
  // A frame index past the last window clamps to it rather than throwing.
  assert.equal(pet.maskHit(mask, 10000, 0.1, 0.1), true, 'out-of-range frame clamps to the last window')
  // Outside the unit frame, or with no mask at all, never hits.
  assert.equal(pet.maskHit(mask, 0, 1, 0.1), false, 'u=1 is outside the frame')
  assert.equal(pet.maskHit(mask, 0, -0.01, 0.1), false, 'negative u is outside the frame')
  assert.equal(pet.maskHit(null, 0, 0.5, 0.5), false, 'no mask never hits')
  assert.equal(pet.maskHit({ cols: 4, rows: 4, frames: [] }, 0, 0.5, 0.5), false, 'empty frames list never hits')
})

test('nextSafeFrame finds the next hand-over point, or the clip\'s end', () => {
  const clip = { from: 1, to: 118, safe: [1, 40, 80, 118] }
  assert.equal(pet.nextSafeFrame(clip, 0), 1)
  assert.equal(pet.nextSafeFrame(clip, 1), 1)
  assert.equal(pet.nextSafeFrame(clip, 2), 40)
  assert.equal(pet.nextSafeFrame(clip, 40), 40)
  assert.equal(pet.nextSafeFrame(clip, 41), 80)
  assert.equal(pet.nextSafeFrame(clip, 118), 118)
  // Past the last safe frame: the clip's end stands in, so a reaction
  // queued near the finish still gets a frame to aim at.
  assert.equal(pet.nextSafeFrame(clip, 119), 118)
  // Defensive: no clip at all just echoes `current` back.
  assert.equal(pet.nextSafeFrame(null, 7), 7)
})

test('pickNext: idle bias, the pose cooldown, no repeats, and poses/reactions always return to idle', () => {
  const clips = {
    idle: { kind: 'idle' }, sit: { kind: 'pose' }, feet: { kind: 'pose' }, snap: { kind: 'pose' },
    click: { kind: 'reaction' }, drone: { kind: 'ambient' }, // an unexpected kind: must be ignored
  }
  const now = 1000000

  // Below POSE_CHANCE: a pose, picked by the second roll.
  assert.equal(pet.pickNext({ lastKind: 'idle', lastPoseName: null, lastPoseAt: -Infinity }, clips, now, queueRng([0.29, 0])), 'sit')
  // At or above POSE_CHANCE: idle, and the pick roll is never consulted.
  assert.equal(pet.pickNext({ lastKind: 'idle', lastPoseName: null, lastPoseAt: -Infinity }, clips, now, queueRng([0.3])), 'idle')

  // The cooldown overrides even a roll that would otherwise pick a pose.
  assert.equal(pet.pickNext({ lastKind: 'idle', lastPoseName: null, lastPoseAt: now - 1000 }, clips, now, queueRng([0])), 'idle')
  assert.equal(pet.pickNext({ lastKind: 'idle', lastPoseName: null, lastPoseAt: now - pet.MIN_POSE_GAP }, clips, now, queueRng([0])), 'sit', 'the cooldown has just elapsed')

  // Never the same pose twice in a row.
  const repeat = pet.pickNext({ lastKind: 'idle', lastPoseName: 'sit', lastPoseAt: -Infinity }, clips, now, queueRng([0, 0]))
  assert.equal(repeat, 'feet')
  assert.notEqual(repeat, 'sit')

  // A pose or a reaction having just finished always falls back to idle,
  // even with a roll that would otherwise pick a pose.
  assert.equal(pet.pickNext({ lastKind: 'pose', lastPoseName: 'sit', lastPoseAt: now }, clips, now, queueRng([0, 0])), 'idle')
  assert.equal(pet.pickNext({ lastKind: 'reaction', lastPoseName: null, lastPoseAt: -Infinity }, clips, now, queueRng([0, 0])), 'idle')

  // Reaction clips are never picked here — reactions only ever start from a
  // click (ClaudePet.click()/play()), never from this idle-loop decision.
  for (let i = 0; i < 20; i++) {
    const seeded = stream(7 + i)
    const result = pet.pickNext({ lastKind: 'idle', lastPoseName: null, lastPoseAt: -Infinity }, clips, now, seeded)
    assert.ok(['idle', 'sit', 'feet', 'snap'].includes(result), `${result} is not click/drone/unknown`)
  }

  // An idle-only manifest never errors and never picks a pose.
  const idleOnly = { idle: { kind: 'idle' } }
  assert.equal(pet.pickNext({ lastKind: 'idle', lastPoseName: null, lastPoseAt: -Infinity }, idleOnly, now, queueRng([0, 0])), 'idle')

  // One pose, just played: the no-repeat rule leaves nothing to choose, so
  // it falls back to idle rather than repeating it.
  const onePose = { idle: { kind: 'idle' }, sit: { kind: 'pose' } }
  assert.equal(pet.pickNext({ lastKind: 'idle', lastPoseName: 'sit', lastPoseAt: -Infinity }, onePose, now, queueRng([0])), 'idle')
})

test('pickNext is biased toward idle over many draws (POSE_CHANCE ~= 0.3)', () => {
  const clips = { idle: { kind: 'idle' }, sit: { kind: 'pose' }, feet: { kind: 'pose' } }
  const rng = stream(20261011)
  let poses = 0
  const trials = 2000
  for (let i = 0; i < trials; i++) {
    if (pet.pickNext({ lastKind: 'idle', lastPoseName: null, lastPoseAt: -Infinity }, clips, 0, rng) !== 'idle') poses++
  }
  const rate = poses / trials
  assert.ok(rate > 0.2 && rate < 0.4, `pose rate ${rate} should sit near POSE_CHANCE (${pet.POSE_CHANCE})`)
})

test('formatReset: same day, another day, already past, and no reset time', () => {
  const now = new Date(2026, 9, 11, 16, 40, 0)
  assert.equal(pet.formatReset(new Date(2026, 9, 11, 16, 50, 0).toISOString(), now), '16:50 重置')
  assert.equal(pet.formatReset(new Date(2026, 9, 12, 8, 5, 0).toISOString(), now), '10月12日 08:05 重置')
  assert.equal(pet.formatReset(new Date(now.getTime() - 60000).toISOString(), now), '已重置，等待新数据')
  assert.equal(pet.formatReset(null, now), null)
  assert.equal(pet.formatReset(undefined, now), null)
  assert.equal(pet.formatReset('not a date', now), null)
})

test('formatQuota: remaining math, clamps, per-window lines, history note, and no data', () => {
  const now = new Date(2026, 9, 11, 16, 40, 0)
  const data = {
    source: 'session',
    updatedAt: now.toISOString(),
    windows: [
      { kind: 'five_hour', percentUsed: 34, resetsAt: new Date(2026, 9, 11, 16, 50, 0).toISOString() },
      { kind: 'seven_day', percentUsed: 8, resetsAt: new Date(2026, 9, 12, 8, 5, 0).toISOString() },
    ],
  }
  const result = pet.formatQuota(data, now)
  assert.equal(result.empty, false)
  assert.equal(result.header, '额度余量')
  assert.deepEqual(result.rows[0], { kind: 'five_hour', label: '5 小时额度', used: 34, remaining: 66, resetText: '16:50 重置', line: '已用 34% · 16:50 重置' })
  assert.equal(result.rows[1].label, '本周额度')
  assert.equal(result.rows[1].remaining, 92)
  assert.equal(result.rows[1].line, '已用 8% · 10月12日 08:05 重置')
  assert.equal(result.updatedText, '更新于 16:40')
  assert.equal(result.sourceNote, null)

  // Clamps: over 100% used and a negative reading both land in [0, 100].
  const clamped = pet.formatQuota({ source: 'session', updatedAt: now.toISOString(), windows: [{ kind: 'five_hour', percentUsed: 150 }, { kind: 'seven_day', percentUsed: -20 }] }, now)
  assert.equal(clamped.rows[0].used, 100)
  assert.equal(clamped.rows[0].remaining, 0)
  assert.equal(clamped.rows[0].line, '已用 100%', 'no resetsAt: no reset clause')
  assert.equal(clamped.rows[1].used, 0)
  assert.equal(clamped.rows[1].remaining, 100)

  // An unknown window kind falls back to showing it verbatim.
  const raw = pet.formatQuota({ source: 'session', updatedAt: now.toISOString(), windows: [{ kind: 'daily', percentUsed: 10 }] }, now)
  assert.equal(raw.rows[0].label, 'daily')

  // The history fallback has no reset times and needs its own footnote.
  const history = pet.formatQuota({
    source: 'history', updatedAt: now.toISOString(),
    windows: [{ kind: 'five_hour', percentUsed: 34 }, { kind: 'seven_day', percentUsed: 8 }],
  }, now)
  assert.equal(history.rows[0].line, '已用 34%')
  assert.equal(history.sourceNote, '（来自 Claude 用量记录，无重置时间）')

  assert.equal(pet.formatQuota(null, now).empty, true)
  assert.equal(pet.formatQuota(null, now).emptyText, '还没有额度数据：在 Claude Code 里对话一轮后就会更新。')
  assert.equal(pet.formatQuota({ windows: [] }, now).empty, true)

  // A missing or non-numeric percentage never prints NaN.
  const broken = pet.formatQuota({ source: 'session', updatedAt: now.toISOString(), windows: [{ kind: 'five_hour' }, { kind: 'seven_day', percentUsed: 'x' }] }, now)
  for (const row of broken.rows) {
    assert.equal(row.used, 0)
    assert.equal(row.remaining, 100)
    assert.doesNotMatch(row.line, /NaN/)
  }
})

test('escape: every interpolated string is escaped, once, for both the bubble and say()', () => {
  assert.equal(pet.escape('<b>"x"</b>'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt;')
  assert.equal(pet.escape("it's & that"), 'it&#39;s &amp; that')
  assert.equal(pet.escape(5), '5')
})

test('layoutBubble: anchored to her head, clamped inside the page, tail re-clamped with it', () => {
  const box = [0.30, 0.08, 0.70, 0.97]
  const centred = pet.layoutBubble({ box, frame: { left: 100, top: 50, width: 200, height: 267 }, width: 220, height: 90, pageWidth: 800, margin: 6 })
  assert.equal(centred.left, 90)
  assert.equal(centred.top, 6, 'pushed down to the top margin: the natural position was above the page')
  assert.equal(centred.tailX, 110)

  const atLeftEdge = pet.layoutBubble({ box, frame: { left: -50, top: 50, width: 200, height: 267 }, width: 220, height: 90, pageWidth: 800, margin: 6 })
  assert.equal(atLeftEdge.left, 6)
  assert.equal(atLeftEdge.tailX, 44, 'the tail still points at her head after the bubble was pushed right')

  const atRightEdge = pet.layoutBubble({ box, frame: { left: 700, top: 50, width: 200, height: 267 }, width: 220, height: 90, pageWidth: 800, margin: 6 })
  assert.equal(atRightEdge.left, 574)
  assert.equal(atRightEdge.tailX, 210, 'the tail clamps to the bubble\'s own edge, not past it')
})

test('layoutBubble: a `viewport` narrower than the page (the sidebar-clipped panel) reclamps inside it, not the whole page', () => {
  const box = [0.30, 0.08, 0.70, 0.97]
  // The panel/page is 800 wide (the full, unclipped virtual canvas -- see
  // Sources/pet.swift repositionWebView()), but only [20, 250] of it is
  // actually visible on screen, clipped to Claude's sidebar column.
  const viewport = { left: 20, top: 10, width: 230, height: 400 }
  const centred = pet.layoutBubble({ box, frame: { left: 100, top: 50, width: 200, height: 267 }, width: 220, height: 90, viewport, margin: 6 })
  // Natural centre (headX=200, width=220) would sit at left=90, well inside
  // the old 0..800 page bound but off the right edge of the 230-wide
  // viewport that starts at x=20 (visible range [26, 244]).
  assert.equal(centred.left, 26, 'clamped to the viewport\'s own left edge, not the page\'s')
  assert.equal(centred.top, 16, 'clamped to the viewport\'s own top margin (viewport.top + margin), not just margin')
  assert.equal(centred.tailX, 174, 'the tail still points at her head after the viewport reclamp')
})

// Static checks: nothing on HER draws a rim light, glow, outline or shadow
// (only the ground-contact ellipse, a background, not these properties), and
// no keyframe animates anything but opacity/transform — her motion comes
// only from the clips themselves. The one allowed exception is the speech
// bubble's own popover shadow (box-shadow only, on a `#bubble`/`.qp`
// selector) — a native Claude card reads flat without it, and it never
// touches her.
test('no rim light, glow, outline or filter on the character, keyframes only move/fade, and the bubble is the only thing with a shadow', () => {
  const files = ['pet.js', 'index.html', 'pet.css'].filter(name => fs.existsSync(path.join(petDir, name)))
  assert.ok(files.includes('pet.js') && files.includes('index.html'))
  for (const name of files) {
    const source = fs.readFileSync(path.join(petDir, name), 'utf8')
    for (const banned of ['filter:', 'drop-shadow', 'text-shadow']) {
      assert.ok(!source.includes(banned), `${name} must not contain "${banned}"`)
    }
    // box-shadow is scanned per CSS rule block (not as a whole-file
    // substring ban) so the bubble can have its one subtle popover shadow:
    // every OTHER rule that sets it must fail this assertion.
    const blockPattern = /([^{}]+)\{([^{}]*)\}/g
    let match
    while ((match = blockPattern.exec(source))) {
      const [, selector, body] = match
      if (!/box-shadow\s*:/.test(body)) continue
      assert.ok(/(^|[\s,])(#bubble|\.qp)\b/.test(selector), `${name}: box-shadow outside the bubble (selector "${selector.trim()}")`)
    }
    assert.ok(!/<animate/.test(source), `${name} must not use SMIL animation`)
    const keyframes = source.match(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g) || []
    for (const block of keyframes) {
      const properties = [...block.matchAll(/([a-z-]+)\s*:/g)].map(match => match[1])
      for (const property of properties) {
        assert.ok(['transform', 'opacity'].includes(property), `${name}: ${block.slice(0, 40)} animates ${property}`)
      }
    }
  }
})

test('the sample manifest tests load against is well-formed', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(petDir, 'clips', 'clips.sample.json'), 'utf8'))
  assert.equal(manifest.version, 1)
  assert.equal(manifest.clips.idle.kind, 'idle')
  const poses = Object.values(manifest.clips).filter(clip => clip.kind === 'pose')
  assert.equal(poses.length, 3)
  for (const name of Object.keys(manifest.clips)) {
    const clip = manifest.clips[name]
    assert.ok(clip.safe.includes(clip.from), `${name}: safe must include "from"`)
    assert.ok(clip.safe.includes(clip.to), `${name}: safe must include "to"`)
    assert.deepEqual(clip.safe, [...clip.safe].sort((a, b) => a - b), `${name}: safe must be sorted`)
  }
})

// ./pet.sh writes the app's own settings: same defaults domain as the
// bundle id build.sh signs with, and only keys pet.swift actually reads.
test('pet.sh talks to the same settings the app reads', () => {
  const root = path.join(__dirname, '..')
  const script = fs.readFileSync(path.join(root, 'pet.sh'), 'utf8')
  const build = fs.readFileSync(path.join(root, 'build.sh'), 'utf8')
  const swift = fs.readFileSync(path.join(root, 'Sources', 'pet.swift'), 'utf8')
  const domain = /^domain="([^"]+)"/m.exec(script)[1]
  assert.equal(domain, /^bundle_id="([^"]+)"/m.exec(build)[1], 'defaults domain is the bundle id')
  for (const key of ['petEnabled', 'petQuotaOnClick', 'petSnoozeUntil']) {
    assert.ok(script.includes(key), `pet.sh uses ${key}`)
    assert.ok(swift.includes(`"${key}"`), `pet.swift reads ${key}`)
  }
  assert.equal(fs.statSync(path.join(root, 'pet.sh')).mode & 0o111, 0o111, 'pet.sh is executable')
})

test('her first click after a launch shows the last quota reading, and a missing one never blanks it', () => {
  const swift = fs.readFileSync(path.join(__dirname, '..', 'Sources', 'pet.swift'), 'utf8')
  // The startup check runs before the page exists, so the page's own 'ready'
  // must get the newest reading on disk again, past the duplicate check.
  const ready = swift.match(/case "ready":[\s\S]*?evaluate\(\)/)[0]
  assert.match(ready, /lastQuotaSignature = "unset"\s*\n\s*checkQuota\(\)/, "'ready' re-sends the reading on disk")
  assert.ok(!/setQuota\(null\)/.test(swift), 'the app never sends an empty reading')
  const source = fs.readFileSync(path.join(petDir, 'pet.js'), 'utf8')
  assert.match(source, /function setQuota\(data\) \{\s*if \(!data\) return/, 'the page ignores an empty reading')
})
