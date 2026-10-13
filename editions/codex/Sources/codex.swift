// Codex integration: read layout, query subscription quota, and observe local turns.
// No model calls, engine plugins, provider balances, or copied credentials.
import Foundation
import Darwin

enum CodexState {
  static var home: URL {
    if let path = ProcessInfo.processInfo.environment["CODEX_HOME"], !path.isEmpty {
      return URL(fileURLWithPath: path, isDirectory: true)
    }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex", isDirectory: true)
  }

  static func read() -> [String: Any] {
    guard let data = try? Data(contentsOf: home.appendingPathComponent(".codex-global-state.json")),
          let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return state
  }
}

enum CodexQuota {
  static let freshSeconds: TimeInterval = 60

  static func executable() -> String? {
    let paths = [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "/opt/homebrew/bin/codex", "/usr/local/bin/codex"
    ]
    return paths.first { FileManager.default.isExecutableFile(atPath: $0) }
  }

  static func windowLabel(minutes: Double) -> String {
    if minutes == 10080 { return "本周" }
    if minutes == 1440 { return "每日" }
    if minutes >= 60, minutes.truncatingRemainder(dividingBy: 60) == 0 {
      return "\(Int(minutes / 60)) 小时"
    }
    return "\(Int(minutes)) 分钟"
  }

  // The server may supply multiple quota buckets. Do not silently substitute
  // another model's limits when the main Codex bucket is missing.
  static func parse(_ response: [String: Any], at date: Date) -> [String: Any] {
    var windows: [[String: Any]] = []
    var buckets: [(String, [String: Any])] = []
    if let byID = response["rateLimitsByLimitId"] as? [String: [String: Any]], !byID.isEmpty {
      let ids = byID.keys.sorted { a, b in a == "codex" ? b != "codex" : b == "codex" ? false : a < b }
      buckets = ids.compactMap { id in byID[id].map { (id, $0) } }
    } else if let legacy = response["rateLimits"] as? [String: Any] {
      buckets = [(legacy["limitId"] as? String ?? "codex", legacy)]
    }
    for (id, bucket) in buckets {
      let name = bucket["limitName"] as? String ?? id
      for key in ["primary", "secondary"] {
        guard let window = bucket[key] as? [String: Any],
              let used = window["usedPercent"] as? Double, used.isFinite,
              let minutes = window["windowDurationMins"] as? Double, minutes > 0 else { continue }
        let label = windowLabel(minutes: minutes)
        var row: [String: Any] = [
          "label": id == "codex" ? label : "\(name) · \(label)",
          "percentRemaining": max(0, min(100, 100 - used))
        ]
        if let reset = window["resetsAt"] as? Double, reset.isFinite, reset > 0 {
          row["resetsAt"] = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: reset))
        }
        windows.append(row)
      }
    }
    var payload: [String: Any] = ["source": "codex", "updatedAt": ISO8601DateFormatter().string(from: date)]
    if windows.isEmpty { payload["error"] = "unavailable" }
    else { payload["windows"] = windows }
    return payload
  }

  // A short-lived stdio client of the documented account/rateLimits/read RPC.
  // The CLI handles the existing Codex login; no token is read or exported here.
  static func read(executable: String, timeout: TimeInterval = 20) -> [String: Any]? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = ["app-server", "--listen", "stdio://"]
    process.currentDirectoryURL = FileManager.default.temporaryDirectory
    let input = Pipe(), output = Pipe()
    process.standardInput = input
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    do { try process.run() } catch { return nil }
    let stop = DispatchWorkItem {
      if process.isRunning { process.terminate() }
    }
    let hardStop = DispatchWorkItem {
      if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: stop)
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout + 2, execute: hardStop)
    defer {
      try? input.fileHandleForWriting.close()
      if process.isRunning { process.terminate() }
      process.waitUntilExit()
      stop.cancel(); hardStop.cancel()
      try? output.fileHandleForReading.close()
    }
    func send(_ message: [String: Any]) -> Bool {
      guard var data = try? JSONSerialization.data(withJSONObject: message) else { return false }
      data.append(10)
      do { try input.fileHandleForWriting.write(contentsOf: data); return true }
      catch { return false }
    }
    guard send(["id": 1, "method": "initialize", "params": ["clientInfo": [
      "name": "codex_intro_3d", "title": "Codex Intro 3D", "version": "1.2.0"
    ]]]) else { return nil }
    var buffer = Data()
    var initialized = false
    while process.isRunning {
      let chunk = output.fileHandleForReading.availableData
      if chunk.isEmpty { break }
      buffer.append(chunk)
      if buffer.count > 4 * 1024 * 1024 { return nil }
      while let newline = buffer.firstIndex(of: 10) {
        let line = buffer[..<newline]
        buffer.removeSubrange(...newline)
        guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let id = message["id"] as? Int else { continue }
        if id == 1, !initialized {
          guard message["result"] != nil else { return nil }
          initialized = true
          guard send(["method": "initialized"]),
                send(["id": 2, "method": "account/rateLimits/read"]) else { return nil }
        } else if id == 2 {
          return message["result"] as? [String: Any]
        }
      }
    }
    return nil
  }

  static func fetch(completion: @escaping ([String: Any]) -> Void) {
    DispatchQueue.global(qos: .utility).async {
      let payload: [String: Any]
      if let cli = executable() {
        if let response = read(executable: cli) { payload = parse(response, at: Date()) }
        else { payload = ["source": "codex", "error": "failed"] }
      } else { payload = ["source": "codex", "error": "missing"] }
      DispatchQueue.main.async { completion(payload) }
    }
  }
}

// Tail today's local rollouts incrementally. Each file is opened read-only;
// historical completions and subagent sessions never produce a new bubble.
final class CodexTurnWatcher {
  private struct Cursor {
    var offset: UInt64
    var pending = Data()
    // nil until a complete session_meta line is available. Never treat an
    // incomplete or unreadable header as a parent session.
    var child: Bool?
  }
  private let sessions: URL
  private var cursors: [String: Cursor] = [:]
  private var started = false
  private var lastScan = Date.distantPast
  private var files: [URL] = []
  private let began = Date()

  init(sessions: URL = CodexState.home.appendingPathComponent("sessions")) {
    self.sessions = sessions
  }

  private func isChild(_ handle: FileHandle) -> Bool? {
    // Actual rollout headers include instructions and can exceed 16 KiB.
    // Read only the first complete line, with a bound for malformed files.
    let maximum = 1024 * 1024
    var line = Data()
    do {
      try handle.seek(toOffset: 0)
      while line.count < maximum {
        guard let chunk = try handle.read(upToCount: min(16384, maximum - line.count)),
              !chunk.isEmpty else { return nil }
        if let newline = chunk.firstIndex(of: 10) {
          line.append(chunk[..<newline])
          guard let meta = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                meta["type"] as? String == "session_meta",
                let payload = meta["payload"] as? [String: Any] else { return nil }
          if let source = payload["source"] as? [String: Any] { return source["subagent"] != nil ? true : nil }
          if let source = payload["source"] as? String { return source == "subagent" }
          return nil
        }
        line.append(chunk)
      }
    } catch { return nil }
    return nil
  }

  @discardableResult func poll() -> Bool {
    if Date().timeIntervalSince(lastScan) >= 5 {
      // Include recently updated files from older chats, even when their
      // original rollout directory predates today. Only metadata is scanned.
      files = []
      if let entries = FileManager.default.enumerator(at: sessions,
          includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles]) {
        for case let file as URL in entries where file.pathExtension == "jsonl" {
          let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
          if cursors[file.path] != nil || Date().timeIntervalSince(modified) < 86400 { files.append(file) }
        }
      }
      lastScan = Date()
    }
    var completed = false
    for file in files {
      guard let attributes = try? FileManager.default.attributesOfItem(atPath: file.path),
            let size = attributes[.size] as? NSNumber,
            let handle = try? FileHandle(forReadingFrom: file) else { continue }
      defer { try? handle.close() }
      let length = size.uint64Value
      var cursor: Cursor
      if let existing = cursors[file.path], existing.offset <= length { cursor = existing }
      else {
        let offset = !started ? length : (length > 2 * 1024 * 1024 ? length - 2 * 1024 * 1024 : 0)
        cursor = Cursor(offset: offset)
      }
      if cursor.child == nil { cursor.child = isChild(handle) }
      guard let child = cursor.child else {
        cursors[file.path] = cursor
        continue
      }
      if length > cursor.offset, !child {
        try? handle.seek(toOffset: cursor.offset)
        cursor.pending.append(handle.readData(ofLength: Int(min(length - cursor.offset, 2 * 1024 * 1024))))
        cursor.offset = handle.offsetInFile
        while let newline = cursor.pending.firstIndex(of: 10) {
          let line = cursor.pending[..<newline]
          cursor.pending.removeSubrange(...newline)
          guard let message = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                message["type"] as? String == "event_msg",
                let payload = message["payload"] as? [String: Any] else { continue }
          if payload["type"] as? String == "task_complete",
             let stamp = message["timestamp"] as? String,
             let at = Self.timestamp(stamp), at >= began { completed = true }
        }
        if cursor.pending.count > 2 * 1024 * 1024 { cursor.pending.removeAll() }
      } else if child { cursor.offset = length }
      cursors[file.path] = cursor
    }
    started = true
    return completed
  }

  private static func timestamp(_ text: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
  }
}
