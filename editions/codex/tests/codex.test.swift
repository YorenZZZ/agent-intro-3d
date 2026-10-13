import Foundation

func check(_ condition: @autoclosure () -> Bool, _ message: String) {
  guard condition() else { fatalError(message) }
}
let now = Date()
let payload = CodexQuota.parse(["rateLimitsByLimitId": [
  "codex": ["primary": ["usedPercent": 1.0, "windowDurationMins": 10080.0, "resetsAt": now.timeIntervalSince1970 + 500]],
  "astra": ["limitName": "Astra", "primary": ["usedPercent": 120.0, "windowDurationMins": 300.0]]
]], at: now)
let rows = payload["windows"] as! [[String: Any]]
check(rows.count == 2, "all actual quota buckets must be represented")
check(rows[0]["label"] as? String == "本周", "primary Codex bucket must be first")
check(rows[0]["percentRemaining"] as? Double == 99, "used percent must become remaining percent")
check(rows[1]["percentRemaining"] as? Double == 0, "remaining percent must be clamped")
check(rows[1]["label"] as? String == "Astra · 5 小时", "bucket label and duration")
check(CodexQuota.parse([:], at: now)["error"] as? String == "unavailable", "missing data cannot mean 100% remaining")
let weekly = CodexQuota.parse(["rateLimits": ["primary": ["usedPercent": 0.0, "windowDurationMins": 10080.0]]], at: now)
check((weekly["windows"] as! [Any]).count == 1, "weekly-only plan must never invent a secondary window")

let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: folder) }
let launchedAt = Date(timeIntervalSince1970: 1_800_000_000)
func readyLine(at: Date, appearance: String = "primary", visible: Bool = true) -> String {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return "\(formatter.string(from: at)) info [electron-message-handler] [startup][renderer] app routes mounted after 7000ms rendererWebContentsId=1 rendererWindowAppearance=\(appearance) rendererWindowFocused=true rendererWindowId=1 rendererWindowVisible=\(visible)"
}
let mounted = readyLine(at: launchedAt.addingTimeInterval(7))
check(CodexAppReadiness.isReadyLine(mounted, launchedAt: launchedAt), "visible primary routes confirm application readiness")
check(!CodexAppReadiness.isReadyLine(readyLine(at: launchedAt.addingTimeInterval(-7)), launchedAt: launchedAt), "PID reuse must not accept an earlier process's ready log")
check(!CodexAppReadiness.isReadyLine(readyLine(at: launchedAt.addingTimeInterval(7), appearance: "avatarOverlay"), launchedAt: launchedAt), "pet and secondary renderers cannot unlock Esc")
check(!CodexAppReadiness.isReadyLine(readyLine(at: launchedAt.addingTimeInterval(7), visible: false), launchedAt: launchedAt), "a prewarmed hidden primary renderer cannot unlock Esc")
check(!CodexAppReadiness.isReadyLine("2027-01-15T08:00:00.000Z info [window-manager] window ready-to-show appearance=primary", launchedAt: launchedAt), "Electron's empty window shell is not application readiness")

let logDate = DateFormatter()
logDate.timeZone = TimeZone(secondsFromGMT: 0)
logDate.locale = Locale(identifier: "en_US_POSIX")
logDate.dateFormat = "yyyy/MM/dd"
let logFolder = folder.appendingPathComponent(logDate.string(from: launchedAt))
try FileManager.default.createDirectory(at: logFolder, withIntermediateDirectories: true)
let oldProcess = logFolder.appendingPathComponent("codex-desktop-session-123-t0-i1-000000-0.log")
let worker = logFolder.appendingPathComponent("codex-desktop-session-456-t1-i1-000000-0.log")
let mainProcess = logFolder.appendingPathComponent("codex-desktop-session-456-t0-i1-000000-0.log")
try (mounted + "\n").write(to: oldProcess, atomically: true, encoding: .utf8)
try (mounted + "\n").write(to: worker, atomically: true, encoding: .utf8)
let readiness = CodexAppReadiness(pid: 456, launchedAt: launchedAt, logs: folder)
check(!readiness.poll(at: launchedAt), "another process or worker's ready event must not unlock Esc")
try (readyLine(at: launchedAt.addingTimeInterval(-7)) + "\n").write(to: mainProcess, atomically: true, encoding: .utf8)
check(!readiness.poll(at: launchedAt), "the current filename can contain an older PID's log")
let readyHandle = try FileHandle(forWritingTo: mainProcess)
try readyHandle.seekToEnd()
let halfReady = mounted.count / 2
try readyHandle.write(contentsOf: Data(mounted.prefix(halfReady).utf8))
check(!readiness.poll(at: launchedAt), "partial renderer event must wait for its complete line")
try readyHandle.write(contentsOf: Data((String(mounted.dropFirst(halfReady)) + "\n").utf8))
try readyHandle.close()
check(readiness.poll(at: launchedAt.addingTimeInterval(86400)), "a complete current-process event must unlock, including after midnight")
try FileManager.default.removeItem(at: mainProcess)
check(readiness.poll(at: launchedAt.addingTimeInterval(86400)), "confirmed readiness persists for the lifetime of the intro")

let parent = folder.appendingPathComponent("old-chat.jsonl")
let child = folder.appendingPathComponent("child.jsonl")
let longChild = folder.appendingPathComponent("long-child.jsonl")
let longParent = folder.appendingPathComponent("long-parent.jsonl")
let partialChild = folder.appendingPathComponent("partial-child.jsonl")
let oversizedChild = folder.appendingPathComponent("oversized-child.jsonl")
let invalidMeta = folder.appendingPathComponent("invalid-meta.jsonl")
func metadata(source: Any, padding: Int) throws -> String {
  let data = try JSONSerialization.data(withJSONObject: ["type": "session_meta", "payload": [
    "source": source, "instructions": String(repeating: "x", count: padding)
  ]])
  return String(data: data, encoding: .utf8)! + "\n"
}
let childSource = ["subagent": ["thread_spawn": [:]]] as [String: Any]
let longChildMeta = try metadata(source: childSource, padding: 32768)
try longChildMeta.write(to: longChild, atomically: true, encoding: .utf8)
try metadata(source: "vscode", padding: 32768).write(to: longParent, atomically: true, encoding: .utf8)
try String(longChildMeta.prefix(17000)).write(to: partialChild, atomically: true, encoding: .utf8)
try metadata(source: childSource, padding: 1024 * 1024).write(to: oversizedChild, atomically: true, encoding: .utf8)
try "{\"type\":\"session_meta\",\"payload\":{}}\n".write(to: invalidMeta, atomically: true, encoding: .utf8)
let stale = ISO8601DateFormatter().string(from: now.addingTimeInterval(-3600))
try "{\"type\":\"session_meta\",\"payload\":{\"source\":\"vscode\"}}\n{\"type\":\"event_msg\",\"timestamp\":\"\(stale)\",\"payload\":{\"type\":\"task_complete\"}}\n".write(to: parent, atomically: true, encoding: .utf8)
try "{\"type\":\"session_meta\",\"payload\":{\"source\":{\"subagent\":{\"thread_spawn\":{}}}}}\n".write(to: child, atomically: true, encoding: .utf8)
let watcher = CodexTurnWatcher(sessions: folder)
check(!watcher.poll(), "starting must skip historical completions")
let dateFormatter = ISO8601DateFormatter()
dateFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
let stamp = dateFormatter.string(from: Date().addingTimeInterval(1))
let event = "{\"type\":\"event_msg\",\"timestamp\":\"\(stamp)\",\"payload\":{\"type\":\"task_complete\"}}"
func append(_ text: String, to file: URL) throws {
  let handle = try FileHandle(forWritingTo: file)
  defer { try? handle.close() }
  try handle.seekToEnd(); try handle.write(contentsOf: Data(text.utf8))
}
try append(event + "\n", to: child)
check(!watcher.poll(), "child completion must not pop a bubble")
try append(event + "\n", to: longChild)
check(!watcher.poll(), "a child header longer than 16 KiB must still suppress completions")
try append(String(longChildMeta.dropFirst(17000)) + event + "\n", to: partialChild)
check(!watcher.poll(), "a partial metadata line must wait for completion and remain a child session")
try append(event + "\n", to: oversizedChild)
try append(event + "\n", to: invalidMeta)
check(!watcher.poll(), "oversized or unclassified metadata must not be mistaken for parent sessions")
try append(event + "\n", to: longParent)
check(watcher.poll(), "a parent header longer than 16 KiB must still observe completions")
check(!watcher.poll(), "long parent completions must be observed only once")
try append(String(event.prefix(event.count / 2)), to: parent)
check(!watcher.poll(), "partial JSON line must wait")
try append(String(event.dropFirst(event.count / 2)) + "\n", to: parent)
check(watcher.poll(), "completed line must be observed")
check(!watcher.poll(), "each completion is observed once")

if CommandLine.arguments.contains("--live") {
  guard let cli = CodexQuota.executable(), let result = CodexQuota.read(executable: cli) else {
    fatalError("live subscription RPC failed")
  }
  let live = CodexQuota.parse(result, at: Date())
  check(live["error"] == nil, "live RPC must return usable subscription windows")
  print("Live subscription:", String(data: try JSONSerialization.data(withJSONObject: live), encoding: .utf8)!)
}
print("Codex native integration checks passed")
