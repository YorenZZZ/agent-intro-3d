// Claude Pet: the desktop pet panel. A long-lived, one-per-process
// PetController owns a borderless, non-activating NSPanel that floats a
// WKWebView (Resources/web/pet/) above the blank area at the bottom of
// Claude's left sidebar. Her body lives entirely in pet.js/the clips; this
// file only tracks where Claude's window is, decides when she may be shown,
// and forwards mouse/quota/menu events across the "pet" message bridge.
//
// Compiled together with main.swift (build.sh passes both to one swiftc
// invocation), so it reuses AppWindow.cocoa/Log from there directly.
import AppKit
import WebKit

// MARK: - Pure geometry (contract #3)

// Her alpha bbox in the neutral pose, normalised 0..1 of the clip frame
// (x/y origin top-left, y growing downward, matching clips.json `box`).
struct PetBox {
  let x0: CGFloat
  let y0: CGFloat
  let x1: CGFloat
  let y1: CGFloat
}

enum PetLayout {
  // 300 (was 260, 2026-10-11: "a little bigger"): the widest pose union
  // (sit/feet) still clears the default 242pt sidebar by >= edgeMargin.
  static let charHeightMax: CGFloat = 300
  static let minCharHeight: CGFloat = 150
  static let feetGap: CGFloat = 52
  static let bubbleSpace: CGFloat = 120
  static let defaultSidebarWidth: CGFloat = 242
  static let defaultNarrowMax: CGFloat = 700
  // Minimum clearance kept between her silhouette (the UNION of every
  // clip's alpha mask -- see unionMaskBox() below, not just the neutral
  // pose's own `box`) and each sidebar edge, so a wide pose like `sit`
  // still reads as standing inside the column, not touching the divider.
  static let edgeMargin: CGFloat = 6
  // Bottom band of the sidebar Claude's own account/profile row (and the
  // menu it opens upward) occupies; PetController's global mouse monitor
  // hides her while a click lands here.
  static let profileRowHeight: CGFloat = 52

  // A rect in the window's own top-left, y-down coordinates (points) -- the
  // convention CG/the web page use, and what ClaudeIntro.setPet expects.
  // Kept distinct from Cocoa's bottom-left NSRect so the two never get mixed
  // up by accident; PetController converts to Cocoa only at the screen edge.
  struct Rect { let x: CGFloat; let y: CGFloat; let w: CGFloat; let h: CGFloat }

  // offset: the user's drag offset actually applied (after clamping).
  struct Result { let frame: Rect; let panel: Rect; let offset: CGPoint }

  // windowSize: Claude's window size in points. box: clips.json's neutral-
  // pose `box`, used to anchor her horizontal stage position and plant her
  // feet (same as before). unionBox: the UNION of every clip's silhouette
  // (unionMaskBox()), used instead of `box` to size/cap the frame so a pose
  // that leans or spreads wider than standing idle still fits inside the
  // sidebar column with >= edgeMargin to spare on both sides. media:
  // clips.json's `size`. Returns nil when the pet must stay hidden:
  // collapsed sidebar, too-narrow window, too-narrow sidebar, or no
  // headroom left for her minimum height once the width cap is applied.
  // offset: where the user dragged her, relative to that default spot
  // (window points, y down); clamped below so she stays in the sidebar.
  static func compute(
    windowSize: NSSize, sidebarWidth: CGFloat, collapsed: Bool, narrowMax: CGFloat,
    box: PetBox, unionBox: PetBox, media: NSSize, offset: CGPoint = .zero
  ) -> Result? {
    guard !collapsed, windowSize.width >= narrowMax, media.width > 0, media.height > 0 else { return nil }
    let boxHeight = box.y1 - box.y0
    guard boxHeight > 0.01 else { return nil }

    var charHeight = min(charHeightMax, 0.30 * windowSize.height)
    var frameH = charHeight / boxHeight
    var frameW = frameH * media.width / media.height

    // Every pose shares the same standing x-anchor (sit/feet/snap/click
    // spread wider to one side or the other, but never move the stage
    // position itself) -- cap frameW so unionBox, centred around that
    // anchor at sidebarWidth/2, never comes within edgeMargin of either
    // sidebar edge, for ANY of them.
    let anchorX = (box.x0 + box.x1) / 2
    let leftSpan = max(anchorX - unionBox.x0, 0.01)
    let rightSpan = max(unionBox.x1 - anchorX, 0.01)
    let availableHalf = sidebarWidth / 2 - edgeMargin
    guard availableHalf > 0 else { return nil }
    let maxFrameW = availableHalf / max(leftSpan, rightSpan)
    if frameW > maxFrameW {
      let scale = maxFrameW / frameW
      frameW *= scale
      frameH *= scale
      charHeight = frameH * boxHeight
    }
    guard charHeight >= minCharHeight else { return nil }

    // A seated/crouching pose can reach slightly lower than standing idle's
    // own feet (crossed legs, a landed kick, ...) -- shift the whole frame
    // up by however far unionBox's bottom overshoots the neutral box's, so
    // the LOWEST point of ANY pose -- not just idle's -- stays feetGap above
    // the window bottom, never dipping into the profile row below it.
    let verticalOverflow = max(0, unionBox.y1 - box.y1)

    let centerX = sidebarWidth / 2
    let feetY = windowSize.height - feetGap
    let homeX = centerX - frameW * anchorX
    let homeY = feetY - frameH * box.y1 - frameH * verticalOverflow

    // A drag can put her anywhere in the sidebar column as long as every
    // pose (unionBox) keeps edgeMargin from both column edges, her lowest
    // point never sinks below the default feet line (the profile row is
    // under it), and the bubble band above her stays inside the window.
    let minDX = edgeMargin - (homeX + frameW * unionBox.x0)
    let maxDX = sidebarWidth - edgeMargin - (homeX + frameW * unionBox.x1)
    let minDY = bubbleSpace - homeY
    let dx = maxDX >= minDX ? min(max(offset.x, minDX), maxDX) : 0
    let dy = minDY <= 0 ? min(max(offset.y, minDY), 0) : 0

    let frameX = homeX + dx
    let frameY = homeY + dy
    let frame = Rect(x: frameX, y: frameY, w: frameW, h: frameH)
    let panel = Rect(x: frameX, y: frameY - bubbleSpace, w: frameW, h: frameH + bubbleSpace)
    return Result(frame: frame, panel: panel, offset: CGPoint(x: dx, y: dy))
  }

  // nil when the two rects do not overlap at all -- the hard safety net
  // (contract #2b) intersects the desired panel rect with the sidebar
  // column so nothing can ever paint past the divider or off the window,
  // regardless of what compute() above assumed.
  static func intersect(_ a: Rect, _ b: Rect) -> Rect? {
    let x0 = max(a.x, b.x), y0 = max(a.y, b.y)
    let x1 = min(a.x + a.w, b.x + b.w), y1 = min(a.y + a.h, b.y + b.h)
    guard x1 > x0, y1 > y0 else { return nil }
    return Rect(x: x0, y: y0, w: x1 - x0, h: y1 - y0)
  }
}

// MARK: - Claude's own window-layout file

// ~/Library/Application Support/Claude/config.json's bootFrameLayout, read
// at most every 1s (PetController throttles the calls; this just parses).
enum ClaudeConfig {
  struct BootFrameLayout {
    var sidebarWidth = PetLayout.defaultSidebarWidth
    var collapsed = false
    var narrowViewportMaxWidth = PetLayout.defaultNarrowMax
  }

  private static let url = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Claude/config.json")

  // Claude writes this at launch, not live, so a missing/partial file just
  // keeps whatever defaults/previous values the caller already has.
  static func bootFrameLayout(fallback: BootFrameLayout) -> BootFrameLayout {
    guard let data = try? Data(contentsOf: url),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let boot = root["bootFrameLayout"] as? [String: Any] else { return fallback }
    var layout = fallback
    if let width = boot["sidebarWidth"] as? Double { layout.sidebarWidth = CGFloat(width) }
    layout.collapsed = boot["collapsed"] as? Bool ?? false
    if let narrow = boot["narrowViewportMaxWidth"] as? Double { layout.narrowViewportMaxWidth = CGFloat(narrow) }
    return layout
  }

  // bootFrameLayout, then the sidebar's LIVE width/collapsed state on top
  // (ClaudeFrameStore) whenever Claude has one stored.
  static func current(fallback: BootFrameLayout) -> BootFrameLayout {
    var layout = bootFrameLayout(fallback: fallback)
    if let live = ClaudeFrameStore.sidebar() {
      layout.sidebarWidth = live.width
      layout.collapsed = live.collapsed
    }
    return layout
  }
}

// MARK: - Claude's live sidebar state

// config.json's bootFrameLayout is only written at launch, so once the user
// drags the sidebar's edge it is stale (242 there vs 337 on screen, seen
// 2026-10-11). Claude's web app keeps the live state in its localStorage
// key "dframe-store" -- {"state":{"collapsed":false,"sidebarWidth":337,...}}
// -- which Chromium flushes to a LevelDB folder within a few seconds of a
// change. Read straight from those files, read-only and lock-free: the
// newest sequence number across the write-ahead log and the sorted tables
// wins. Re-parsed only when the folder's files change.
enum ClaudeFrameStore {
  struct Sidebar: Equatable { let width: CGFloat; let collapsed: Bool }

  private static let folder = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Claude/Local Storage/leveldb")
  // Chromium's localStorage key layout: "_" + origin, 0x00, 0x01, key.
  private static let key: [UInt8] = Array("_https://claude.ai".utf8) + [0, 1] + Array("dframe-store".utf8)
  private static var lastSignature = ""
  private static var cached: Sidebar?

  static func sidebar() -> Sidebar? {
    let manager = FileManager.default
    guard let names = try? manager.contentsOfDirectory(atPath: folder.path) else { return nil }
    let files = names.filter { $0.hasSuffix(".log") || $0.hasSuffix(".ldb") }.sorted()
    var signature = ""
    for name in files {
      let attributes = try? manager.attributesOfItem(atPath: folder.appendingPathComponent(name).path)
      let size = (attributes?[.size] as? NSNumber)?.intValue ?? -1
      let modified = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
      signature += "\(name):\(size):\(modified);"
    }
    if signature == lastSignature { return cached }
    lastSignature = signature

    var newest: (seq: UInt64, value: [UInt8]?)?
    for name in files {
      // A compaction can delete a file between the listing and this read.
      guard let data = try? Data(contentsOf: folder.appendingPathComponent(name)) else { continue }
      let bytes = [UInt8](data)
      let found = name.hasSuffix(".log") ? LevelDB.logValues(bytes, key: key) : LevelDB.tableValues(bytes, key: key)
      for entry in found where newest == nil || entry.seq > newest!.seq { newest = entry }
    }
    let parsed = newest?.value.flatMap(parse)
    if parsed != cached, let parsed { Log.write("pet: Claude sidebar \(Int(parsed.width))pt\(parsed.collapsed ? ", collapsed" : "") (live)") }
    cached = parsed
    return parsed
  }

  // localStorage values: a 0 byte + UTF-16LE, or a 1 byte + Latin-1.
  private static func parse(_ value: [UInt8]) -> Sidebar? {
    guard let format = value.first else { return nil }
    let body = Data(value.dropFirst())
    let text: String?
    switch format {
    case 0: text = String(data: body, encoding: .utf16LittleEndian)
    case 1: text = String(data: body, encoding: .isoLatin1)
    default: return nil
    }
    guard let data = text?.data(using: .utf8),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let state = root["state"] as? [String: Any],
          let width = state["sidebarWidth"] as? Double, width >= 120, width <= 1200 else { return nil }
    return Sidebar(width: CGFloat(width), collapsed: state["collapsed"] as? Bool ?? false)
  }
}

// Just enough of LevelDB's on-disk format to find one key: the write-ahead
// log (32KB blocks of checksummed records holding write batches) and the
// sorted tables (snappy-compressed blocks of prefix-compressed entries,
// internal keys ending in an 8-byte sequence/type trailer). Every read is
// bounds-checked; anything malformed is simply skipped.
enum LevelDB {
  typealias Found = (seq: UInt64, value: [UInt8]?)

  // Lengths and offsets only (at most 5 bytes, < 2^35), so sums of a few
  // of them can never overflow Int even on garbage input.
  static func varint(_ bytes: [UInt8], _ index: inout Int) -> Int? {
    var result = 0
    var shift = 0
    while index < bytes.count, shift <= 28 {
      let byte = bytes[index]
      index += 1
      result |= Int(byte & 0x7f) << shift
      if byte < 0x80 { return result }
      shift += 7
    }
    return nil
  }

  private static func little(_ bytes: [UInt8], _ at: Int, _ count: Int) -> UInt64 {
    var value: UInt64 = 0
    for k in 0..<count { value |= UInt64(bytes[at + k]) << (8 * UInt64(k)) }
    return value
  }

  static func unsnappy(_ input: [UInt8]) -> [UInt8]? {
    var i = 0
    guard let length = varint(input, &i), length <= 64 << 20 else { return nil }
    var out: [UInt8] = []
    out.reserveCapacity(length)
    while i < input.count {
      let tag = input[i]
      i += 1
      if tag & 3 == 0 {
        var count = Int(tag >> 2)
        if count >= 60 {
          let extra = count - 59
          guard i + extra <= input.count else { return nil }
          count = Int(little(input, i, extra))
          i += extra
        }
        count += 1
        guard i + count <= input.count else { return nil }
        out.append(contentsOf: input[i..<(i + count)])
        i += count
      } else {
        let count: Int, offset: Int
        switch tag & 3 {
        case 1:
          guard i + 1 <= input.count else { return nil }
          count = Int((tag >> 2) & 7) + 4
          offset = (Int(tag >> 5) << 8) | Int(input[i])
          i += 1
        case 2:
          guard i + 2 <= input.count else { return nil }
          count = Int(tag >> 2) + 1
          offset = Int(little(input, i, 2))
          i += 2
        default:
          guard i + 4 <= input.count else { return nil }
          count = Int(tag >> 2) + 1
          offset = Int(little(input, i, 4))
          i += 4
        }
        guard offset > 0, offset <= out.count else { return nil }
        for _ in 0..<count { out.append(out[out.count - offset]) }
      }
    }
    return out.count == length ? out : nil
  }

  private static func block(_ data: [UInt8], offset: Int, size: Int) -> [UInt8]? {
    guard offset >= 0, size >= 0, offset + size < data.count else { return nil }
    let raw = Array(data[offset..<(offset + size)])
    switch data[offset + size] {
    case 0: return raw
    case 1: return unsnappy(raw)
    default: return nil
    }
  }

  private static func entries(_ block: [UInt8]) -> [(key: [UInt8], value: [UInt8])] {
    guard block.count >= 4 else { return [] }
    let restarts = Int(little(block, block.count - 4, 4))
    let end = block.count - 4 - 4 * restarts
    guard restarts >= 0, end >= 0 else { return [] }
    var out: [(key: [UInt8], value: [UInt8])] = []
    var key: [UInt8] = []
    var i = 0
    while i < end {
      guard let shared = varint(block, &i), let unshared = varint(block, &i), let length = varint(block, &i),
            shared <= key.count, i + unshared + length <= end else { break }
      key = Array(key[0..<shared]) + block[i..<(i + unshared)]
      i += unshared
      out.append((key, Array(block[i..<(i + length)])))
      i += length
    }
    return out
  }

  static func tableValues(_ data: [UInt8], key: [UInt8]) -> [Found] {
    guard data.count >= 48 else { return [] }
    let footer = Array(data[(data.count - 48)...])
    var i = 0
    guard varint(footer, &i) != nil, varint(footer, &i) != nil,
          let indexOffset = varint(footer, &i), let indexSize = varint(footer, &i),
          let index = block(data, offset: indexOffset, size: indexSize) else { return [] }
    var found: [Found] = []
    for (_, handle) in entries(index) {
      var j = 0
      guard let offset = varint(handle, &j), let size = varint(handle, &j),
            let content = block(data, offset: offset, size: size) else { continue }
      for (internalKey, value) in entries(content)
      where internalKey.count == key.count + 8 && internalKey.starts(with: key) {
        let trailer = little(internalKey, key.count, 8)
        found.append((trailer >> 8, trailer & 0xff == 1 ? value : nil))
      }
    }
    return found
  }

  static func logValues(_ data: [UInt8], key: [UInt8]) -> [Found] {
    let blockSize = 32768
    var found: [Found] = []
    var record: [UInt8] = []
    var i = 0
    while i + 7 <= data.count {
      let left = blockSize - i % blockSize
      if left < 7 { i += left; continue }
      let length = Int(little(data, i + 4, 2))
      let type = data[i + 6]
      if type == 0 && length == 0 { i += left; continue }
      guard i + 7 + length <= data.count else { break }
      record += data[(i + 7)..<(i + 7 + length)]
      i += 7 + length
      switch type {
      case 1, 4: found += batch(record, key: key); record = []
      case 2, 3: break
      default: record = []
      }
    }
    return found
  }

  // A write batch: sequence (8), count (4), then put (1, key, value) or
  // delete (0, key) entries numbered from that sequence.
  private static func batch(_ r: [UInt8], key: [UInt8]) -> [Found] {
    guard r.count >= 12 else { return [] }
    let first = little(r, 0, 8)
    var found: [Found] = []
    var i = 12
    var n: UInt64 = 0
    while i < r.count {
      let tag = r[i]
      i += 1
      guard tag <= 1, let keyLength = varint(r, &i), i + keyLength <= r.count else { break }
      let entryKey = Array(r[i..<(i + keyLength)])
      i += keyLength
      var value: [UInt8]?
      if tag == 1 {
        guard let valueLength = varint(r, &i), i + valueLength <= r.count else { break }
        value = Array(r[i..<(i + valueLength)])
        i += valueLength
      }
      if entryKey == key { found.append((first &+ n, value)) }
      n += 1
    }
    return found
  }
}

// MARK: - Window tracking / occlusion (contract #3, YOUR COMPONENT bullet 2)

struct PetWindowSnapshot {
  let claudeRectCG: CGRect     // global, top-left origin, y down (Quartz)
  let occludersCG: [CGRect]    // windows above Claude's main window that count
}

enum PetWindowTracker {
  // One CGWindowListCopyWindowInfo snapshot: finds Claude's main window
  // exactly like AppWindow.live(pid:) does (owner pid, layer 0, >=300x200,
  // largest), but also keeps its CG rect and z-order index so the windows
  // ahead of it (the list is already front-to-back) can be scanned for
  // occluders. nil when Claude has no matching on-screen window at all
  // (not running, minimised, another Space, or hidden).
  static func snapshot(claudePID: pid_t, ourPID: pid_t) -> PetWindowSnapshot? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    var claudeIndex: Int?
    var claudeRect: CGRect?
    var claudeArea: CGFloat = -1
    for (index, info) in list.enumerated() {
      guard info[kCGWindowOwnerPID as String] as? pid_t == claudePID,
            info[kCGWindowLayer as String] as? Int == 0,
            let bounds = info[kCGWindowBounds as String] as? NSDictionary,
            let rect = CGRect(dictionaryRepresentation: bounds),
            rect.width >= 300, rect.height >= 200 else { continue }
      let area = rect.width * rect.height
      if area > claudeArea { claudeArea = area; claudeRect = rect; claudeIndex = index }
    }
    guard let claudeIndex, let claudeRect else { return nil }
    var occluders: [CGRect] = []
    for index in 0..<claudeIndex {
      let info = list[index]
      // layer 0..<3: NSWindow.Level.floating is 3, so floating overlays
      // (ours among them -- the pet/intro panels are always .floating)
      // never count; Claude's own secondary windows above the main one
      // still do, which is why only OUR pid is excluded here, not Claude's.
      guard let layer = info[kCGWindowLayer as String] as? Int, layer >= 0, layer < 3,
            let pid = info[kCGWindowOwnerPID as String] as? pid_t, pid != ourPID,
            let bounds = info[kCGWindowBounds as String] as? NSDictionary,
            let rect = CGRect(dictionaryRepresentation: bounds) else { continue }
      occluders.append(rect)
    }
    return PetWindowSnapshot(claudeRectCG: claudeRect, occludersCG: occluders)
  }
}

// MARK: - Quota files (contract #4)

private struct PetQuotaPayload {
  let source: String
  let updatedAt: Date
  let json: [String: Any]
}

private enum PetQuotaSource {
  static let usageURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Claude Intro 3D/usage.json")
  static let historyURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Claude/plan-usage-history.json")

  // Robust to missing/partial/invalid JSON: any failure just yields nil so
  // the caller keeps whatever it last had.
  static func readUsage() -> PetQuotaPayload? {
    guard let data = try? Data(contentsOf: usageURL),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let updatedAtString = root["updatedAt"] as? String,
          let updatedAt = parseISODate(updatedAtString),
          let windows = root["windows"] as? [[String: Any]] else { return nil }
    let cleaned: [[String: Any]] = windows.compactMap { window in
      guard let kind = window["kind"] as? String, let percentUsed = window["percentUsed"] as? NSNumber else { return nil }
      var out: [String: Any] = ["kind": kind, "percentUsed": percentUsed]
      if let resetsAt = window["resetsAt"] as? String { out["resetsAt"] = resetsAt }
      return out
    }
    guard !cleaned.isEmpty else { return nil }
    let json: [String: Any] = ["source": "session", "updatedAt": updatedAtString, "windows": cleaned]
    return PetQuotaPayload(source: "session", updatedAt: updatedAt, json: json)
  }

  // JavaScript's toISOString() (what the plugin writes) carries milliseconds,
  // which a default ISO8601DateFormatter rejects; one formatter cannot accept
  // both forms, so try each.
  static func parseISODate(_ text: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
  }

  static func readHistory() -> PetQuotaPayload? {
    guard let data = try? Data(contentsOf: historyURL),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let samples = root["samples"] as? [[String: Any]], !samples.isEmpty else { return nil }
    // Newest by `t`, not just the last element, in case of any reordering.
    let newest = samples.max { lhs, rhs in
      ((lhs["t"] as? NSNumber)?.doubleValue ?? -1) < ((rhs["t"] as? NSNumber)?.doubleValue ?? -1)
    }
    guard let newest, let t = newest["t"] as? NSNumber, let usage = newest["u"] as? [String: Any] else { return nil }
    var windows: [[String: Any]] = []
    if let fh = usage["fh"] as? NSNumber { windows.append(["kind": "five_hour", "percentUsed": fh]) }
    if let sd = usage["sd"] as? NSNumber { windows.append(["kind": "seven_day", "percentUsed": sd]) }
    guard !windows.isEmpty else { return nil }
    let updatedAt = Date(timeIntervalSince1970: t.doubleValue / 1000)
    let json: [String: Any] = ["source": "history", "updatedAt": ISO8601DateFormatter().string(from: updatedAt), "windows": windows]
    return PetQuotaPayload(source: "history", updatedAt: updatedAt, json: json)
  }

  static func mtime(_ url: URL) -> Date? {
    (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
  }

  // The plugin applies the same minute (FRESH_MS in register.ts).
  static let freshSeconds: TimeInterval = 60
  static let requestURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Claude Intro 3D/refresh-request.json")

  // Drops a refresh request the pet-quota plugin polls for (every 2s, in
  // each open Claude Code session); false when it could not be written.
  static func requestRefresh() -> Bool {
    let millis = (Date().timeIntervalSince1970 * 1000).rounded()
    guard let data = try? JSONSerialization.data(withJSONObject: ["requestedAt": millis]) else { return false }
    do {
      try FileManager.default.createDirectory(at: requestURL.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: requestURL, options: .atomic)
      return true
    } catch {
      Log.write("pet: could not ask for a fresh quota reading: \(error.localizedDescription)")
      return false
    }
  }
}

// MARK: - clips.json geometry, read directly (early, before {type:'ready'})

// Decodes clips.json's per-clip `mask` exactly the way pet.js's maskHit()
// does (cols x rows grid, one hex-nibble sample every `every`th frame, 4
// cells per nibble MSB-first) and unions every clip's silhouette across
// every sampled frame into one bbox, rounded outward to whole grid cells.
// Used for PetLayout.compute's `unionBox` (contract #2a) instead of the
// neutral pose's own `box`, so a pose wider than standing idle (`sit`'s
// spread arms/legs, typically) is what actually gets kept inside the
// sidebar column -- not just the pose she happens to be in most often.
private func unionMaskBox(clips: [String: Any]) -> PetBox? {
  var minCol: Int?, maxCol: Int?, minRow: Int?, maxRow: Int?, cols = 0, rows = 0
  for (_, value) in clips {
    guard let clip = value as? [String: Any], let mask = clip["mask"] as? [String: Any],
          let c = mask["cols"] as? Int, let r = mask["rows"] as? Int, c > 0, r > 0,
          let frames = mask["frames"] as? [String] else { continue }
    cols = c
    rows = r
    for hex in frames {
      let digits = Array(hex)
      for cell in 0..<(c * r) {
        let nibbleIndex = cell >> 2
        guard nibbleIndex < digits.count, let digit = digits[nibbleIndex].hexDigitValue else { continue }
        let bit = 3 - (cell & 3)
        guard (digit >> bit) & 1 == 1 else { continue }
        let col = cell % c, row = cell / c
        minCol = min(minCol ?? col, col); maxCol = max(maxCol ?? col, col)
        minRow = min(minRow ?? row, row); maxRow = max(maxRow ?? row, row)
      }
    }
  }
  guard let minCol, let maxCol, let minRow, let maxRow, cols > 0, rows > 0 else { return nil }
  return PetBox(
    x0: CGFloat(minCol) / CGFloat(cols), y0: CGFloat(minRow) / CGFloat(rows),
    x1: CGFloat(maxCol + 1) / CGFloat(cols), y1: CGFloat(maxRow + 1) / CGFloat(rows)
  )
}

// Shared by PetController (early geometry) and PetSnapshotPlayer (panel
// sizing + script timing): box/unionBox/size for PetLayout, plus each
// clip's encoded `seconds` for timing a scripted --pet-snapshot run.
private func readBundledPetManifest() -> (box: PetBox, unionBox: PetBox, size: NSSize, seconds: [String: Double])? {
  guard let url = Bundle.main.url(forResource: "clips", withExtension: "json", subdirectory: "web/pet/clips"),
        let data = try? Data(contentsOf: url),
        let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let size = root["size"] as? [Double], size.count == 2,
        let box = root["box"] as? [Double], box.count == 4 else { return nil }
  var seconds: [String: Double] = [:]
  let clips = root["clips"] as? [String: Any] ?? [:]
  for (name, value) in clips {
    if let entry = value as? [String: Any], let s = entry["seconds"] as? Double { seconds[name] = s }
  }
  let neutralBox = PetBox(x0: box[0], y0: box[1], x1: box[2], y1: box[3])
  let unionBox = unionMaskBox(clips: clips) ?? neutralBox
  return (neutralBox, unionBox, NSSize(width: size[0], height: size[1]), seconds)
}

// The pet's clip-frame rect (points, from a window's top-left) in a stand-in
// Claude window, so --snapshot --landing can record the intro's pet ending
// without a live Claude window to measure.
func standInPetFrame(windowSize: NSSize) -> (x: Double, y: Double, w: Double, h: Double)? {
  guard let manifest = readBundledPetManifest(),
        let layout = PetLayout.compute(
          windowSize: windowSize, sidebarWidth: PetLayout.defaultSidebarWidth, collapsed: false,
          narrowMax: PetLayout.defaultNarrowMax, box: manifest.box, unionBox: manifest.unionBox, media: manifest.size)
  else { return nil }
  return (Double(layout.frame.x), Double(layout.frame.y), Double(layout.frame.w), Double(layout.frame.h))
}

// The page's ClaudePet.start() options, with clips.json inlined: WKWebView's
// fetch() cannot read file: URLs, so the page cannot load it by itself.
// Without a valid manifest the page falls back to fetching and reports the
// error, and the pet stays hidden.
func petStartOptions(reducedMotion: Bool, autoplay: Bool) -> String {
  var manifest = "null"
  if let url = Bundle.main.url(forResource: "clips", withExtension: "json", subdirectory: "web/pet/clips"),
     let data = try? Data(contentsOf: url),
     (try? JSONSerialization.jsonObject(with: data)) is [String: Any],
     let text = String(data: data, encoding: .utf8) {
    manifest = text
  }
  return "{reducedMotion: \(reducedMotion), autoplay: \(autoplay), manifest: \(manifest)}"
}

// Keeps WebKit rendering an off-screen view that would otherwise be judged
// occluded/invisible and stop decoding; same private selector IntroPlayer
// already uses for --snapshot, pulled out here so --pet-snapshot can share it
// without touching main.swift's existing, working copy.
private func disablePetOcclusionDetection(_ webView: WKWebView) {
  let selector = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
  guard webView.responds(to: selector) else {
    Log.write("pet-snapshot: cannot keep the off-screen web view rendering")
    return
  }
  typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
  unsafeBitCast(webView.method(for: selector), to: Setter.self)(webView, selector, false)
}

// MARK: - WKUserContentController holds its handler strongly; this proxy
// holds PetController only weakly so the controller (never otherwise
// retained in a cycle, but better safe) isn't kept alive by its own webview.

final class PetWeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
  private weak var target: WKScriptMessageHandler?
  init(target: WKScriptMessageHandler) { self.target = target }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}

// A panel that never takes keyboard focus or activates this app -- the pet
// floats over Claude without ever stealing it (unlike IntroPanel, which the
// intro briefly makes key so Esc can reach it).
final class PetPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

// The panel is never key, so without this a click on her would only be
// spent on focusing the window. The app's local mouse monitor normally takes
// the click first; this keeps the page's own pointer handler working too.
final class PetWebView: WKWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// The panel's contentView (contract #2b's hard safety net): flipped so its
// own coordinate system is top-left/y-down, the same convention every
// PetLayout.Rect in this file already uses, so positioning the (larger)
// webView inside it is a direct, unflipped offset -- see
// PetController.repositionWebView(). masksToBounds crops anything of the
// webView that falls outside it, on top of the panel's own frame already
// being the sidebar-clipped (smaller) rect.
final class PetContentHost: NSView {
  override var isFlipped: Bool { true }
}

// MARK: - PetController

// One per process, created once at startup (never for --play/--snapshot/
// --pet-snapshot) and never torn down; it outlives every Claude launch it
// watches. Owns the panel+webview, the 10Hz window tracker, the mouse
// tracker, the quota poller, and the menu.
final class PetController: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  private let ourPID = ProcessInfo.processInfo.processIdentifier
  private var panel: PetPanel?
  // The panel's contentView: a plain, flipped (top-left, y-down -- matching
  // every Rect in this file), layer-backed+masksToBounds view that crops the
  // (possibly larger) webView down to whatever of it is on screen. See
  // repositionWebView().
  private var contentHost: PetContentHost?
  private var webView: WKWebView?
  private var mouseClickMonitor: Any?
  private var globalMouseMonitor: Any?

  private var claudePID: pid_t?
  private var trackingTimer: Timer?
  private var mouseTimer: Timer?
  private var mouseTickScheduled = false
  private var wasInsidePanel = false

  private var config = ClaudeConfig.BootFrameLayout()
  private var lastConfigCheck = Date.distantPast

  private var ready = false
  private var manifestBox: PetBox?
  private var manifestSize: NSSize?
  private lazy var earlyManifest = readBundledPetManifest()

  private var holdingForIntro = false
  private var visible = false
  private var lastHiddenReason: String?
  private var nextShowFade = 0.2
  private(set) var lastFrameLocal: PetLayout.Rect?
  // The DESIRED (unclipped) panel rect and its sidebar-clipped on-screen
  // rect, both window-local (top-left, y-down), from the most recent
  // evaluate(): repositionWebView()/sendViewport() derive the webView's
  // offset from the difference between them, and mouseTick() derives page
  // coordinates from the desired one (never the clipped panel.frame).
  private var lastPanelLocal: PetLayout.Rect?
  private var lastClippedPanelLocal: PetLayout.Rect?
  private var lastDesiredPanelCocoa: NSRect?

  // Claude's own window rect, watched tick to tick to detect a drag/resize/
  // Space-switch/fullscreen-transition frame jump: hidden instantly (no
  // fade) the instant it changes, shown again only once it has held still
  // for settleDelay, so she never visibly trails behind the window.
  private var lastClaudeRectCG: CGRect?
  private var lastRectChangeAt = Date.distantPast
  private let settleDelay: TimeInterval = 0.3

  // Claude's own profile row opens its menu upward over exactly where she
  // stands; a global (cross-app) mouse-down monitor is the only way to see
  // a click INSIDE Claude's own window land there, since the pet panel
  // never becomes key and gets no such event itself.
  private var profileMenuSuppressed = false

  private var screenAsleep = false
  private var sessionInactive = false

  // Where the user dragged her, relative to her default spot (window
  // points, y down; PetLayout.compute clamps it to the sidebar). Kept in
  // UserDefaults so she stays put across launches.
  private var dragOffset = CGPoint(
    x: UserDefaults.standard.double(forKey: "petOffsetX"),
    y: UserDefaults.standard.double(forKey: "petOffsetY")
  )
  private var appliedOffset = CGPoint.zero
  // A left press on her: under dragThreshold of travel by release it is a
  // click (bubble + reaction, as before), past it a drag. Tracked by polling
  // the mouse, not events, so it keeps working whatever window is under
  // the pointer mid-drag.
  private var press: (mouse: NSPoint, offset: CGPoint, moved: Bool)?
  private var pressTimer: Timer?
  private let dragThreshold: CGFloat = 3
  private var lastHitInside = false

  private var quotaTimer: Timer?
  private var lastUsageMTime: Date?
  private var lastHistoryMTime: Date?
  private var lastQuotaSignature = "unset"
  // When the reading the bubble shows was taken (nil: none yet), and the
  // 1s re-check that runs for a while after asking the plugin for a new one.
  private var lastQuotaUpdatedAt: Date?
  private var quotaFastPoll: Timer?
  private var quotaFastPollUntil = Date.distantPast

  override init() {
    super.init()
    setUpPanel()
    setUpWorkspaceObservers()
    startQuotaPolling()
  }

  deinit {
    if let mouseClickMonitor { NSEvent.removeMonitor(mouseClickMonitor) }
    if let globalMouseMonitor { NSEvent.removeMonitor(globalMouseMonitor) }
  }

  // MARK: lifecycle driven by AppDelegate

  // Called whenever the set of running Claude processes changes (including
  // to nil when it quits). Starts/stops the tracker accordingly so no timer
  // is left running once Claude is gone; trackingTick() self-reschedules at
  // ~20Hz once an on-screen window is actually found, else 10Hz while it
  // keeps looking.
  func setClaudePID(_ pid: pid_t?) {
    guard pid != claudePID else { return }
    claudePID = pid
    if pid != nil {
      if trackingTimer == nil { scheduleTracking(after: 0) }
      evaluate()
    } else {
      trackingTimer?.invalidate()
      trackingTimer = nil
      holdingForIntro = false
      lastFrameLocal = nil
      lastClaudeRectCG = nil
      lastRectChangeAt = .distantPast
      profileMenuSuppressed = false
      hide("Claude 未运行", immediate: true)
    }
  }

  private func scheduleTracking(after interval: TimeInterval) {
    trackingTimer?.invalidate()
    trackingTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in self?.trackingTick() }
  }

  private func trackingTick() {
    evaluate()
    // 20Hz while Claude actually has an on-screen window to track closely
    // (so a drag/resize is caught within ~50ms); 10Hz while it does not
    // (not running, minimised, another Space) and there is nothing to track.
    scheduleTracking(after: lastClaudeRectCG != nil ? 1.0 / 20 : 0.1)
  }

  // The pet must not appear while this Claude launch's intro is playing.
  func holdForIntro() {
    holdingForIntro = true
    evaluate()
  }

  // Lets the intro (or AppDelegate, for the "already running" startup case)
  // reveal the pet with a specific one-shot fade; afterwards fades go back
  // to the normal 0.2s show/hide used for every later appearance.
  func reveal(fade: Double) {
    holdingForIntro = false
    nextShowFade = fade
    evaluate()
  }

  // The pet's clip-frame rect in the Claude window's own top-left
  // coordinates, for ClaudeIntro.setPet -- nil until geometry is known.
  func frameForIntro() -> (x: Double, y: Double, w: Double, h: Double)? {
    guard let f = lastFrameLocal else { return nil }
    return (Double(f.x), Double(f.y), Double(f.w), Double(f.h))
  }

  // MARK: panel + page setup

  private func setUpPanel() {
    guard let page = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web/pet") else {
      Log.write("pet: missing web/pet/index.html; the pet stays hidden for this run")
      return
    }
    let panel = PetPanel(contentRect: NSRect(x: 0, y: 0, width: 240, height: 380), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = .floating
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle, .stationary]
    panel.ignoresMouseEvents = true

    // contentHost is sized/kept in sync with the panel's own (possibly
    // sidebar-clipped, smaller-than-desired) content area by AppKit's normal
    // contentView autoresizing; webView is NOT autoresized with it -- its
    // frame is always the full, unclipped desired size, repositioned inside
    // contentHost on every evaluate() tick (repositionWebView()) so only the
    // part that overlaps the sidebar column ever actually shows.
    let contentHost = PetContentHost(frame: panel.contentLayoutRect)
    contentHost.wantsLayer = true
    contentHost.layer?.masksToBounds = true

    let configuration = WKWebViewConfiguration()
    configuration.userContentController.add(PetWeakScriptMessageHandler(target: self), name: "pet")
    configuration.mediaTypesRequiringUserActionForPlayback = []
    let webView = PetWebView(frame: panel.contentLayoutRect, configuration: configuration)
    webView.setValue(false, forKey: "drawsBackground")
    webView.navigationDelegate = self
    contentHost.addSubview(webView)
    panel.contentView = contentHost
    webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())

    self.panel = panel
    self.contentHost = contentHost
    self.webView = webView

    // Only events targeting our own panel are ever seen here: while
    // ignoresMouseEvents is true (the default, outside her silhouette) a
    // click is delivered straight to Claude's window instead, so this
    // monitor simply never fires for it.
    mouseClickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
      guard let self, let panel = self.panel, event.window === panel else { return event }
      if event.type == .leftMouseDown {
        self.beginPress()
      } else {
        self.showContextMenu(for: event, in: panel)
      }
      return nil
    }

    // Claude's own window never passes through our local monitor above (it
    // targets a different window), so seeing a click land on Claude's own
    // profile row -- which opens its account menu upward right over her --
    // needs a GLOBAL monitor instead. Mouse events need no Accessibility
    // permission.
    globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
      self?.handleGlobalMouseDown()
    }
  }

  // A click inside Claude's own profile row hides her immediately (the menu
  // it opens would otherwise cover her); she stays hidden through whatever
  // the user does with that menu and only re-evaluates ~settleDelay after
  // the NEXT mouse-down anywhere (a menu item, or a dismiss click elsewhere)
  // -- evaluate() itself also refuses to re-show her while suppressed, since
  // the regular tracker keeps ticking the whole time.
  private func handleGlobalMouseDown() {
    // Any click that reaches another app missed her (clicks on her land in
    // our own panel instead), so an open bubble closes.
    webView?.evaluateJavaScript("ClaudePet.dismiss()")
    let location = NSEvent.mouseLocation
    if !profileMenuSuppressed, isInsideProfileRow(location) {
      profileMenuSuppressed = true
      hide("点击了 Claude 账户区域，让开让菜单显示", immediate: true)
      return
    }
    if profileMenuSuppressed {
      profileMenuSuppressed = false
      DispatchQueue.main.asyncAfter(deadline: .now() + settleDelay) { [weak self] in self?.evaluate() }
    }
  }

  // MARK: click vs drag

  private func beginPress() {
    press = (NSEvent.mouseLocation, appliedOffset, false)
    pressTimer?.invalidate()
    pressTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.pressTick() }
  }

  private func pressTick() {
    guard var current = press else { return endPress() }
    let mouse = NSEvent.mouseLocation
    // Cocoa is y-up; window-local offsets are y-down.
    let dx = mouse.x - current.mouse.x
    let dy = current.mouse.y - mouse.y
    if !current.moved, hypot(dx, dy) >= dragThreshold {
      current.moved = true
      press = current
    }
    if current.moved {
      dragOffset = CGPoint(x: current.offset.x + dx, y: current.offset.y + dy)
      evaluate()
    }
    if NSEvent.pressedMouseButtons & 1 == 0 { endPress() }
  }

  private func endPress() {
    pressTimer?.invalidate()
    pressTimer = nil
    guard let finished = press else { return }
    press = nil
    panel?.ignoresMouseEvents = !lastHitInside
    if finished.moved {
      // Keep where she actually ended up, not where the pointer overshot.
      dragOffset = appliedOffset
      saveDragOffset()
      Log.write("pet: dragged to offset \(Int(dragOffset.x)),\(Int(dragOffset.y))")
    } else {
      webView?.evaluateJavaScript("ClaudePet.click()")
    }
  }

  // `./pet.sh quota on|off` writes petQuotaOnClick (default on); relayed to
  // the page whenever it changes, and again after every page load.
  private var sentQuotaOnClick: Bool?
  private var quotaOnClick: Bool { UserDefaults.standard.object(forKey: "petQuotaOnClick") as? Bool ?? true }

  private func syncQuotaOnClick() {
    guard ready else { return }
    let on = quotaOnClick
    guard on != sentQuotaOnClick else { return }
    sentQuotaOnClick = on
    webView?.evaluateJavaScript("ClaudePet.setQuotaEnabled(\(on))")
    Log.write("pet: quota on click \(on ? "on" : "off")")
  }

  private func saveDragOffset() {
    UserDefaults.standard.set(Double(dragOffset.x), forKey: "petOffsetX")
    UserDefaults.standard.set(Double(dragOffset.y), forKey: "petOffsetY")
  }

  private func isInsideProfileRow(_ location: NSPoint) -> Bool {
    guard let rect = lastClaudeRectCG else { return false }
    let rowCG = CGRect(
      x: rect.minX, y: rect.minY + rect.height - PetLayout.profileRowHeight,
      width: config.sidebarWidth, height: PetLayout.profileRowHeight
    )
    return AppWindow.cocoa(rowCG).contains(location)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    let reducedMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    webView.evaluateJavaScript("ClaudePet.start(\(petStartOptions(reducedMotion: reducedMotion, autoplay: false)))")
    Log.write("pet: page loaded (reducedMotion: \(reducedMotion))")
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    Log.write("pet: page failed to load: \(error.localizedDescription)")
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else {
      Log.write("pet: malformed message \(message.body)")
      return
    }
    switch type {
    case "ready":
      guard let size = body["size"] as? [Double], size.count == 2,
            let box = body["box"] as? [Double], box.count == 4 else { return }
      manifestSize = NSSize(width: size[0], height: size[1])
      manifestBox = PetBox(x0: box[0], y0: box[1], x1: box[2], y1: box[3])
      ready = true
      sentQuotaOnClick = nil
      Log.write("pet: ready (size \(size), box \(box))")
      evaluate()
    case "hit":
      lastHitInside = body["inside"] as? Bool ?? false
      // Mid-press the panel keeps the mouse; endPress() applies the latest.
      if press == nil { panel?.ignoresMouseEvents = !lastHitInside }
    case "click":
      Log.write("pet: clicked")
      if body["quota"] as? Bool == true { refreshQuotaForBubble() }
    case "menu":
      // Informational only -- the real menu is shown directly from the
      // right-mouse-down monitor below, since WKWebView's own contextmenu
      // handling isn't reliable while the panel never becomes key.
      Log.write("pet: menu requested at \(body["x"] ?? "?"),\(body["y"] ?? "?")")
    case "log":
      Log.write("pet: \(body["text"] ?? "")")
    case "error":
      Log.write("pet: error: \(body["message"] ?? "")")
    default:
      Log.write("pet: \(body)")
    }
  }

  // MARK: context menu

  private func showContextMenu(for event: NSEvent, in panel: PetPanel) {
    let menu = NSMenu()
    let snooze = NSMenuItem(title: "暂时隐藏 1 小时", action: #selector(snoozeOneHour), keyEquivalent: "")
    snooze.target = self
    let disable = NSMenuItem(title: "关闭桌面宠物", action: #selector(disablePet), keyEquivalent: "")
    disable.target = self
    let quota = NSMenuItem(title: "查看额度", action: #selector(viewQuotaFromMenu), keyEquivalent: "")
    quota.target = self
    menu.addItem(snooze)
    menu.addItem(disable)
    menu.addItem(.separator())
    if quotaOnClick { menu.addItem(quota) }
    if appliedOffset != .zero {
      let home = NSMenuItem(title: "回到默认位置", action: #selector(resetPosition), keyEquivalent: "")
      home.target = self
      menu.addItem(home)
    }
    guard let contentView = panel.contentView else { return }
    let point = contentView.convert(event.locationInWindow, from: nil)
    menu.popUp(positioning: nil, at: point, in: contentView)
  }

  @objc private func snoozeOneHour() {
    UserDefaults.standard.set(Date().addingTimeInterval(3600).timeIntervalSince1970, forKey: "petSnoozeUntil")
    Log.write("pet: snoozed for 1 hour")
    evaluate()
  }

  @objc private func disablePet() {
    UserDefaults.standard.set(false, forKey: "petEnabled")
    Log.write("pet: disabled from the menu")
    evaluate()
  }

  @objc private func viewQuotaFromMenu() {
    webView?.evaluateJavaScript("ClaudePet.click()")
  }

  @objc private func resetPosition() {
    dragOffset = .zero
    saveDragOffset()
    Log.write("pet: back to her default spot")
    evaluate()
  }

  // MARK: NSWorkspace

  private func setUpWorkspaceObservers() {
    let center = NSWorkspace.shared.notificationCenter
    center.addObserver(self, selector: #selector(onScreensSlept), name: NSWorkspace.screensDidSleepNotification, object: nil)
    center.addObserver(self, selector: #selector(onScreensWoke), name: NSWorkspace.screensDidWakeNotification, object: nil)
    center.addObserver(self, selector: #selector(onSessionResigned), name: NSWorkspace.sessionDidResignActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(onSessionBecameActive), name: NSWorkspace.sessionDidBecomeActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(onAppActivated), name: NSWorkspace.didActivateApplicationNotification, object: nil)
  }

  @objc private func onScreensSlept() { screenAsleep = true; hide("屏幕已休眠", immediate: true) }
  @objc private func onScreensWoke() { screenAsleep = false; evaluate() }
  @objc private func onSessionResigned() { sessionInactive = true; hide("用户会话未激活", immediate: true) }
  @objc private func onSessionBecameActive() { sessionInactive = false; evaluate() }
  @objc private func onAppActivated() { evaluate() }

  // MARK: show/hide

  private func effectiveGeometry() -> (box: PetBox, unionBox: PetBox, size: NSSize)? {
    guard let early = earlyManifest else { return nil }
    if ready, let box = manifestBox, let size = manifestSize { return (box, early.unionBox, size) }
    return (early.box, early.unionBox, early.size)
  }

  // The single per-tick decision: find Claude's window, lay the pet out
  // against it, and either show or hide with a reason. Runs at up to 20Hz
  // while Claude has an on-screen window (trackingTick()), plus on demand
  // from menu actions, wake/activate notifications, and
  // holdForIntro()/reveal().
  private func evaluate() {
    syncQuotaOnClick()
    guard let pid = claudePID else { hide("Claude 未运行", immediate: true); return }
    // A menu-suppressing click already hid her immediately; every tick
    // until the next mouse-down anywhere clears it (handleGlobalMouseDown())
    // must leave her hidden too, not fight that decision.
    if profileMenuSuppressed { hide("Claude 账户菜单可能开启"); return }
    guard let snapshot = PetWindowTracker.snapshot(claudePID: pid, ourPID: ourPID) else {
      lastFrameLocal = nil
      lastClaudeRectCG = nil
      hide("未找到 Claude 的屏上窗口（可能已最小化、在其他空间，或正在切换空间/全屏）", immediate: true)
      return
    }

    // A window move/resize/Space-switch/fullscreen transition shows up here
    // as the CG rect changing between ticks: hide instantly (no fade) the
    // moment that happens, and only consider showing again once it has held
    // perfectly still for settleDelay -- otherwise she visibly trails the
    // window instead of looking anchored to it.
    let rectChanged = lastClaudeRectCG != snapshot.claudeRectCG
    lastClaudeRectCG = snapshot.claudeRectCG
    if rectChanged {
      lastRectChangeAt = Date()
      hide("窗口正在移动或缩放", immediate: true)
      return
    }
    guard Date().timeIntervalSince(lastRectChangeAt) >= settleDelay else {
      hide("等待窗口静止")
      return
    }

    let windowCocoa = AppWindow.cocoa(snapshot.claudeRectCG)

    // Every second: cheap (the live sidebar state is only re-parsed when its
    // files change), and a sidebar resize then reaches her within ~1-6s.
    if Date().timeIntervalSince(lastConfigCheck) >= 1 {
      config = ClaudeConfig.current(fallback: config)
      lastConfigCheck = Date()
    }

    guard let geometry = effectiveGeometry() else {
      lastFrameLocal = nil
      hide("宠物素材（clips.json）尚不可用")
      return
    }
    guard let layout = PetLayout.compute(
      windowSize: windowCocoa.size, sidebarWidth: config.sidebarWidth, collapsed: config.collapsed,
      narrowMax: config.narrowViewportMaxWidth, box: geometry.box, unionBox: geometry.unionBox, media: geometry.size,
      offset: dragOffset
    ) else {
      lastFrameLocal = nil
      hide("侧栏已收起或窗口过窄，放不下宠物")
      return
    }
    appliedOffset = layout.offset
    // The TRUE, unclipped clip-frame rect -- frameForIntro() always returns
    // this, never the sidebar-clipped panel rect below, so the intro's
    // ending jump keeps landing on her real geometry regardless of any
    // Swift-side cropping.
    lastFrameLocal = layout.frame

    // Hard safety net (contract #2b): whatever compute() above assumed,
    // never let the panel actually cover more than the sidebar column of
    // Claude's own window.
    let sidebarColumn = PetLayout.Rect(x: 0, y: 0, w: config.sidebarWidth, h: windowCocoa.size.height)
    guard let clippedPanel = PetLayout.intersect(layout.panel, sidebarColumn) else {
      lastFrameLocal = nil
      hide("侧栏区域暂不可见")
      return
    }

    let frameCG = CGRect(
      x: snapshot.claudeRectCG.minX + layout.frame.x, y: snapshot.claudeRectCG.minY + layout.frame.y,
      width: layout.frame.w, height: layout.frame.h
    )
    if snapshot.occludersCG.contains(where: { $0.intersects(frameCG) }) {
      hide("被其他窗口遮挡")
      return
    }
    if holdingForIntro { hide("入场动画播放中"); return }
    let enabled = UserDefaults.standard.object(forKey: "petEnabled") as? Bool ?? true
    guard enabled else { hide("用户已关闭桌面宠物"); return }
    if let snoozeUntil = UserDefaults.standard.object(forKey: "petSnoozeUntil") as? Double,
       Date().timeIntervalSince1970 < snoozeUntil {
      hide("已暂时隐藏")
      return
    }
    if screenAsleep { hide("屏幕已休眠", immediate: true); return }
    if sessionInactive { hide("用户会话未激活", immediate: true); return }

    let desiredPanelCG = CGRect(
      x: snapshot.claudeRectCG.minX + layout.panel.x, y: snapshot.claudeRectCG.minY + layout.panel.y,
      width: layout.panel.w, height: layout.panel.h
    )
    let clippedPanelCG = CGRect(
      x: snapshot.claudeRectCG.minX + clippedPanel.x, y: snapshot.claudeRectCG.minY + clippedPanel.y,
      width: clippedPanel.w, height: clippedPanel.h
    )
    lastPanelLocal = layout.panel
    lastClippedPanelLocal = clippedPanel
    lastDesiredPanelCocoa = AppWindow.cocoa(desiredPanelCG)

    let fade = nextShowFade
    nextShowFade = 0.2
    show(at: AppWindow.cocoa(clippedPanelCG), fade: fade)
  }

  private func show(at cocoaRect: NSRect, fade: Double) {
    guard let panel else { return }
    panel.setFrame(cocoaRect, display: visible)
    repositionWebView()
    sendViewport()
    lastHiddenReason = nil
    if visible { return }
    visible = true
    panel.alphaValue = 0
    panel.orderFrontRegardless()
    NSAnimationContext.runAnimationGroup { context in
      context.duration = fade
      panel.animator().alphaValue = 1
    }
    Log.write("pet: shown (fade \(fade)s)")
    webView?.evaluateJavaScript("ClaudePet.setVisible(true)")
    startMouseTracking()
  }

  // Positions the (full-size, unclipped) webView inside the flipped
  // contentHost so the part of it that overlaps the panel's own (sidebar-
  // clipped, on-screen) bounds is exactly the part contentHost's
  // masksToBounds lets through -- a plain top-left offset since both
  // contentHost and every PetLayout.Rect already share the same
  // convention. A no-op until the first successful evaluate() has run.
  private func repositionWebView() {
    guard let webView, let panelLocal = lastPanelLocal, let clipped = lastClippedPanelLocal else { return }
    let offsetLeft = clipped.x - panelLocal.x
    let offsetTop = clipped.y - panelLocal.y
    webView.frame = NSRect(x: -offsetLeft, y: -offsetTop, width: panelLocal.w, height: panelLocal.h)
  }

  // Tells the page exactly which part of its own (full-size) layout is
  // actually visible on screen, in page px, so layoutBubble() can clamp the
  // bubble inside THAT instead of the whole (possibly partly cropped-off)
  // page -- see pet.js ClaudePet.setViewport().
  private func sendViewport() {
    guard let panelLocal = lastPanelLocal, let clipped = lastClippedPanelLocal else { return }
    let offsetLeft = clipped.x - panelLocal.x
    let offsetTop = clipped.y - panelLocal.y
    webView?.evaluateJavaScript("ClaudePet.setViewport({left: \(offsetLeft), top: \(offsetTop), width: \(clipped.w), height: \(clipped.h)})")
  }

  private func hide(_ reason: String, immediate: Bool = false) {
    guard let panel else { return }
    if visible {
      visible = false
      Log.write("pet: hidden (\(reason))")
      webView?.evaluateJavaScript("ClaudePet.setVisible(false)")
      stopMouseTracking()
      // Click-through again right away, not after the page's hit round trip.
      panel.ignoresMouseEvents = true
      if immediate {
        panel.alphaValue = 0
        panel.orderOut(nil)
      } else {
        NSAnimationContext.runAnimationGroup({ context in
          context.duration = 0.2
          panel.animator().alphaValue = 0
        }, completionHandler: { [weak panel] in panel?.orderOut(nil) })
      }
    } else if reason != lastHiddenReason {
      Log.write("pet: stays hidden (\(reason))")
    }
    lastHiddenReason = reason
  }

  // MARK: mouse tracking (30Hz inside the panel, 5Hz outside, only while shown)

  private func startMouseTracking() {
    guard !mouseTickScheduled else { return }
    mouseTickScheduled = true
    scheduleMouseTick(after: 0)
  }

  private func stopMouseTracking() {
    mouseTickScheduled = false
    mouseTimer?.invalidate()
    mouseTimer = nil
    if wasInsidePanel {
      wasInsidePanel = false
      webView?.evaluateJavaScript("ClaudePet.pointer(null)")
    }
  }

  private func scheduleMouseTick(after interval: TimeInterval) {
    mouseTimer?.invalidate()
    mouseTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in self?.mouseTick() }
  }

  private func mouseTick() {
    guard mouseTickScheduled, visible, let panel, let full = lastDesiredPanelCocoa else { return }
    let location = NSEvent.mouseLocation
    // "Inside" is the REAL on-screen (sidebar-clipped) panel -- her
    // silhouette can never actually be hit outside it, screen-wise.
    let inside = panel.frame.contains(location)
    if inside {
      // Page coords are relative to the web view's own top-left -- the
      // full, unclipped desired rect -- never the smaller clipped
      // panel.frame (contract #2b): a plain Cocoa (bottom-left, y up) ->
      // page (top-left, y down) flip against `full`, no screen-wide
      // conversion needed.
      let pageX = location.x - full.minX
      let pageY = full.maxY - location.y
      webView?.evaluateJavaScript("ClaudePet.pointer(\(pageX), \(pageY))")
      wasInsidePanel = true
    } else if wasInsidePanel {
      wasInsidePanel = false
      webView?.evaluateJavaScript("ClaudePet.pointer(null)")
    }
    scheduleMouseTick(after: inside ? 1.0 / 30 : 1.0 / 5)
  }

  // MARK: quota polling (contract #4)

  private func startQuotaPolling() {
    checkQuota()
    quotaTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.checkQuotaIfChanged() }
  }

  private func checkQuotaIfChanged() {
    let usageMTime = PetQuotaSource.mtime(PetQuotaSource.usageURL)
    let historyMTime = PetQuotaSource.mtime(PetQuotaSource.historyURL)
    guard usageMTime != lastUsageMTime || historyMTime != lastHistoryMTime else { return }
    lastUsageMTime = usageMTime
    lastHistoryMTime = historyMTime
    checkQuota()
  }

  private func checkQuota() {
    let usage = PetQuotaSource.readUsage()
    let history = PetQuotaSource.readHistory()
    let chosen: PetQuotaPayload?
    switch (usage, history) {
    case (nil, nil): chosen = nil
    case (let u?, nil): chosen = u
    case (nil, let h?): chosen = h
    case (let u?, let h?): chosen = u.updatedAt >= h.updatedAt ? u : h
    }
    let signature = chosen.map { "\($0.source)|\($0.updatedAt.timeIntervalSince1970)" } ?? "none"
    guard signature != lastQuotaSignature else { return }
    lastQuotaSignature = signature
    lastQuotaUpdatedAt = chosen?.updatedAt
    guard let chosen else {
      webView?.evaluateJavaScript("ClaudePet.setQuota(null)")
      return
    }
    guard let data = try? JSONSerialization.data(withJSONObject: chosen.json),
          let jsonText = String(data: data, encoding: .utf8) else { return }
    webView?.evaluateJavaScript("ClaudePet.setQuota(\(jsonText))")
    Log.write("pet: quota updated (\(chosen.source))")
  }

  // The quota bubble just opened: show the newest reading on disk right
  // away, and when it is over a minute old ask the pet-quota plugin (in any
  // open Claude Code session) for a fresh one -- however often she is
  // clicked, at most one ask per minute-old reading. The bubble re-renders
  // by itself once the new reading lands (setQuota).
  private func refreshQuotaForBubble() {
    lastUsageMTime = nil
    lastHistoryMTime = nil
    checkQuotaIfChanged()
    if let at = lastQuotaUpdatedAt, Date().timeIntervalSince(at) < PetQuotaSource.freshSeconds { return }
    guard PetQuotaSource.requestRefresh() else { return }
    Log.write("pet: asked for a fresh quota reading")
    quotaFastPollUntil = Date().addingTimeInterval(20)
    guard quotaFastPoll == nil else { return }
    quotaFastPoll = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] timer in
      guard let self else { return timer.invalidate() }
      self.checkQuotaIfChanged()
      let answered = self.lastQuotaUpdatedAt.map { Date().timeIntervalSince($0) < PetQuotaSource.freshSeconds } ?? false
      if answered || Date() >= self.quotaFastPollUntil {
        timer.invalidate()
        self.quotaFastPoll = nil
      }
    }
  }
}

// MARK: - --pet-snapshot verification mode

// Off-screen, script-driven capture of ONLY the pet page (never the full
// app window), modelled on IntroPlayer's --snapshot but simpler: the pet's
// clips play in real time (there is no ClaudeIntro.seek(ms) equivalent), so
// frames are grabbed on a wall-clock timer instead of a deterministic seek.
// Mouse-ignoring, never on screen, never key; terminates itself when done.
final class PetSnapshotPlayer: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  private let folder: URL
  private let every: Double
  private let script: [String]
  private let useQuotaSample: Bool
  private let standInSize: NSSize
  private var panel: PetPanel?
  private var webView: WKWebView?
  private var frameTimer: Timer?
  private var manifestSeconds: [String: Double] = [:]
  private let began = Date()

  init(folder: URL, every: Double, script: [String], useQuotaSample: Bool, standInSize: NSSize) {
    self.folder = folder
    self.every = every
    self.script = script
    self.useQuotaSample = useQuotaSample
    self.standInSize = standInSize
  }

  func start() {
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    guard let page = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web/pet") else {
      Log.write("pet-snapshot: missing web/pet/index.html")
      return NSApp.terminate(nil)
    }
    let manifest = readBundledPetManifest()
    manifestSeconds = manifest?.seconds ?? [:]
    let layout = manifest.flatMap {
      PetLayout.compute(windowSize: standInSize, sidebarWidth: PetLayout.defaultSidebarWidth, collapsed: false, narrowMax: PetLayout.defaultNarrowMax, box: $0.box, unionBox: $0.unionBox, media: $0.size)
    }
    let panelSize = layout.map { NSSize(width: $0.panel.w, height: $0.panel.h) } ?? NSSize(width: 360, height: 420)

    let standIn = AppWindow.standIn()
    let frame = NSRect(x: standIn.minX, y: standIn.minY, width: panelSize.width, height: panelSize.height)

    let panel = PetPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = .floating
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.ignoresMouseEvents = true

    let configuration = WKWebViewConfiguration()
    // Short-lived, one-shot process: unlike PetController's weak proxy, a
    // direct retain here just lives until NSApp.terminate(nil) below.
    configuration.userContentController.add(self, name: "pet")
    configuration.mediaTypesRequiringUserActionForPlayback = []
    let webView = WKWebView(frame: panel.contentLayoutRect, configuration: configuration)
    webView.autoresizingMask = [.width, .height]
    webView.setValue(false, forKey: "drawsBackground")
    webView.navigationDelegate = self
    disablePetOcclusionDetection(webView)
    panel.contentView = webView
    webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    panel.orderFrontRegardless()

    self.panel = panel
    self.webView = webView
    Log.write("pet-snapshot: panel \(NSStringFromRect(frame)), script \(script)")
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
      guard let self, !self.readied else { return }
      self.giveUp("not ready after 15 s")
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    webView.evaluateJavaScript("ClaudePet.start(\(petStartOptions(reducedMotion: false, autoplay: true)))")
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    giveUp("page failed to load: \(error.localizedDescription)")
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    if type == "ready" { onReady() } else if type == "error" { giveUp("\(body["message"] ?? "")") }
  }

  // A page that never becomes ready (no clips built yet, a media error)
  // must not leave a hidden process running forever.
  private func giveUp(_ reason: String) {
    guard !readied else { return Log.write("pet-snapshot: \(reason)") }
    Log.write("pet-snapshot: giving up: \(reason)")
    NSApp.terminate(nil)
  }

  private var readied = false

  private func onReady() {
    guard !readied else { return }
    readied = true
    // Each scripted clip (and the mid-run click's reaction) may first wait
    // up to one idle loop for a safe hand-over frame, so budget for that
    // too -- otherwise the last ones are cut off by the end of the run.
    let idleLoop = manifestSeconds["idle"] ?? 3
    let waits = script.isEmpty ? 0 : Double(script.count + 1) * idleLoop + (manifestSeconds["click"] ?? 0)
    let total = (script.isEmpty ? idleLoop : script.map { manifestSeconds[$0] ?? 1 }.reduce(0, +)) + waits + 2

    // Queue each scripted clip after the previous one starts, spaced by its
    // own encoded duration -- pet.js's own hand-over machinery does the rest.
    var delay: Double = 0
    for name in script {
      let fireAt = delay
      DispatchQueue.main.asyncAfter(deadline: .now() + fireAt) { [weak self] in
        self?.webView?.evaluateJavaScript("ClaudePet.play('\(name)')")
      }
      delay += manifestSeconds[name] ?? 1
    }

    if useQuotaSample {
      let now = Date()
      let quota: [String: Any] = [
        "source": "session",
        "updatedAt": ISO8601DateFormatter().string(from: now),
        "windows": [
          ["kind": "five_hour", "percentUsed": 34, "resetsAt": ISO8601DateFormatter().string(from: now.addingTimeInterval(20 * 60))],
          ["kind": "seven_day", "percentUsed": 8, "resetsAt": ISO8601DateFormatter().string(from: now.addingTimeInterval(3 * 86400))],
        ],
      ]
      if let data = try? JSONSerialization.data(withJSONObject: quota), let jsonText = String(data: data, encoding: .utf8) {
        webView?.evaluateJavaScript("ClaudePet.setQuota(\(jsonText))")
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + total / 2) { [weak self] in self?.webView?.evaluateJavaScript("ClaudePet.click()") }
    startCapture(duration: total)
  }

  private func startCapture(duration: Double) {
    let encoder = DispatchQueue(label: "pet-snapshot-encoder", qos: .utility)
    frameTimer = Timer.scheduledTimer(withTimeInterval: every, repeats: true) { [weak self] _ in
      guard let self, let webView = self.webView else { return }
      let ms = (Date().timeIntervalSince(self.began) * 1000).rounded()
      webView.takeSnapshot(with: nil) { image, error in
        if let image, let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
          encoder.async {
            let url = self.folder.appendingPathComponent(String(format: "pet-%05.0f.png", ms))
            guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { return }
            CGImageDestinationAddImage(destination, cgImage, nil)
            CGImageDestinationFinalize(destination)
          }
        } else {
          Log.write("pet-snapshot \(ms) failed: \(error?.localizedDescription ?? "no image")")
        }
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + duration) { [weak self] in
      guard let self else { return }
      self.frameTimer?.invalidate()
      encoder.sync {}
      Log.write("pet-snapshot: done")
      self.webView?.configuration.userContentController.removeScriptMessageHandler(forName: "pet")
      NSApp.terminate(nil)
    }
  }
}
