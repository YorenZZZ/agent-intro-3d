// The desktop pet: the same 3D girl mechanic, full body, standing in the
// blank area at the bottom of Claude's left sidebar. She is alive only
// through short generated clips that all start and end on the same neutral
// pose (clips/poster.png): an idle loop, and occasionally one of a few pose
// clips (sit, feet, snap), picked at random; a click plays a reaction clip
// and shows a quota speech bubble. Her motion comes only from the clips —
// nothing here translates, bobs or tilts her whole figure — so the engine's
// only job is to chain clips together without a visible seam.
//
// The hand-over machinery (double-buffered <video> elements, cueing the back
// one on its first used frame while paused, watching the front one's
// presented frames via requestVideoFrameCallback, crossfading once the back
// is cued) is ported from the DeepSeek skin's hero-runtime.ts, which solves
// the same problem (alpha clips that must loop and chain with no seam). The
// one addition here is the "safe frame" interrupt: a click should not wait
// for the current clip to finish before reacting, so when a reaction is
// queued we re-aim the hand-over at the nearest safe frame (clips.json
// `safe`) instead of the clip's natural end.
//
// Loadable two ways, like intro.js: as window.ClaudePet in the WKWebView
// page, or via module.exports for the node test suite (which never touches
// the DOM — every DOM access lives inside a function body, never at load
// time).
;(function (root) {
  'use strict'

  // How often an idle pass is followed by a pose, how long to wait between
  // poses, how many frames early the next clip is started (covers the time
  // play() takes to get going), and the crossfade length (matches the
  // `transition` durations below).
  const POSE_CHANCE = 0.3
  const MIN_POSE_GAP = 25000
  const LEAD = 2
  const BLEND = 0.2
  const BUBBLE_SECONDS = 8
  const BUBBLE_MARGIN = 6

  const QUOTA_HEADER = '额度余量'
  const NO_DATA_TEXT = '还没有额度数据：在 Claude Code 里对话一轮后就会更新。'
  const KIND_LABELS = { five_hour: '5 小时额度', seven_day: '本周额度' }

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  const escape = text => String(text).replace(/[&<>"']/g, char => ESCAPES[char] || char)

  const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))
  const pad2 = value => String(value).padStart(2, '0')

  // ---------------------------------------------------------------------
  // Pure helpers: no DOM, so the node test suite can drive them directly.
  // ---------------------------------------------------------------------

  // Decodes one hit-test cell from clips.json's `mask`: entry k covers
  // frames [k*every, (k+1)*every), each a cols*rows bit grid, row-major,
  // each hex digit holding 4 consecutive cells MSB-first. u, v are 0..1 of
  // the whole clip frame.
  function maskHit(mask, frameIndex, u, v) {
    if (!mask || !Array.isArray(mask.frames) || !mask.frames.length) return false
    if (!(u >= 0) || !(v >= 0) || u >= 1 || v >= 1) return false
    const cols = mask.cols | 0
    const rows = mask.rows | 0
    if (!cols || !rows) return false
    const every = mask.every > 0 ? mask.every : 1
    const entry = clamp(Math.floor(frameIndex / every), 0, mask.frames.length - 1)
    const hex = mask.frames[entry] || ''
    const col = clamp(Math.floor(u * cols), 0, cols - 1)
    const row = clamp(Math.floor(v * rows), 0, rows - 1)
    const cell = row * cols + col
    const digit = parseInt(hex[cell >> 2], 16)
    if (Number.isNaN(digit)) return false
    const bit = 3 - (cell & 3)
    return Boolean((digit >> bit) & 1)
  }

  // The next frame at or after `current` where `clip` (a clips.json entry)
  // is close enough to the neutral pose to hand over — or its last used
  // frame, if none remains, so a reaction queued near the end still lands
  // cleanly instead of overshooting.
  function nextSafeFrame(clip, current) {
    const safe = clip && Array.isArray(clip.safe) ? clip.safe : []
    for (let i = 0; i < safe.length; i++) if (safe[i] >= current) return safe[i]
    return clip ? clip.to : current
  }

  // What plays after the clip whose kind is `state.lastKind` finishes (with
  // no reaction queued — that is handled separately, by interrupting
  // whatever is already playing rather than waiting to be asked here).
  // A pose or reaction always falls back to idle; only idle ever rolls the
  // dice for the next pose, gated on both the cooldown and never repeating
  // the pose just played.
  function pickNext(state, clips, now, rng) {
    const info = state || {}
    if (info.lastKind === 'pose' || info.lastKind === 'reaction') return 'idle'
    const poses = Object.keys(clips || {}).filter(name => clips[name] && clips[name].kind === 'pose')
    if (!poses.length) return 'idle'
    const lastPoseAt = typeof info.lastPoseAt === 'number' ? info.lastPoseAt : -Infinity
    if (now - lastPoseAt < MIN_POSE_GAP) return 'idle'
    const roll = typeof rng === 'function' ? rng() : Math.random()
    if (roll >= POSE_CHANCE) return 'idle'
    const choices = poses.filter(name => name !== info.lastPoseName)
    if (!choices.length) return 'idle'
    const pick = typeof rng === 'function' ? rng() : Math.random()
    return choices[Math.min(choices.length - 1, Math.floor(pick * choices.length))]
  }

  // 'HH:mm 重置' the same day, 'M月D日 HH:mm 重置' otherwise, or
  // '已重置，等待新数据' once the moment has passed; null when there is no
  // reset time to show (the history fallback has none).
  function formatReset(iso, now) {
    if (!iso) return null
    const at = new Date(iso)
    if (Number.isNaN(at.getTime())) return null
    const current = now instanceof Date ? now : new Date(now)
    if (at.getTime() <= current.getTime()) return '已重置，等待新数据'
    const sameDay = at.getFullYear() === current.getFullYear() &&
      at.getMonth() === current.getMonth() && at.getDate() === current.getDate()
    const hm = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
    return sameDay ? `${hm} 重置` : `${at.getMonth() + 1}月${at.getDate()}日 ${hm} 重置`
  }

  // Structures a ClaudePet.setQuota() payload into what the bubble renders:
  // one row per window (label, remaining %, the used/reset line) plus a
  // footer; `empty` when there is nothing to show yet.
  function formatQuota(data, now) {
    const current = now instanceof Date ? now : new Date(now == null ? Date.now() : now)
    if (!data || !Array.isArray(data.windows) || !data.windows.length) {
      return { empty: true, emptyText: NO_DATA_TEXT, header: QUOTA_HEADER, rows: [], updatedText: '', sourceNote: null }
    }
    const rows = data.windows.map(window => {
      // A missing or non-numeric value reads as 0 rather than printing NaN.
      const raw = Number(window.percentUsed)
      const used = clamp(Number.isFinite(raw) ? Math.round(raw) : 0, 0, 100)
      const remaining = clamp(100 - used, 0, 100)
      const resetText = formatReset(window.resetsAt, current)
      const line = resetText ? `已用 ${used}% · ${resetText}` : `已用 ${used}%`
      return { kind: window.kind, label: KIND_LABELS[window.kind] || window.kind, used, remaining, resetText, line }
    })
    const updated = new Date(data.updatedAt)
    const updatedText = Number.isNaN(updated.getTime()) ? '' : `更新于 ${pad2(updated.getHours())}:${pad2(updated.getMinutes())}`
    const sourceNote = data.source === 'history' ? '（来自 Claude 用量记录，无重置时间）' : null
    return { empty: false, header: QUOTA_HEADER, rows, updatedText, sourceNote }
  }

  // Where the bubble lands in the BUBBLE_SPACE above her head: centred on
  // her head (box centre x / box top, mapped through `frame`, the clip
  // frame's page rect), clamped inside `viewport` (the panel's actually
  // visible region -- see setViewport(); defaults to the whole page) with
  // `margin`; `tailX` is the little pointer's x within the bubble,
  // re-clamped the same way so it still points at her head once the bubble
  // itself was pushed off-centre.
  function layoutBubble(options) {
    const opts = options || {}
    const box = opts.box || [0, 0, 1, 1]
    const frame = opts.frame || { left: 0, top: 0, width: 0, height: 0 }
    const width = opts.width || 0
    const height = opts.height || 0
    const viewport = opts.viewport || { left: 0, top: 0, width: opts.pageWidth || 0, height: Infinity }
    const margin = opts.margin == null ? BUBBLE_MARGIN : opts.margin
    const tailGap = opts.tailGap == null ? 10 : opts.tailGap
    const headX = frame.left + ((box[0] + box[2]) / 2) * frame.width
    const headTop = frame.top + box[1] * frame.height
    const minLeft = viewport.left + margin
    const maxLeft = Math.max(minLeft, viewport.left + viewport.width - margin - width)
    const left = clamp(headX - width / 2, minLeft, maxLeft)
    const top = Math.max(viewport.top + margin, headTop - tailGap - height)
    const tailX = clamp(headX - left, 10, Math.max(10, width - 10))
    return { left, top, tailX }
  }

  // ---------------------------------------------------------------------
  // DOM runtime.
  // ---------------------------------------------------------------------

  function post(message) {
    const handler = root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.pet
    if (handler) handler.postMessage(message)
  }

  let manifest = null
  let reducedMotionMode = false
  let playbackBegun = false
  let videosFailed = false
  let dom = {}

  let front = null
  let back = null
  let frameTimed = false
  let currentKind = 'idle'
  let handing = false
  let due = false
  let watching = 0
  let queuedTimer = 0
  let handoffTargetFrame = Infinity
  let pendingReaction = null
  let forcedNext = null
  // Clips waiting their turn behind pendingReaction: a play() that arrives
  // while another queued clip has not started yet, or a pose that was
  // already loaded as next when a click took its slot. They play in order
  // once the current one is done, instead of being overwritten and lost.
  const playQueue = []
  const schedState = { lastPoseName: null, lastPoseAt: -Infinity }

  let bubbleMode = null // null | 'quota' | 'say'
  let bubbleSayText = ''
  let bubbleSeconds = BUBBLE_SECONDS
  let bubbleTimer = 0
  let lastQuota = null
  let lastInside = false

  // The panel is sized to the full, unclipped clip frame (so the page's own
  // layout/scale never changes), but Swift may host it inside a SMALLER
  // on-screen window clipped to Claude's sidebar column (PetLayout task 2b).
  // `viewport` is that visible rect in page px, set by setViewport(); null
  // until Swift reports one, in which case the bubble clamps to the whole
  // page like before.
  let viewport = null

  const nowMs = () => Date.now()
  const fileOf = name => manifest.clips[name] && manifest.clips[name].file
  const kindOf = name => (manifest.clips[name] && manifest.clips[name].kind) || 'idle'
  const cueTime = name => (manifest.clips[name].from + 0.5) / manifest.fps

  function frameRect() {
    return dom.frame ? dom.frame.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 }
  }

  function setCursor(inside) {
    if (root.document && root.document.body) root.document.body.style.cursor = inside ? 'pointer' : 'default'
  }

  function insideBubble(x, y) {
    if (!bubbleMode || !dom.bubble || !dom.bubble.classList.contains('visible')) return false
    const rect = dom.bubble.getBoundingClientRect()
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  }

  // Maps a page point to the current clip's silhouette; before playback
  // starts, after it fails, or in reduced motion (poster only, never a
  // clip), falls back to her bounding box from clips.json.
  function hitTest(x, y) {
    if (insideBubble(x, y)) return true
    if (!manifest) return false
    const rect = frameRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const u = (x - rect.left) / rect.width
    const v = (y - rect.top) / rect.height
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return false
    if (reducedMotionMode || videosFailed || !front) {
      const box = manifest.box
      return u >= box[0] && u <= box[2] && v >= box[1] && v <= box[3]
    }
    const meta = manifest.clips[front.dataset.clip]
    if (!meta || !meta.mask) return false
    const frameIndex = Math.max(0, Math.round(front.currentTime * manifest.fps))
    return maskHit(meta.mask, frameIndex, u, v)
  }

  function pointer(x, y) {
    if (x == null || y == null) {
      lastInside = false
      setCursor(false)
      post({ type: 'hit', inside: false })
      return
    }
    const inside = hitTest(x, y)
    setCursor(inside)
    if (inside !== lastInside) {
      lastInside = inside
      post({ type: 'hit', inside })
    }
  }

  // `./pet.sh quota off` (defaults petQuotaOnClick, relayed by Swift): a
  // click still gets her reaction, just no quota bubble.
  let quotaOnClick = true
  function setQuotaEnabled(on) {
    quotaOnClick = on !== false
    if (!quotaOnClick && bubbleMode === 'quota') hideBubble()
  }

  function handleClick() {
    if (quotaOnClick) toggleBubble()
    if (!reducedMotionMode && manifest && manifest.clips.click) queueClip('click')
    // `quota`: the bubble just opened on the quota, so Swift re-reads it (and
    // asks for a fresh reading when the one it has is over a minute old).
    post({ type: 'click', quota: bubbleMode === 'quota' })
  }

  function click() {
    handleClick()
  }

  // --- speech bubble ---

  function renderBubble() {
    if (!dom.bubble) return
    if (bubbleMode === 'say') {
      dom.bubble.innerHTML = `<div class="qp"><div class="row plain">${escape(bubbleSayText)}</div><div class="tail"></div></div>`
    } else {
      const info = formatQuota(lastQuota, new Date())
      if (info.empty) {
        dom.bubble.innerHTML = `<div class="qp"><div class="hd">${escape(info.header)}</div>` +
          `<div class="row plain">${escape(info.emptyText)}</div><div class="tail"></div></div>`
      } else {
        const rows = info.rows.map(row => (
          `<div class="row">` +
          `<div class="line1">${escape(row.label)} · 剩 ${row.remaining}%</div>` +
          `<div class="bar"><i style="width:${row.remaining}%"></i></div>` +
          `<div class="meta">${escape(row.line)}</div>` +
          `</div>`
        )).join('')
        // The update time sits on the header row: a footer row would make the
        // bubble too tall for BUBBLE_SPACE, pushing it down onto her head and
        // wrench. Only the long history note still needs a footer of its own.
        const time = info.updatedText && !info.sourceNote ? `<span class="at">${escape(info.updatedText)}</span>` : ''
        const footer = info.updatedText && info.sourceNote ? `${escape(info.updatedText)} ${escape(info.sourceNote)}` : ''
        dom.bubble.innerHTML = `<div class="qp"><div class="hd"><span>${escape(info.header)}</span>${time}</div>${rows}` +
          `${footer ? `<div class="ft">${footer}</div>` : ''}<div class="tail"></div></div>`
      }
    }
    positionBubble()
  }

  function positionBubble() {
    if (!dom.bubble || !manifest) return
    const size = dom.bubble.getBoundingClientRect()
    const layout = layoutBubble({
      box: manifest.box,
      frame: frameRect(),
      width: size.width || 220,
      height: size.height || 80,
      viewport: viewport || { left: 0, top: 0, width: root.innerWidth, height: root.innerHeight },
      margin: BUBBLE_MARGIN,
    })
    dom.bubble.style.left = `${layout.left}px`
    dom.bubble.style.top = `${layout.top}px`
    const tail = dom.bubble.querySelector('.tail')
    if (tail) tail.style.left = `${layout.tailX}px`
  }

  // Swift calls this whenever the panel's on-screen (possibly sidebar-
  // clipped) rect changes, in page px relative to this page's own top-left
  // -- the same frame the panel/webview geometry always uses, never the
  // smaller visible window (see Sources/pet.swift repositionWebView()).
  function setViewport(rect) {
    viewport = rect && typeof rect === 'object' ? rect : null
    if (bubbleMode) positionBubble()
  }

  function scheduleAutohide() {
    root.clearTimeout(bubbleTimer)
    bubbleTimer = root.setTimeout(hideBubble, bubbleSeconds * 1000)
  }

  function showBubble() {
    renderBubble()
    if (dom.bubble) dom.bubble.classList.add('visible')
    scheduleAutohide()
  }

  function hideBubble() {
    root.clearTimeout(bubbleTimer)
    bubbleMode = null
    if (dom.bubble) dom.bubble.classList.remove('visible')
  }

  // A click anywhere outside her (Swift's global mouse monitor: Claude's
  // window, another app, the desktop) closes whatever bubble is open.
  function dismiss() {
    if (bubbleMode) hideBubble()
  }

  function toggleBubble() {
    if (bubbleMode) { hideBubble(); return }
    bubbleMode = 'quota'
    bubbleSeconds = BUBBLE_SECONDS
    showBubble()
  }

  function say(text, seconds) {
    bubbleMode = 'say'
    bubbleSayText = text == null ? '' : String(text)
    bubbleSeconds = typeof seconds === 'number' && seconds > 0 ? seconds : BUBBLE_SECONDS
    showBubble()
  }

  function setQuota(data) {
    lastQuota = data || null
    if (bubbleMode === 'quota') renderBubble()
  }

  // --- clip hand-over (ported from hero-runtime.ts; see file header) ---

  function load(video, name) {
    video.dataset.clip = name
    delete video.dataset.cued
    video.src = `clips/${fileOf(name)}`
    video.load()
  }

  function cued(video) {
    return 'cued' in video.dataset && !video.seeking && video.readyState >= 3
  }

  // What plays next once the current clip is done (no reaction queued): a
  // pose or reaction always returns to idle; idle rolls pickNext(). A
  // queued reaction (from a click, or ClaudePet.play()) takes priority over
  // either, and forces idle right after it.
  function decideNext() {
    if (pendingReaction) {
      const name = pendingReaction
      pendingReaction = null
      forcedNext = 'idle'
      return manifest.clips[name] ? name : 'idle'
    }
    while (playQueue.length) {
      const name = playQueue.shift()
      if (manifest.clips[name]) return name
    }
    if (forcedNext) {
      const name = forcedNext
      forcedNext = null
      return name
    }
    if (currentKind === 'pose' || currentKind === 'reaction') return 'idle'
    return pickNext({ lastKind: currentKind, lastPoseName: schedState.lastPoseName, lastPoseAt: schedState.lastPoseAt }, manifest.clips, nowMs(), Math.random)
  }

  function handOff() {
    if (handing || !front || !back) return
    if (!cued(back)) { due = true; return }
    due = false
    handing = true
    const incoming = back
    const outgoing = front
    incoming.play().then(() => {
      handing = false
      incoming.dataset.front = ''
      delete outgoing.dataset.front
      const finishedName = outgoing.dataset.clip
      if (kindOf(finishedName) === 'pose') {
        schedState.lastPoseName = finishedName
        schedState.lastPoseAt = nowMs()
      }
      front = incoming
      back = outgoing
      currentKind = kindOf(front.dataset.clip)
      handoffTargetFrame = manifest.clips[front.dataset.clip].to - LEAD
      // The queued clip has arrived: it plays out in full and is followed by
      // idle (its kind), instead of being re-aimed at its own safe frame or
      // queued a second time by decideNext().
      if (pendingReaction === front.dataset.clip) {
        pendingReaction = null
      } else if (pendingReaction) {
        // A click that arrived while this hand-over was already in flight
        // could not re-aim it (back was mid-swap): the new front still needs
        // the safe-frame interrupt, not its full length.
        const frameNow = Math.round(front.currentTime * manifest.fps)
        handoffTargetFrame = Math.max(frameNow, nextSafeFrame(manifest.clips[front.dataset.clip], frameNow) - LEAD)
      }
      watch(front)
      root.clearTimeout(queuedTimer)
      queuedTimer = root.setTimeout(() => {
        outgoing.pause()
        load(outgoing, decideNext())
      }, BLEND * 2000 + 100)
    }, () => { handing = false })
  }

  function reached(video, timeSeconds) {
    if (video !== front) return
    if (timeSeconds * manifest.fps + 0.01 >= handoffTargetFrame) handOff()
  }

  function watch(video) {
    if (!frameTimed) return
    const token = ++watching
    const step = (_now, meta) => {
      if (token !== watching) return
      reached(video, meta.mediaTime)
      video.requestVideoFrameCallback(step)
    }
    video.requestVideoFrameCallback(step)
  }

  function onMeta(event) {
    const video = event.currentTarget
    if (video.paused) video.currentTime = cueTime(video.dataset.clip)
    else video.dataset.cued = ''
  }
  function onSeeked(event) {
    const video = event.currentTarget
    video.dataset.cued = ''
    if (video === back && due) handOff()
  }
  function onReady(event) {
    if (event.currentTarget === back && due) handOff()
  }
  function onTime(event) {
    if (!frameTimed) reached(event.currentTarget, event.currentTarget.currentTime)
  }
  function onEnded(event) {
    if (event.currentTarget === front) handOff()
  }
  function onVideoError(event) {
    post({ type: 'error', message: `video failed: ${event.currentTarget.dataset.clip || ''}` })
    videosFailed = true
    if (dom.videoA) dom.videoA.style.display = 'none'
    if (dom.videoB) dom.videoB.style.display = 'none'
    // Nothing else is left to show her: bring the poster back rather than
    // leave a blank panel.
    if (dom.poster) dom.poster.style.display = ''
  }

  function wireVideo(video) {
    video.muted = true
    video.addEventListener('loadedmetadata', onMeta)
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('canplay', onReady)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('ended', onEnded)
    video.addEventListener('error', onVideoError)
  }

  // Queues `name` to take over at the next safe hand-over: for a click's
  // reaction, or ClaudePet.play() ("queues any clip the same way"). Cues it
  // onto the back element right away and re-aims the hand-over at the
  // nearest safe frame of whatever is currently playing, rather than
  // waiting for that clip to reach its own natural end.
  function queueClip(name) {
    if (reducedMotionMode || videosFailed || !playbackBegun) return
    if (!manifest || !manifest.clips[name]) return
    if (front && front.dataset.clip === name) return
    if (pendingReaction === name) return
    pendingReaction = name
    if (handing) return // the in-flight hand-over's own follow-up load will pick this up
    root.clearTimeout(queuedTimer)
    // The spare element already holds what was going to play next: a pose
    // (rolled by pickNext, or queued by play()) goes back to the head of the
    // queue so it still plays after this one, rather than silently vanishing.
    const displaced = back.dataset.clip
    if (displaced && displaced !== name && kindOf(displaced) !== 'idle') playQueue.unshift(displaced)
    load(back, name)
    const frontMeta = manifest.clips[front.dataset.clip]
    const frameNow = Math.max(0, Math.round(front.currentTime * manifest.fps))
    handoffTargetFrame = Math.max(frameNow, nextSafeFrame(frontMeta, frameNow) - LEAD)
    if (due) handOff()
  }

  // Waits behind a clip that is queued but not yet playing, instead of
  // replacing it (queueClip's own interrupt-at-a-safe-frame rule otherwise).
  function play(name) {
    if (pendingReaction && pendingReaction !== name && manifest && manifest.clips[name]) {
      if (!playQueue.includes(name)) playQueue.push(name)
      return
    }
    queueClip(name)
  }

  function beginPlayback() {
    if (playbackBegun || reducedMotionMode || !manifest || !manifest.clips.idle) return
    playbackBegun = true
    front = dom.videoA
    back = dom.videoB
    frameTimed = typeof front.requestVideoFrameCallback === 'function'
    wireVideo(front)
    wireVideo(back)
    currentKind = 'idle'
    load(front, 'idle')
    handoffTargetFrame = manifest.clips.idle.to - LEAD
    load(back, decideNext())
    // The very first clip must not show before its first frame is actually
    // presented (otherwise the poster would blink to black beneath it);
    // every later hand-over already has the outgoing clip still fully
    // opaque underneath while the incoming one fades in, so only this one
    // needs the extra wait. Once that first BLEND fade-in has actually run
    // its course, the poster must come out from under the videos for good:
    // it is a *neutral standing* frame, and a clip video's alpha channel is
    // transparent everywhere outside her CURRENT silhouette, so an un-hidden
    // poster shows straight through as a second, ghost figure the moment any
    // pose (sit/feet/snap/click) diverges from that neutral pose -- this is
    // the "she appears twice" bug: the poster was simply never hidden.
    const onFirstFrame = () => {
      front.removeEventListener('playing', onFirstFrame)
      front.dataset.front = ''
      root.setTimeout(() => { if (dom.poster) dom.poster.style.display = 'none' }, BLEND * 1000 + 50)
    }
    front.addEventListener('playing', onFirstFrame)
    front.play().catch(error => post({ type: 'error', message: `video did not play: ${error && error.message}` }))
    watch(front)
  }

  function setVisible(value) {
    const visible = Boolean(value)
    if (reducedMotionMode) return
    if (!visible) {
      if (front) front.pause()
      if (back) back.pause()
      return
    }
    if (!playbackBegun) { beginPlayback(); return }
    if (front && front.ended) {
      if (cued(back)) handOff()
      else due = true
    } else if (front) {
      front.play().catch(() => {})
    }
  }

  // --- bootstrap ---

  function layoutShadow() {
    if (!dom.shadow || !manifest) return
    // 125% of her bbox wide (2026-10-11: reaches out to both boots, was
    // 55%), 0.22 of that tall; intro.js petShadowLayout mirrors this.
    const [x0, y0, x1, y1] = manifest.box
    const width = (x1 - x0) * 1.25
    const cx = (x0 + x1) / 2
    const height = width * 0.22
    dom.shadow.style.left = `${(cx - width / 2) * 100}%`
    dom.shadow.style.width = `${width * 100}%`
    dom.shadow.style.top = `${(y1 * 100) - height * 100 / 2}%`
    dom.shadow.style.height = `${height * 100}%`
  }

  function bindInput() {
    const doc = root.document
    doc.addEventListener('pointerdown', event => { if (hitTest(event.clientX, event.clientY)) handleClick() })
    doc.addEventListener('contextmenu', event => {
      if (hitTest(event.clientX, event.clientY)) {
        event.preventDefault()
        post({ type: 'menu', x: event.clientX, y: event.clientY })
      }
    })
    if (dom.bubble) {
      dom.bubble.addEventListener('mouseenter', () => root.clearTimeout(bubbleTimer))
      dom.bubble.addEventListener('mouseleave', scheduleAutohide)
    }
  }

  // WKWebView's fetch() cannot read file: URLs, so the app reads clips.json
  // itself and hands it over in start({manifest}); fetching it is only the
  // fallback for a page served some other way (and the tests).
  function fetchManifest(given) {
    if (given && typeof given === 'object') return Promise.resolve(given)
    return root.fetch('clips/clips.json').then(response => {
      if (!response.ok) throw new Error(`clips.json: ${response.status}`)
      return response.json()
    })
  }

  function start(options) {
    const opts = options || {}
    reducedMotionMode = opts.reducedMotion != null
      ? Boolean(opts.reducedMotion)
      : Boolean(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches)
    const doc = root.document
    dom = {
      frame: doc.getElementById('frame'),
      poster: doc.getElementById('poster'),
      shadow: doc.getElementById('shadow'),
      bubble: doc.getElementById('bubble'),
      videoA: doc.getElementById('videoA'),
      videoB: doc.getElementById('videoB'),
    }
    return fetchManifest(opts.manifest).then(data => {
      manifest = data
      doc.documentElement.style.setProperty('--ar', `${manifest.size[0]} / ${manifest.size[1]}`)
      layoutShadow()
      if (dom.poster) dom.poster.src = 'clips/poster.png'
      const ready = dom.poster && dom.poster.decode ? dom.poster.decode().catch(() => {}) : Promise.resolve()
      return ready.then(() => {
        post({ type: 'ready', size: manifest.size, box: manifest.box })
        bindInput()
        if (reducedMotionMode) {
          if (dom.videoA) dom.videoA.style.display = 'none'
          if (dom.videoB) dom.videoB.style.display = 'none'
        } else if (opts.autoplay) {
          beginPlayback()
        }
      })
    }).catch(error => {
      post({ type: 'error', message: String((error && error.message) || error) })
    })
  }

  const api = {
    POSE_CHANCE, MIN_POSE_GAP, LEAD, BLEND,
    escape, maskHit, nextSafeFrame, pickNext, formatReset, formatQuota, layoutBubble,
    start, setVisible, pointer, click, dismiss, setQuota, setQuotaEnabled, say, play, setViewport,
  }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.ClaudePet = api
})(typeof window === 'undefined' ? globalThis : window)
