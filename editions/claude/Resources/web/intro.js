// The "second awakening" cut-in shown over the Claude desktop app's window
// while it starts. A side-scrolling-action-game style band, with the whole
// 3D character, half-length, where the 2D cut-in had her: her head and wrench
// rise above the band, and no edge or mask cuts any of her. Nothing is
// drawn around her: no rim light, glow or baked shadow (build-clip.py
// --shadow is left off, so no dark cast shows on her suit between her arm
// and waist, and she matches the sidebar pet, which has none either).
//
// Nothing is baked from her outline either (no afterimage or flash
// silhouette): a still outline cannot follow her clip, so it would show a
// second wrench and head beside the moving ones. The animation only moves,
// scales and fades layers, which WebKit hands to the GPU, so it stays smooth
// at any window size.
//
// Her own movement is a clip (layers/awakening.mov): two Seedance
// image-to-video shots of her whole figure, from the wrench down to her
// thighs, made from the W2 plate (the action W3, then an idle made from its last
// frame, in which she turns her head): one model moving as a whole, nothing
// painted on or stitched to her below the waist; matted,
// interpolated to 60 fps by tools/build-clip.py and stored as HEVC with
// alpha. It starts as she slams
// in, so she is never a frozen picture; it is not bobbed or tilted as a whole
// (that reads as a paper cut-out). If it cannot load, her still body stands
// in for it.
//
// Timeline, seconds after play():
//   0.00–0.24  the band opens from a slit, a flash line across it
//   0.10–0.60  slashes and speed lines rush in; the character slams in from
//              the right
//   0.25–1.85  the drone flies in from the lower left, under the lettering,
//              and settles by her shoulder
//   0.58–0.95  a white flash across the whole window and a shockwave
//   0.72–1.05  the skill name slams down, the label and subtitle follow
//   1.35–2.60  the greeting types out on its strip
//   0.20–6.20  her clip: she turns to the camera with a growing grin, lifts
//              the wrench overhead (1.7–2.8) and sets it back on her shoulder
//              (her gloved hand never lets go), brushes her nose with the
//              thumb of her other hand (3.0–3.8), gives a thumbs-up with a
//              wink (4.2–5.3), lowers that hand and laughs, hair and coat in
//              the wind; the star on her chest wakes from a dim ember; the
//              layers drift apart (parallax), the drone's eye pulses, embers
//              around her
//   6.20–12.00 the idle: she straightens her head and turns it away, looking
//              far off to the right (6.45–6.7), holds that look, turns back
//              to the camera with a smile (8.95–9.2), winks (10.2–10.45), and
//              turns away again, resolute, as she leaves (11.45–11.95); her
//              hair swings and settles with each turn, her hanging hand stays
//              by her side
//
// Without a pet rect (ClaudeIntro.setPet was never called, or either
// transition clip could not be buffered), the intro ends exactly as above:
//  11.40–11.90 holding that look, she fades toward the camera and the band
//              snaps shut
//  11.60–12.10 the backdrop fades and the app underneath shows through
//  at CORE_MS  'done' is posted
//
// With one (a first setPet by PET_CONFIRM_BY_MS; see setPet()), her clip
// plays through to its own last frame unchanged -- she never fades -- and at
// CORE_MS (her clip's natural end, in the same window the fade used to run)
// hands off to layers/exit.mov in the same CHAR_BOX, so there is no jump in
// her position, scale, colour or the chest star's glow (both clips share one
// colour correction and relighting clock; see tools/build-transition.sh):
//  11.40       the band and backdrop hold still, just before their own
//              closing keyframes (HOLD_AT_MS; looping gears and embers keep
//              moving), so her huge half figure only ever shows over the
//              dark scene, never cut off by the window over Claude's light UI
//  12.00–14.40 exit: she glances down-left, crouches, leaps, and shoots out
//              through the top of the window, over the still-open scene
//  14.40–15.10 with her gone, the scene closes exactly as the plain ending's
//              does (its own 11.40–12.10 keyframes, resumed: SCENE_CLOSE_MS),
//              and Claude's own window shows through
// Then layers/landing.mov appears at the rect's derived canvas
// (landingLayout; parts outside the window are simply clipped) and plays
// from an empty frame:
//  15.10–19.77 landing: she drops in from the upper right, arcs down-left,
//              lands, stands and turns -- ending on the same neutral pose
//              Resources/web/pet/clips/poster.png shows, with a soft ground
//              ellipse (petShadowLayout, matching the pet page's own
//              #shadow) fading in as she touches down, so the pet panel
//              Swift reveals the instant 'landed' posts shows no seam
//  at 'landed' the pet is shown and the intro closes with no fade (Swift);
//              'done' is never posted on this path
//
// Only Esc skips, in both paths (Swift's key monitor; the page shows a
// corner hint saying so); clicks and other keys never interrupt.
;(function (root) {
  'use strict'

  // The band's own choreography above, and the plain ending without a pet,
  // both run exactly CORE_MS as before; the window the fade used to run in
  // is where the pet ending instead hands off to layers/exit.mov. DURATION_MS
  // (checked against Sources/main.swift and index.html) covers the longer
  // pet path: CORE_MS, then exit.mov's length, SCENE_CLOSE_MS and
  // landing.mov's length, plus a little room; main.swift never animates
  // against it; it only waits for 'done'/'landed' with this as a
  // dead-man's-switch timeout.
  const CORE_MS = 12100
  const EXIT_CLIP = 'layers/exit.mov'
  const LANDING_CLIP = 'layers/landing.mov'
  const DURATION_MS = 20000
  // The pet path's scene hold (see this file's header): from the first of
  // the band's closing keyframes (end(.6) below) until she has left, then
  // the rest of CORE_MS to close it, before she drops back in.
  const HOLD_AT_MS = CORE_MS - 700
  const SCENE_CLOSE_MS = CORE_MS - HOLD_AT_MS
  // The latest a first setPet can still switch to the pet ending: before
  // HOLD_AT_MS, where her .cexit fade and the scene's closing begin
  // (cancelling the fade halfway would snap her back to full opacity). On a
  // cold launch the native app only learns the pet's rect once Claude's new
  // window has settled, a second or so after play(), so it keeps re-sending
  // it; a first rect after this is ignored and the plain ending plays.
  const PET_CONFIRM_BY_MS = HOLD_AT_MS - 400
  const petConfirmable = sincePlayMs => !(sincePlayMs > PET_CONFIRM_BY_MS)
  // The band's own animations run SPAN seconds, tied to CORE_MS (not
  // DURATION_MS): the pet ending only adds time after the band's own
  // choreography, never stretches it. Their keyframes are placed in seconds
  // from the start (at) or before the end of CORE_MS (end).
  const SPAN = CORE_MS / 1000 - 0.1
  const at = seconds => `${+(seconds / SPAN * 100).toFixed(3)}%`
  const end = seconds => at(SPAN - seconds)
  // The pet clip frame's alpha bbox, normalised (Resources/web/pet/clips/clips.json
  // `box`, idle's own -- shared by every pet clip including landing.mov's
  // last frame): used to place the ground-contact ellipse exactly where the
  // pet page's own #shadow (pet.js layoutShadow) would.
  const PET_BOX = [0.287109375, 0.18621700879765396, 0.703125, 0.9472140762463344]
  // landing.mov's own canvas (1080x1920, 9:16): the pet clip frame sits in it
  // at this normalised rect (build/source/pet/seedance-prompts.md's landing
  // entry; x0 0 and y0+h 1 mean its left and bottom edges are the canvas's
  // own, so landingLayout only has to solve for scale).
  const LANDING_BOX = { x: 0, y: 0.7198, w: 0.3741, h: 0.2802 }
  // How long into landing.mov she has visibly touched down (measured on the
  // built clip: build/source/pet/seedance-prompts.md's ~1.3s on the original
  // timing, carried through the leading-frame trim --align-to applies).
  const LANDING_TOUCHDOWN_MS = 960
  // Her landing shadow's opacity ms into landing.mov: nothing until she
  // touches down, then the same 0.3s linear fade playback runs.
  const landingShadowOpacity = ms => Math.min(1, Math.max(0, (ms - LANDING_TOUCHDOWN_MS) / 300))
  // One is picked at random on every start; at most 16 characters each, so
  // the greeting fits its strip.
  const LINES = [
    '系统全开，随时出击！',
    '核心已超频，今天想造点什么？',
    '机核就绪，听你指挥。',
    '扳手已上膛，Bug 准备好了吗？',
    '能量核心满载，开工！',
    '无人机已就位，目标锁定。',
    '灵感充能完毕，开始构建。',
    '代码引擎预热完成。',
    '今天也一起拆掉几个难题吧。',
    '护目镜已戴好，进入专注模式。',
    '所有模块在线，等你下令。',
    '齿轮咬合，思路已就绪。',
    '超频启动，效率拉满！',
    '把想法交给我，剩下的我来拧紧。',
    '战术目镜扫描完毕，一切正常。',
    '准备好了，今天要拆哪座山？',
    '火花已点燃，开始锻造。',
    '机核心跳稳定，随时待命。',
  ]
  const NIGHT_LINES = [
    '低功耗待命中，陪你把事情收尾。',
    '夜间模式已开启，别熬太晚。',
    '星光值班中，最后一件事交给我。',
    '核心降频运行，收尾就好。',
    '通宵不是好习惯，我陪你收尾。',
  ]
  const LAYERS = ['body', 'drone', 'title-off', 'title', 'title-hot']
  const CLIP = 'layers/awakening.mov'
  const CLIP_AT_MS = 200

  const pick = (list, random) => list[Math.min(list.length - 1, Math.floor(random() * list.length))]

  // Greets by the Mac's local time, with a random line.
  function introText(date, random = Math.random) {
    const hour = date.getHours()
    if (hour >= 23 || hour < 5) return { title: '夜深了', line: pick(NIGHT_LINES, random) }
    const title = hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好'

    return { title, line: pick(LINES, random) }
  }

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  const escape = text => String(text).replace(/[&<>"']/g, char => ESCAPES[char] || char)

  // A fixed pseudo-random stream, so the markup is the same on every run.
  function stream(seed) {
    let state = seed
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state / 2147483648
    }
  }

  const n = value => value.toFixed(1)
  const px = value => `${n(value)}px`

  // Static vector art goes in small SVGs that are painted once; every moving
  // part is an HTML box animated with transform and opacity only.
  const svg = (width, height, body, defs = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" overflow="visible">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`

  function gear(outer, inner, teeth) {
    const c = outer
    const points = []
    for (let i = 0; i < teeth * 4; i++) {
      const angle = (i / (teeth * 4)) * Math.PI * 2
      const r = i % 4 === 1 || i % 4 === 2 ? outer : inner
      points.push(`${n(c + Math.cos(angle) * r)},${n(c + Math.sin(angle) * r)}`)
    }
    return svg(outer * 2, outer * 2,
      `<g fill="none" stroke="#ff9a3c" stroke-opacity=".13" stroke-width="2"><polygon points="${points.join(' ')}"/><circle cx="${c}" cy="${c}" r="${n(inner * 0.45)}"/></g>`)
  }

  const random = stream(20261009)

  // The effects fill the whole window, not a band: in band px the window
  // spans at most about x -580-1410 (21:9) and y -670-1010 (a tall window),
  // so they are laid out over FIELD, which covers that with room to drift.
  const FIELD = { x: -760, y: -760, w: 2520, h: 1900 }

  // Dashed streaks across the whole window: an 800px dash pattern on a
  // 4000px strip, slid one period.
  const SPEED_LINES = Array.from({ length: 34 }, (_, i) => {
    const y = FIELD.y + 60 + (i + random()) * ((FIELD.h - 120) / 34)
    const dash = [120, 40, 220, 70][i % 4]
    const speed = ['sa', 'sb', 'sc'][i % 3]
    const colour = i % 5 === 0 ? '#fff4e0' : '#ff9a3c'
    const offset = Math.round(random() * 800)
    return `<i class="line ${speed}" style="top:${px(y)};height:${i % 4 === 2 ? 2 : 1}px;background-image:linear-gradient(to right,${colour} 0 ${dash}px,transparent ${dash}px 800px);background-position-x:${-offset}px"></i>`
  }).join('')

  function embers(count, size, area, tag) {
    return Array.from({ length: count }, (_, i) => {
      const x = area[0] + random() * area[2]
      const y = area[1] + random() * area[3]
      const r = size[0] + random() * (size[1] - size[0])
      const colour = i % 4 === 0 ? '#fff1cc' : '#ffad4d'
      return `<i class="${tag} e${i % 3} d${i % 5}" style="left:${px(x - r)};top:${px(y - r)};width:${px(r * 2)};height:${px(r * 2)};background:${colour}"></i>`
    }).join('')
  }

  const EMBERS_BACK = embers(64, [0.7, 1.9], [-300, -440, 1400, 1300], 'em')
  const EMBERS_FRONT = embers(12, [1.8, 3.4], [430, 0, 400, 420], 'emf')

  // Light shards slanting across the whole window: cx is where a shard
  // crosses the middle (y 168), w its width.
  const SLANT = 0.36
  // Her colours, sampled from her plate: the copper orange of her suit's
  // lines and goggles, her white armour, the near-black of her gloves. The
  // lettering and HUD use only these, so nothing reads apart from her.
  const ORANGE = '#e27547'
  const ORANGE_HI = '#ff9a66'
  const WHITE = '#efe7e8'
  const SILVER = '#bdb5b8'
  const INK = '#120c0e'

  // Columns of hex pairs drifting at the window's sides, like a breach
  // protocol's code matrix: faint, in her orange.
  const HEX = '0123456789ABCDEF'
  // Offsets from the window's left or right side (fit places them); until
  // then they stand at x -50-836.
  const DATA_COLUMNS = [[-50, 5], [-26, 29], [812, -43], [836, -19]].map(([x, offset]) => {
    const rows = Array.from({ length: 34 }, () => HEX[Math.floor(random() * 16)] + HEX[Math.floor(random() * 16)]).join('\n')
    return `<i class="hex" data-offset="${offset}" style="left:${x}px;top:${FIELD.y + 80 + Math.round(random() * 120)}px">${rows}</i>`
  }).join('')

  const shard = (cx, w) => {
    const at = y => cx + (168 - y) * SLANT
    const top = FIELD.y
    const bottom = FIELD.y + FIELD.h
    return `${n(at(top) - w / 2)},${top} ${n(at(top) + w / 2)},${top} ${n(at(bottom) + w / 2)},${bottom} ${n(at(bottom) - w / 2)},${bottom}`
  }

  // Layer boxes in band pixels. Her clip and her still layers are the whole
  // 2340x3120 W2 plate at 0.3359 band px per plate px: the 1728x2304 J3 plate
  // (the half-length J1 render at 78%, standing on its bottom edge, centred)
  // with her hips and thighs drawn on below her waist (440 plate px), widened
  // to 3:4 and set bottom-centred with room all round, so that Seedance moves
  // her as one whole figure, the wrench lifted overhead and her arms out all
  // inside its frame. She stands where the 2D cut-in had her: head and wrench
  // rising above the band, x 418-782, y -37-388 at rest, her waist at y 429.
  // The box ends at y 577, mid-thigh; fit keeps that edge at or below the
  // window's bottom edge, so she is never cut or faded where she shows.
  const CHAR_BOX = 'left:226.1px;top:-471.2px;width:786px;height:1048px'
  const DRONE_BOX = 'left:716px;top:108px;width:76px;height:76px'
  // While she lifts the wrench her head leans into the drone's spot, and
  // then she wipes her nose (clip 1.5-3.6 s), so it flies up and to the right
  // out of the way, and comes back once her hand is down at her chest for the
  // thumbs-up (seconds into the intro: leave, arrive, start back, back). It
  // stays inside x 855, the right edge the band keeps on screen.
  // The drone floats behind her (her hair and arm pass in front of it). It
  // flies in from the window's lower left, under the lettering, on
  // a curve (FLIGHT, a cubic Bezier from off the window to its place by her
  // shoulder, band px from that place; it crosses behind her body and comes
  // out by her shoulder), fast at first, then slowing, a
  // little past its place and back, banked into its turns.
  const FLIGHT = [[-900, 400], [-520, 480], [-210, 170], [0, 0]]
  const FLIGHT_AT = 0.25
  const FLIGHT_S = 1.6
  const DODGE = [1.75, 2.2, 3.8, 4.4]
  const DODGE_TO = '60px,-180px'

  // Cyber-apocalypse lettering on the backdrop, the block about y 168:
  // the skill name as an italic neon sign (baked by tools/build-title.py,
  // 390x117 band px) that is dark at first and catches letter by letter like a
  // broken light, then a stamped tag, a terminal line typing out under a
  // hazard stripe, and the greeting typed at a prompt.
  const TITLE_BOX = 'left:40px;top:92px;width:390px;height:117px'
  // The whole block is drawn at this size, from its left end on y 168.
  const WORDS_SCALE = 1.15
  // and moved up and left of where the panel's text was, clear of her hand
  // and of the wrench as she lifts it overhead (about 2.1 s), which used to
  // cover the right of 核.
  const WORDS_SHIFT = [-128, -20]
  const MONO = "'SF Mono',Menlo,'PingFang SC','Hiragino Sans GB',monospace"
  const SANS = "'PingFang SC','Hiragino Sans GB','Noto Sans CJK SC',sans-serif"
  const SUB_AT = 1.75
  const SUB_STEP = 0.03
  const GREET_AT = 2.15
  const GREET_STEP = 0.055
  // Where each letter of the sign starts and ends in its box at its middle
  // height (x, %), and how far its italic slant moves that at the top and
  // bottom (%): printed by tools/build-title.py.
  const LETTERS = [[0, 27.9], [27.9, 50.1], [50.1, 72.5], [72.5, 100]]
  const TITLE_SLANT = 3.3
  const letterClip = ([from, to]) => {
    const a = from === 0 ? -20 : from
    const b = to === 100 ? 120 : to
    return `polygon(${a + TITLE_SLANT}% 0,${b + TITLE_SLANT}% 0,${b - TITLE_SLANT}% 100%,${a - TITLE_SLANT}% 100%)`
  }

  // Its keyframes, sampled every 4% so they need no timing function.
  function flightFrames() {
    const [a, b, c, d] = FLIGHT
    const point = u => {
      const v = 1 - u
      return [0, 1].map(k => v * v * v * a[k] + 3 * v * v * u * b[k] + 3 * v * u * u * c[k] + u * u * u * d[k])
    }
    // Easing out, a little past its place near the end and back.
    const travel = t => (1 - (1 - t) ** 2) * (1 + 0.08 * Math.sin(Math.PI * t))
    const stops = []
    for (let i = 0; i <= 25; i++) {
      const t = i / 25
      const [x, y] = point(travel(t))
      const [x2] = point(travel(Math.min(1, t + 0.02)))
      const [x0] = point(travel(Math.max(0, t - 0.02)))
      const bank = Math.max(-16, Math.min(16, (x2 - x0) * 0.06))
      const opacity = Math.min(1, t / 0.1)
      stops.push(`${+(t * 100).toFixed(1)}%{opacity:${opacity.toFixed(2)};transform:${t === 1 ? 'none' : `translate(${n(x)}px,${n(y)}px) rotate(${n(bank)}deg)`}}`)
    }
    return `@keyframes pind{${stops.join('')}}`
  }

  // Types text out a character at a time from `start` seconds, a block
  // cursor riding at its end; the cursor stays blinking on the last one for
  // `linger` blinks (Infinity: until the end).
  function typed(text, start, step, linger) {
    const chars = [...text]
    return chars.map((char, i) => {
      const last = i === chars.length - 1
      const style = `--d:${(start + i * step).toFixed(3)}s;--s:${step}s${last ? `;--b:${linger === Infinity ? 'infinite' : linger}` : ''}`
      return `<span class="ch${last ? ' last' : ''}" style="${style}">${escape(char)}</span>`
    }).join('')
  }

  const STYLE = `
#band{position:relative;width:800px;height:300px}
.escHint{position:fixed;right:22px;top:20px;z-index:9;width:156px;height:30px;pointer-events:none;opacity:0;animation:flick .45s linear .8s both}
.escHint svg{position:absolute;inset:0;display:block}
.escText{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;white-space:nowrap;font:600 12px/1 ${MONO};letter-spacing:1px;color:${ORANGE_HI};text-shadow:0 0 6px rgba(226,117,71,.6)}
.escHint.off{animation:escOff .2s linear both}
@keyframes escOff{from{opacity:1}to{opacity:0}}
.escSlash{color:${ORANGE};letter-spacing:0;margin-right:7px}
.escKey{margin:0 6px;padding:3px 5px 2px;border:1px solid ${ORANGE_HI};background:rgba(226,117,71,.16);font-weight:700;letter-spacing:1.5px}
#band *{position:absolute;box-sizing:border-box}
#band svg,#band img{position:static;display:block}
.fill{inset:0}
.layer{width:100%;height:100%}
i{display:block}
.fx{inset:0;animation:fx ${SPAN}s linear both}
.bgdrift{inset:0;animation:bgdrift ${SPAN}s ease-out both}
.gear{animation:spin 22s linear infinite}
.gear.rev{animation-direction:reverse;animation-duration:14s}
.gear.slow{animation-duration:40s}
.slash{inset:0;animation:slash .5s cubic-bezier(.2,.9,.3,1) .1s both}
.slash2{animation-delay:.16s}.slash3{animation-delay:.22s}
.speed{inset:0;animation:speed ${SPAN}s linear both}
.line{left:-1600px;width:4000px;background-size:800px 100%;background-repeat:repeat-x}
.sa{animation:dash .42s linear infinite}.sb{animation:dash .7s linear infinite}.sc{animation:dash 1.1s linear infinite}
.em,.emf{border-radius:50%;opacity:0;animation:ember 3s ease-out infinite}
.emf{animation-name:emberf;box-shadow:0 0 1.4px currentColor}
.e1{animation-duration:2.4s}.e2{animation-duration:3.6s}
.d0{animation-delay:.3s}.d1{animation-delay:.8s}.d2{animation-delay:1.3s}.d3{animation-delay:1.9s}.d4{animation-delay:2.5s}
.pin{inset:0;animation:pin .44s cubic-bezier(.15,.9,.25,1) .18s both}
.pind{inset:0;animation:pind ${FLIGHT_S}s linear ${FLIGHT_AT}s both}
.drift{inset:0;transform-origin:50% 100%;animation:drift ${SPAN}s ease-out both}
.hold{inset:0}
.ddrift{inset:0;animation:ddrift ${SPAN}s ease-out both}
.ddodge{inset:0;animation:ddodge ${SPAN}s ease-in-out both}
.dbob{inset:0;animation:dbob 2.6s ease-in-out .8s infinite}
.cexit{inset:0;transform-origin:50% 60%;animation:cexit ${SPAN}s linear both}
.moving{inset:0;width:100%;height:100%}
.landingStage{position:fixed;inset:0;pointer-events:none}
.landingWrap{position:absolute;display:none}
.landingWrap>div{position:absolute}
#landingSlot{inset:0}
.landingWrap video{width:100%;height:100%;object-fit:fill}
.landingShadow{border-radius:50%;opacity:0;background:radial-gradient(closest-side,var(--ground-shadow,rgba(31,30,29,.2)) 45%,rgba(0,0,0,0) 100%)}
@media (prefers-color-scheme:dark){:root{--ground-shadow:rgba(0,0,0,.38)}}
.wideflash{left:${FIELD.x}px;top:${FIELD.y}px;width:${FIELD.w}px;height:${FIELD.h}px;background:#fff3e0;opacity:0;animation:wideflash ${SPAN}s linear both}
.screen{inset:0;mix-blend-mode:screen}
.glow{border-radius:50%;background:radial-gradient(closest-side,#fff6dc,rgba(255,179,71,.85) 30%,rgba(255,106,0,0))}
.eye{left:16px;top:28px;width:24px;height:24px;animation:pulse 1.4s ease-in-out .7s infinite}
.shock{left:593.5px;top:117.5px;width:85px;height:85px;border:5px solid #ffd08a;border-radius:50%;opacity:0;animation:shock .5s ease-out .58s both}
.flashline{left:-1200px;top:166px;width:3200px;height:4px;background:#fff6e0;transform-origin:1600px 2px;animation:flashline ${SPAN}s linear both}
.words{inset:0;animation:words ${SPAN}s linear both}
.big{inset:0;transform-origin:44px 168px;transform:translate(${WORDS_SHIFT[0]}px,${WORDS_SHIFT[1]}px) scale(${WORDS_SCALE})}
.tag{inset:0;transform-origin:170px 83px;animation:stamp .34s cubic-bezier(.2,1.4,.4,1) 1.55s both}
.tagflick{inset:0;animation:flick .5s linear 1.65s both}
.title{${TITLE_BOX}}
.t{inset:0}
.toff{animation:toff .12s linear .6s both}
.lit{opacity:0;animation:1.05s linear .72s both}
.k0{animation-name:catch0}.k1{animation-name:catch1}.k2{animation-name:catch2}.k3{animation-name:catch3}
.buzz1{inset:0;animation:buzz1 ${SPAN}s linear both}
.buzz3{inset:0;animation:buzz3 ${SPAN}s linear both}
.hot{opacity:0;animation:hot 1.05s linear .72s both}
.hot2{opacity:0;animation:hot2 ${SPAN}s linear both}
.slice{opacity:0}
.s1{clip-path:inset(14% 0 58% 0);animation:jit1 .26s linear 1.62s forwards}
.s2{clip-path:inset(50% 0 24% 0);animation:jit2 .26s linear 1.62s forwards}
.s3{clip-path:inset(30% 0 44% 0);animation:jit3 ${SPAN}s linear both}
.hazard{inset:0;transform-origin:52px 228px;animation:strip .3s ease-out 1.7s both}
.hud{inset:0;animation:flick .45s linear 2s both}
.hudline{inset:0;transform-origin:486px 253px;animation:strip .35s ease-out 2.1s both}
#band .term{position:absolute;white-space:pre;color:${WHITE}}
#band .term *{position:relative}
.sub{left:62px;top:211px;font:600 12px/15px ${MONO};letter-spacing:3.2px}
.sub .slashes{color:${ORANGE_HI};letter-spacing:0;margin-right:8px}
.greet{left:66px;top:241px;font:600 15px/20px ${SANS};color:${WHITE};text-shadow:0 0 6px rgba(226,117,71,.45)}
.prompt{color:${ORANGE_HI};margin-right:6px}
.ch{opacity:0;animation:type 1ms linear var(--d) both}
.ch::after{content:'';position:absolute;left:100%;top:1px;bottom:1px;width:.55em;background:${ORANGE_HI};opacity:0;animation:cursor var(--s) steps(1,end) var(--d)}
.techa{inset:0;animation:flick .4s linear 1.9s both}
.techb{inset:0;animation:flick .4s linear 2.9s both}
#band .hex{white-space:pre;font:600 10px/15px ${MONO};letter-spacing:2px;color:${ORANGE};opacity:0;animation:hexin ${SPAN}s linear both}
@keyframes hexin{0%,${at(.3)}{opacity:0}${at(.4)}{opacity:.3}${at(.46)}{opacity:.05}${at(.6)},${end(.6)}{opacity:.18}100%{opacity:0}}
.ch.last::after{animation:blink .8s steps(1,end) var(--d) var(--b)}
@keyframes fx{0%{opacity:0}${at(.22)},${end(.5)}{opacity:1}100%{opacity:0}}
@keyframes words{0%,${end(.55)}{opacity:1;transform:none}${end(.2)},100%{opacity:0;transform:translateX(-28px)}}
@keyframes flashline{0%{opacity:1;transform:scaleX(.2)}${at(.2)}{opacity:1;transform:scaleX(1)}${at(.4)},${end(.53)}{opacity:0;transform:scaleX(1)}${end(.26)}{opacity:1}100%{opacity:0}}
@keyframes slash{from{opacity:0;transform:translateX(220px)}to{opacity:1;transform:none}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes bgdrift{from{transform:translateX(10px)}to{transform:translateX(-16px)}}
@keyframes speed{0%{opacity:0}${at(.2)},${at(.92)}{opacity:.8}${at(1.72)},100%{opacity:.26}}
@keyframes dash{from{transform:translateX(0)}to{transform:translateX(800px)}}
@keyframes pin{0%{opacity:0;transform:translateX(380px) skewX(-14deg)}70%{opacity:1;transform:translateX(-14px) skewX(3deg)}100%{opacity:1;transform:none}}
${flightFrames()}
@keyframes drift{0%,${at(.66)}{transform:none}100%{transform:translateX(7px) scale(1.03)}}
@keyframes ddrift{0%,${at(.8)}{transform:none}100%{transform:translateX(14px)}}
@keyframes ddodge{0%,${at(DODGE[0])}{transform:none}${at(DODGE[1])},${at(DODGE[2])}{transform:translate(${DODGE_TO})}${at(DODGE[3])},100%{transform:none}}
@keyframes dbob{0%,100%{transform:translate(0,-6px) rotate(-3deg)}50%{transform:translate(-4px,7px) rotate(4deg)}}
@keyframes cexit{0%,${end(.6)}{opacity:1;transform:none}${end(.26)},100%{opacity:0;transform:scale(1.08) translateX(24px)}}
@keyframes pulse{0%,100%{opacity:.35;transform:scale(.92)}50%{opacity:.95;transform:scale(1.08)}}
@keyframes wideflash{0%,${at(.57)}{opacity:0}${at(.62)}{opacity:.42}${at(.86)},100%{opacity:0}}
@keyframes shock{from{opacity:1;transform:scale(.15)}to{opacity:0;transform:scale(4.5)}}
@keyframes stamp{0%{opacity:0;transform:scale(1.6)}60%{opacity:1;transform:scale(.96)}100%{opacity:1;transform:none}}
@keyframes flick{0%{opacity:0}12%{opacity:1}20%{opacity:.15}34%{opacity:1}42%{opacity:.4}54%,100%{opacity:1}}
@keyframes toff{from{opacity:0}to{opacity:1}}
@keyframes catch0{0%{opacity:0}5%{opacity:1}8%,17%{opacity:0}20%{opacity:.7}23%,38%{opacity:0}41%{opacity:1}45%{opacity:.2}50%,100%{opacity:1}}
@keyframes catch1{0%,28%{opacity:0}31%{opacity:.8}34%,52%{opacity:0}55%{opacity:1}58%{opacity:0}61%{opacity:.5}64%,78%{opacity:0}81%{opacity:1}84%{opacity:.25}89%,100%{opacity:1}}
@keyframes catch2{0%,11%{opacity:0}14%{opacity:1}17%,31%{opacity:0}34%{opacity:.9}38%{opacity:.1}44%,100%{opacity:1}}
@keyframes catch3{0%{opacity:0}3%{opacity:.6}6%,22%{opacity:0}25%{opacity:1}28%{opacity:0}31%{opacity:1}35%{opacity:.2}40%,100%{opacity:1}}
@keyframes buzz1{0%,${at(4.4)}{opacity:1}${at(4.44)}{opacity:.15}${at(4.5)}{opacity:1}${at(4.55)}{opacity:.4}${at(4.62)},100%{opacity:1}}
@keyframes buzz3{0%,${at(7.2)}{opacity:1}${at(7.24)}{opacity:.2}${at(7.3)},100%{opacity:1}}
@keyframes hot{0%,4%{opacity:0;transform:none}6%{opacity:.75;transform:translate(-9px,1px)}9%,40%{opacity:0;transform:none}42%{opacity:.6;transform:translate(7px,-1px)}46%,80%{opacity:0;transform:none}82%{opacity:.5;transform:translate(-5px,0)}86%,100%{opacity:0;transform:none}}
@keyframes hot2{0%,${at(3.1)}{opacity:0;transform:none}${at(3.14)}{opacity:.7;transform:translate(-8px,1px)}${at(3.2)}{opacity:0;transform:translate(6px,0)}${at(3.26)}{opacity:.5;transform:translate(4px,-1px)}${at(3.32)},${at(6.7)}{opacity:0;transform:none}${at(6.74)}{opacity:.6;transform:translate(7px,1px)}${at(6.82)},100%{opacity:0;transform:none}}
@keyframes jit1{0%{opacity:1;transform:translateX(-14px)}25%{transform:translateX(9px)}50%{transform:translateX(-5px)}75%{opacity:1;transform:translateX(2px)}100%{opacity:0;transform:none}}
@keyframes jit2{0%{opacity:1;transform:translateX(12px)}25%{transform:translateX(-8px)}50%{transform:translateX(4px)}75%{opacity:1;transform:translateX(-2px)}100%{opacity:0;transform:none}}
@keyframes jit3{0%,${at(3.1)}{opacity:0;transform:none}${at(3.12)}{opacity:1;transform:translateX(16px)}${at(3.2)}{opacity:1;transform:translateX(-9px)}${at(3.28)},${at(6.7)}{opacity:0;transform:none}${at(6.72)}{opacity:1;transform:translateX(-12px)}${at(6.8)},100%{opacity:0;transform:none}}
@keyframes strip{from{opacity:0;transform:scaleX(0)}to{opacity:1;transform:scaleX(1)}}
@keyframes type{to{opacity:1}}
@keyframes cursor{0%,100%{opacity:1}}
@keyframes blink{0%{opacity:1}50%{opacity:0}}
@keyframes ember{0%{opacity:0;transform:translate(0,0)}15%{opacity:1}100%{opacity:0;transform:translate(-22px,-60px)}}
@keyframes emberf{0%{opacity:0;transform:translate(0,0)}15%{opacity:1}100%{opacity:0;transform:translate(-50px,-110px)}}
@media (prefers-reduced-motion:reduce){.sa,.sb,.sc,.em,.emf,.gear,.dbob{animation:none}}
`

  const SLASH_FILL = '<linearGradient id="slashFill" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ff7a1a" stop-opacity="0"/><stop offset=".6" stop-color="#ff8a2a" stop-opacity=".12"/><stop offset="1" stop-color="#ffb35c" stop-opacity=".03"/></linearGradient>'
  const slash = (points, extra = '') => svg(800, 300, `<polygon points="${points}" fill="url(#slashFill)"${extra}/>`, SLASH_FILL)
  const gearAt = (x, y, outer, inner, teeth, kind = '') =>
    `<div class="gear ${kind}" style="left:${x - outer}px;top:${y - outer}px">${gear(outer, inner, teeth)}</div>`

  // The tag: a chamfered panel in her orange with dark caps (the way
  // Cyberpunk 2077 tags its HUD), a status block and a trail of slashes.
  const TAG = svg(800, 300,
    `<rect x="44" y="74" width="4" height="18" fill="${WHITE}"/>` +
    `<path d="M52 74H286L294 82V92H60L52 84Z" fill="${ORANGE}"/>` +
    `<text x="62" y="87" font-family="${MONO}" font-size="10.5" font-weight="800" letter-spacing="2.4" fill="${INK}">SECOND AWAKENING // 二次觉醒</text>` +
    `<path d="M300 74h7l-6 18h-7zM311 74h7l-6 18h-7zM322 74h7l-6 18h-7z" fill="${ORANGE}" opacity=".75"/>`)
  // A worn hazard stripe in her orange.
  const HAZARD = svg(800, 300,
    `<defs><pattern id="hz" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="skewX(-40)"><rect width="6" height="12" fill="${ORANGE}"/><rect x="6" width="6" height="12" fill="${INK}"/></pattern></defs>` +
    '<rect x="52" y="226" width="236" height="6" fill="url(#hz)" opacity=".9"/>' +
    `<path d="M98 226h7l-3 3h-4zM171 232h9l2-2h-6zM236 226h5l1 2h-6zM270 230h8v2h-9z" fill="${INK}"/>`)
  // Chamfered HUD corners around the greeting, a ticked rule running on.
  const HUD = svg(800, 300,
    `<g fill="none" stroke="${ORANGE_HI}" stroke-width="1.6" stroke-opacity=".9">` +
    '<path d="M54 250v-8l4-4h10"/><path d="M54 258v6l4 4h10"/><path d="M472 238h10l4 4v8"/><path d="M486 258v6l-4 4h-10"/></g>')
  // The corner hint (only Esc skips): the HUD's own chamfered frame, corner
  // brackets and ticks, in its orange, over a dark plate so it reads on
  // whatever Claude shows behind.
  const ESC_HINT = `<div id="escHint" class="escHint"><svg width="156" height="30" viewBox="0 0 156 30" aria-hidden="true">` +
    `<path d="M9 .75H155.25V21L147 29.25H.75V9Z" fill="rgba(20,11,7,.74)" stroke="${ORANGE_HI}" stroke-width="1.2" stroke-opacity=".85"/>` +
    `<g fill="none" stroke="${ORANGE_HI}" stroke-width="2"><path d="M.75 15V9L9 .75h7"/><path d="M155.25 15v6L147 29.25h-7"/></g>` +
    `<g stroke="${ORANGE}" stroke-width="1" opacity=".8"><path d="M24 29.25v-3"/><path d="M30 29.25v-2"/><path d="M36 29.25v-2"/><path d="M42 29.25v-2"/></g>` +
    '</svg><span class="escText"><span class="escSlash">///</span>按<span class="escKey">ESC</span>跳过</span></div>'
  const HUD_LINE = svg(800, 300,
    `<g stroke="${ORANGE}" stroke-width="1.2" opacity=".7"><path d="M492 253H760"/>` +
    Array.from({ length: 14 }, (_, i) => `<path d="M${500 + i * 19} 253v${i % 4 === 0 ? 6 : 3}"/>`).join('') + '</g>')
  // Small technical labels and a barcode, in her silver.
  const BARCODE = Array.from({ length: 28 }, (_, i) => `<rect x="${(340 + i * 3.4).toFixed(1)}" y="74" width="${i % 3 === 0 ? 2 : 1}" height="${i % 5 === 0 ? 12 : 10}"/>`).join('')
  const TECH_A = svg(800, 300,
    `<g fill="${SILVER}" opacity=".65">${BARCODE}</g>` +
    `<text x="440" y="83" font-family="${MONO}" font-size="7.5" letter-spacing="1.6" fill="${SILVER}" opacity=".7">SYS.BOOT 0x4C1A</text>`)
  const TECH_B = svg(800, 300,
    `<text x="62" y="282" font-family="${MONO}" font-size="7.5" letter-spacing="1.6" fill="${SILVER}" opacity=".6">NET_ID CLAUDE-07 // LINK STABLE // UPTIME 00:00:01</text>`)

  // moving: her clip goes into the .moving slot (play() puts the prepared
  // video there); otherwise her still body stands in for it.
  function introMarkup({ title, line }, moving = false) {
    const img = name => `<img class="layer" src="layers/${name}.webp" alt="">`
    // The shock ring sits on her chest, so it moves and grows with her.
    const onHer = 'left:0;top:0;width:800px;height:300px'

    return `<style>${STYLE}</style>
<div id="band">
<div class="fx">
<div class="bgdrift">
${gearAt(52, -40, 132, 112, 20)}${gearAt(330, -150, 70, 58, 12, 'rev')}${gearAt(-120, 420, 230, 196, 28, 'slow')}${gearAt(250, 470, 90, 76, 14, 'rev')}
<div class="slash">${slash(shard(90, 170))}</div>
<div class="slash slash2">${slash(shard(390, 100))}</div>
<div class="slash slash3">${slash(shard(660, 210), ' opacity=".7"')}</div>
</div>
<div class="speed">${SPEED_LINES}</div>
<div class="fill">${DATA_COLUMNS}</div>
<div class="fill">${EMBERS_BACK}</div>
<div class="wideflash"></div>
</div>
<div class="words"><div class="big">
<div class="hazard">${HAZARD}</div>
<div class="tag"><div class="tagflick">${TAG}</div></div>
<div class="title">
<div class="t toff">${img('title-off')}</div>
${LETTERS.map((letter, i) => `<div class="t${i % 2 ? ` buzz${i}` : ''}"><div class="t lit k${i}" style="clip-path:${letterClip(letter)}">${img('title')}</div></div>`).join('')}
<div class="t hot">${img('title-hot')}</div>
<div class="t hot2">${img('title-hot')}</div>
<div class="t slice s1">${img('title')}</div>
<div class="t slice s2">${img('title')}</div>
<div class="t slice s3">${img('title')}</div>
</div>
<div class="term sub"><span class="slashes ch" style="--d:${SUB_AT - 0.06}s;--s:.06s">///</span>${typed('CLAUDE // OVERCLOCK CORE', SUB_AT, SUB_STEP, 2)}</div>
<div class="techa">${TECH_A}</div>
<div class="hud">${HUD}</div>
<div class="hudline">${HUD_LINE}</div>
<div class="techb">${TECH_B}</div>
<div class="term greet"><span class="prompt">&gt;</span>${typed(`${title}。${line}`, GREET_AT, GREET_STEP, Infinity)}</div>
</div></div>
<div class="her" style="${DRONE_BOX}"><div class="cexit"><div class="pind"><div class="ddrift"><div class="ddodge"><div class="dbob">
${img('drone')}
<div class="screen"><i class="glow eye"></i></div>
</div></div></div></div></div></div>
<div class="her" style="${CHAR_BOX}"><div class="cexit" id="charExit"><div class="pin"><div class="drift"><div class="hold" id="charSlot">
${moving ? '<i class="moving"></i>' : img('body')}
</div></div></div></div></div>
<div class="fx">${EMBERS_FRONT}</div>
<div class="her" style="${onHer}"><i class="shock"></i></div>
<i class="flashline"></i>
</div>
<div id="landingStage" class="landingStage">
<div id="landingWrap" class="landingWrap">
<div id="landingSlot" class="fill"></div>
<div id="landingShadow" class="landingShadow"></div>
</div>
</div>
${ESC_HINT}`
  }

  // Messages to the native app: prepared, ready (the band is on screen),
  // stats, done, landed.
  function post(message) {
    const handler = root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.intro
    if (handler) handler.postMessage(message)
  }

  // Frame pacing for the log: how often a frame took longer than ~1.5 vsyncs.
  function measureFrames(span) {
    const gaps = []
    let last = 0
    const began = root.performance.now()
    const tick = now => {
      if (last) gaps.push(now - last)
      last = now
      if (now - began < span) return root.requestAnimationFrame(tick)
      gaps.sort((a, b) => a - b)
      const pick = q => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))].toFixed(1)
      post(`stats: frames=${gaps.length} fps=${(gaps.length / ((now - began) / 1000)).toFixed(1)} p50=${pick(0.5)}ms p95=${pick(0.95)}ms max=${pick(1)}ms over25ms=${gaps.filter(g => g > 25).length}`)
    }
    root.requestAnimationFrame(tick)
  }

  // The band is 800x300 design pixels, zoomed to fit the window and always
  // centred on it: the middle of its lettering (y 168) sits on the middle of
  // the window at any size, never pushed down. Across, it keeps LEFT (the
  // data columns) to her furthest reach on screen (RIGHT, as she lifts the
  // wrench, past the wrench's tip at rest), so the band is centred between
  // them, not on its own middle.
  //
  // She (with her drone) uses the whole window: she is scaled by grow about
  // her head's top (y -37) and x 855, and raised by rise, so that the wrench
  // lifted overhead (PEAK) comes EDGE below the window's top and her thighs
  // (SHOW) meet its bottom. The band is zoomed so that she stands GROW times
  // its size (her size beside the lettering, as chosen), more in a window too
  // narrow for that, up to GROW_MAX. In a window taller than that she stands
  // on its bottom edge. Her box's bottom edge (y CHAR_END) never shows.
  //
  // Her reaches were measured on every frame of layers/awakening.mov (alpha
  // over 25%), in band px at grow 1.
  const PANEL_MID = 168
  const HEAD = -37
  const ORIGIN_X = 855
  const WAIST = 429
  const SHOW = 563
  const CHAR_END = 577
  const PEAK = -204
  const DRONE_UP = -72
  const LEFT = -144
  const RIGHT = 844
  const EDGE = 8
  const GROW = 1.15
  const GROW_MAX = 1.35
  const REACH = ORIGIN_X + (RIGHT - ORIGIN_X) * GROW_MAX + EDGE
  const CENTRE_X = (LEFT + REACH) / 2
  function layout(width, height) {
    // Zoomed so that her whole lift, GROW times the band's size, fills the
    // window's height, unless the window is too narrow for her reach.
    const scale = Math.min(height / ((SHOW - PEAK) * GROW + EDGE), width / (REACH - LEFT))
    const bottom = PANEL_MID + height / (2 * scale)
    const top = 2 * PANEL_MID - bottom
    // The whole window is hers: the wrench at the top of her lift EDGE below
    // its top edge, her thighs on its bottom edge.
    const grow = Math.min(GROW_MAX, (bottom - top - EDGE) / (SHOW - PEAK))
    const lift = y => HEAD + (y - HEAD) * grow
    const rise = Math.min(lift(SHOW) - bottom, lift(PEAK) - top - EDGE)
    const half = width / (2 * scale)
    return { scale, left: 400 - CENTRE_X, top: 150 - PANEL_MID, grow, rise, sides: [CENTRE_X - half, CENTRE_X + half] }
  }

  function fit(document) {
    const band = document.getElementById('band')
    const { scale, left, top, grow, rise, sides } = layout(root.innerWidth, root.innerHeight)
    band.style.zoom = String(scale)
    band.style.left = `${left}px`
    band.style.top = `${top}px`
    // The data columns stand at the window's sides.
    for (const column of band.querySelectorAll('.hex')) {
      const offset = parseFloat(column.dataset.offset)
      column.style.left = `${(offset < 0 ? sides[0] : sides[1]) + offset}px`
    }
    for (const her of band.querySelectorAll('.her')) {
      her.style.transformOrigin = `${ORIGIN_X - parseFloat(her.style.left)}px ${HEAD - parseFloat(her.style.top)}px`
      her.style.transform = `translateY(${-rise}px) scale(${grow})`
    }
  }

  // Where setPet's rect (the pet clip frame, window px) places landing.mov's
  // own 1080x1920 canvas: LANDING_BOX's sub-rect lands exactly on rect (its
  // left and bottom edges already line up, x0 0 and y0+h 1, so only height
  // need solving for); parts of the canvas above or beside the window are
  // simply off the page, same as the clip's own corners never showing.
  function landingLayout(rect) {
    const height = rect.h / LANDING_BOX.h
    const width = height * 9 / 16
    return { left: rect.x - LANDING_BOX.x * width, top: rect.y + rect.h - height, width, height }
  }

  // The ground-contact ellipse within setPet's rect, in the same place
  // Resources/web/pet/pet.js's layoutShadow puts it within the pet clip
  // frame (PET_BOX is that function's `box`): centred under her feet
  // (PET_BOX's bottom edge), 125% of her bbox wide, 0.22 of that tall.
  function petShadowLayout(rect) {
    const [x0, y0, x1, y1] = PET_BOX
    const width = (x1 - x0) * 1.25 * rect.w
    const height = width * 0.22
    return { left: rect.x + ((x0 + x1) / 2) * rect.w - width / 2, top: rect.y + y1 * rect.h - height / 2, width, height }
  }

  let prepared = null
  let clip = null
  let exitClip = null
  let landingClip = null
  let frozen = false
  let petRect = null
  let petDoc = null
  let playStartedAt = null
  let lateNoted = false
  let ended = false
  // The scene's animations paused at HOLD_AT_MS (pet path), until she leaves.
  let held = null
  let released = false

  // Buffers a clip; resolves to the video, or null if it cannot play here.
  function loadClip(src) {
    return new Promise(resolve => {
      const video = root.document.createElement('video')
      const done = ok => {
        root.clearTimeout(timer)
        resolve(ok ? video : null)
      }
      const timer = root.setTimeout(() => done(false), 3000)
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'
      video.addEventListener('canplaythrough', () => done(true), { once: true })
      video.addEventListener('error', () => done(false), { once: true })
      video.src = src
      video.load()
    })
  }

  // Decodes every layer and buffers her clip, the exit and the landing up
  // front, so nothing arrives after the band opens: with a pet rect, the
  // ending hands off from one clip to the next with no gap to cover.
  function prepare() {
    prepared = prepared || Promise.all([
      loadClip(CLIP),
      loadClip(EXIT_CLIP),
      loadClip(LANDING_CLIP),
      ...LAYERS.map(name => {
        const image = new root.Image()
        image.src = `layers/${name}.webp`
        return image.decode()
      }),
    ]).then(([video, exit, landing]) => {
      clip = video
      if (clip) clip.className = 'moving'
      exitClip = exit
      landingClip = landing
      post(video ? 'note: clip buffered' : 'note: clip unavailable; using the still')
      post(exit && landing ? 'note: pet transition buffered' : 'note: pet transition unavailable; plain ending only')
      post('prepared')
    })
    return prepared
  }

  const reducedMotion = () => Boolean(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches)

  // True once a usable rect and both transition clips are in hand: the only
  // condition under which the ending hands off instead of fading her away.
  const petReady = () => Boolean(petRect && exitClip && landingClip)

  // Called by the native app once it knows the pet's geometry (see this
  // file's header), and again every so often while she plays. Only stores
  // the rect; the hand-off itself waits for her clip to reach its own last
  // frame (see play()), and the landing reads the latest rect. If the clips
  // were not buffered in time, or no rect arrives by PET_CONFIRM_BY_MS,
  // nothing here runs and the plain ending plays exactly as it always has.
  function setPet(rect) {
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) return
    if (!petRect && !frozen && playStartedAt !== null && !petConfirmable(Date.now() - playStartedAt)) {
      if (!lateNoted) post('note: pet rect arrived too late; plain ending')
      lateNoted = true
      return
    }
    petRect = { x: +rect.x, y: +rect.y, w: +rect.w, h: +rect.h }
    // Her .cexit fade is cancelled the moment the pet is confirmed (well
    // before it would start, around CORE_MS - 0.6s): disabled, not removed,
    // so her position/transform-origin are untouched, only the keyframes
    // that would fade and scale her away stop running.
    if (petDoc && petReady()) {
      const charExit = petDoc.getElementById('charExit')
      if (charExit) charExit.style.animation = 'none'
    }
  }

  // Only the scene's own timed keyframes hold; looping ones (gears, embers)
  // run on, so the held scene still looks alive.
  const timed = animation => Boolean(animation.effect) && animation.effect.getComputedTiming().iterations !== Infinity

  // The scene's time at ms after play() on the pet path, given when she has
  // left (releaseAt, the exit clip's end): as normal up to HOLD_AT_MS, still
  // while she leaps out, then on from there. seek() reads the scene through
  // this, so a recording shows exactly what playback does.
  const sceneMs = (ms, releaseAt) => ms < HOLD_AT_MS ? ms : ms < releaseAt ? HOLD_AT_MS : HOLD_AT_MS + ms - releaseAt

  // At HOLD_AT_MS, with a pet confirmed: stops the band's and backdrop's
  // timed keyframes right where their closing would begin. Only running
  // ones: play() on a finished animation would restart it from 0.
  function holdScene(document) {
    if (held || frozen || !petReady()) return
    held = document.getAnimations().filter(animation => timed(animation) && animation.playState === 'running')
    for (const animation of held) {
      animation.pause()
      animation.currentTime = HOLD_AT_MS
    }
  }

  // Once she is gone: the scene closes over SCENE_CLOSE_MS from where it held.
  function releaseScene() {
    if (!held || released || frozen) return
    released = true
    for (const animation of held) animation.play()
  }

  // Swaps her clip for the exit clip in the same CHAR_BOX slot, with no
  // fade: build-transition.sh lines exit.mov up on awakening.mov's own last
  // frame (position, scale, colour, the chest star), so
  // the swap is invisible. Falls back to the plain ending (the CORE_MS
  // timeout below posts 'done') if the pet was never confirmed ready.
  // She leaps out right across the top-right corner: the Esc hint goes first
  // (Esc itself keeps working until the very end).
  function hideEscHint(document) {
    const hint = document.getElementById('escHint')
    if (!hint) return
    if (frozen) hint.style.display = 'none'
    else hint.classList.add('off')
  }

  function handOff(document) {
    if (!petReady() || ended) return
    ended = true
    hideEscHint(document)
    const slot = document.getElementById('charSlot')
    if (slot) {
      slot.innerHTML = ''
      exitClip.className = 'moving'
      slot.appendChild(exitClip)
    }
    exitClip.play().catch(error => post(`note: exit clip did not play: ${error && error.message}`))
    exitClip.addEventListener('ended', () => {
      if (frozen) return
      // Gone once it ends, whatever its last frame holds, so no still of
      // her can linger over the app while she drops in.
      exitClip.style.visibility = 'hidden'
      // She drops back in only once the held scene has closed; if it never
      // held, it already closed at CORE_MS.
      const wait = held && !released ? SCENE_CLOSE_MS : 0
      releaseScene()
      root.setTimeout(() => frozen || landingOn(document), wait)
    }, { once: true })
    // A stalled exit clip must not keep the dark scene over Claude for good.
    root.setTimeout(releaseScene, (exitClip.duration || 0) * 1000 + 1000)
  }

  // Reveals landing.mov at the rect's own derived canvas and plays it
  // through to her landed, neutral pose; posts 'landed' once it is there
  // (never 'done' on this path -- see play()).
  function landingOn(document) {
    const { left, top, width, height } = landingLayout(petRect)
    const wrap = document.getElementById('landingWrap')
    const shadow = document.getElementById('landingShadow')
    const slot = document.getElementById('landingSlot')
    if (!wrap || !slot) return post('landed')
    wrap.style.left = `${left}px`
    wrap.style.top = `${top}px`
    wrap.style.width = `${width}px`
    wrap.style.height = `${height}px`
    wrap.style.display = 'block'
    if (shadow) {
      const rect = petShadowLayout(petRect)
      shadow.style.left = `${rect.left - left}px`
      shadow.style.top = `${rect.top - top}px`
      shadow.style.width = `${rect.width}px`
      shadow.style.height = `${rect.height}px`
      shadow.style.transition = 'none'
      shadow.style.opacity = '0'
      // A recording sets it per frame instead (seek(): landingShadowOpacity);
      // this wall-clock timer would run ahead of its slow snapshots.
      root.setTimeout(() => {
        if (frozen) return
        shadow.style.transition = 'opacity .3s linear'
        shadow.style.opacity = '1'
      }, LANDING_TOUCHDOWN_MS)
    }
    slot.innerHTML = ''
    slot.appendChild(landingClip)
    landingClip.play().catch(error => post(`note: landing clip did not play: ${error && error.message}`))
    landingClip.addEventListener('ended', () => post('landed'), { once: true })
  }

  async function play(document) {
    await prepare()
    const stage = document.getElementById('stage')
    stage.innerHTML = introMarkup(introText(new Date()), Boolean(clip))
    petDoc = document
    playStartedAt = Date.now()
    if (clip) {
      stage.querySelector('.moving').replaceWith(clip)
      if (!reducedMotion()) {
        root.setTimeout(() => frozen || clip.play().catch(error => post(`note: clip did not play: ${error && error.message}`)), CLIP_AT_MS)
      }
      // Her clip's own natural end (awakening.mov's last frame) is the one
      // moment the pet ending hands off from; without a pet it is a no-op,
      // and the CORE_MS timeout below posts 'done' once her .cexit fade
      // (unmodified CSS) has already taken her to opacity 0.
      clip.addEventListener('ended', () => frozen || handOff(document), { once: true })
      // setPet arrives after 'ready' below, by PET_CONFIRM_BY_MS at the
      // latest, before this; holdScene itself checks the pet is confirmed.
      if (!reducedMotion()) root.setTimeout(() => holdScene(document), HOLD_AT_MS)
    }
    if (petRect) setPet(petRect)  // setPet ran before play(): apply it now that the DOM exists
    fit(document)
    root.addEventListener('resize', () => fit(document))
    document.body.classList.add('playing')
    // No click handler: only Esc (Swift's key monitor) ends it early, as the
    // corner hint (#escHint) says; a click on her does nothing.
    measureFrames(DURATION_MS - 200)
    root.setTimeout(() => frozen || petReady() || ended || post('done'), CORE_MS)
    post('ready')
  }

  // For recordings: freezes every animation and her clip at ms after play(),
  // resolving once that moment is on screen, so frames can be taken however
  // slowly the snapshots come. Past her clip's own end, with a pet ready, ms
  // is read against the exit and then the landing clip in turn, mounting
  // each the same way the real hand-off does, and the scene's timed
  // keyframes through sceneMs, holding while she leaps out as playback does.
  async function seek(ms) {
    frozen = true
    const coreEnd = clip ? CLIP_AT_MS + (clip.duration || 0) * 1000 : Infinity
    const petPath = Boolean(clip) && petReady()
    const exitEnd = petPath ? coreEnd + (exitClip.duration || 0) * 1000 : Infinity
    const scene = petPath ? sceneMs(ms, exitEnd) : ms
    for (const animation of root.document.getAnimations()) {
      animation.pause()
      animation.currentTime = timed(animation) ? scene : ms
    }
    const seekVideo = async (video, at) => {
      video.pause()
      if (Math.abs(video.currentTime - at) > 0.0005) {
        await new Promise(resolve => {
          video.addEventListener('seeked', resolve, { once: true })
          video.currentTime = at
        })
      }
    }
    if (clip) {
      if (petPath && ms >= coreEnd) {
        if (!ended) handOff(root.document)
        // As in playback, the exit clip shows only until it ends: a recording
        // steps past its last frames, so it must not keep the last one it seeked.
        exitClip.style.visibility = ms < exitEnd ? '' : 'hidden'
        const landingAt = exitEnd + SCENE_CLOSE_MS
        if (ms < exitEnd) {
          await seekVideo(exitClip, Math.max(0, Math.min(exitClip.duration || 0, (ms - coreEnd) / 1000)))
        } else if (ms >= landingAt) {
          if (root.document.getElementById('landingWrap').style.display !== 'block') landingOn(root.document)
          const shadow = root.document.getElementById('landingShadow')
          if (shadow) shadow.style.opacity = String(landingShadowOpacity(ms - landingAt))
          await seekVideo(landingClip, Math.max(0, Math.min(landingClip.duration || 0, (ms - landingAt) / 1000)))
        }
      } else {
        await seekVideo(clip, Math.max(0, Math.min(clip.duration || 0, (ms - CLIP_AT_MS) / 1000)))
      }
    }
    await new Promise(resolve => root.requestAnimationFrame(() => root.requestAnimationFrame(resolve)))
  }

  const api = {
    DURATION_MS, CORE_MS, HOLD_AT_MS, SCENE_CLOSE_MS, PET_CONFIRM_BY_MS, petConfirmable, LINES, NIGHT_LINES, CLIP, CLIP_AT_MS, EXIT_CLIP, LANDING_CLIP,
    PET_BOX, LANDING_BOX, LANDING_TOUCHDOWN_MS, landingShadowOpacity, PEAK, RIGHT,
    introText, introMarkup, layout, landingLayout, petShadowLayout, sceneMs, setPet, prepare, play, seek,
  }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.ClaudeIntro = api
})(typeof window === 'undefined' ? globalThis : window)
