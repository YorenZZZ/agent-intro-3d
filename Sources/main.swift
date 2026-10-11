// Claude Intro 3D: plays the "second awakening" cut-in over the Claude desktop
// app's window while the app starts and its main view is still loading.
//
// Runs as a background agent (no Dock icon) that opens at login. When a new
// Claude process appears it covers the window Claude is about to open (the
// frame Claude saved last time, then the real window once it exists) with a
// borderless panel for about 12 seconds. Only Esc skips it (a hint in the
// corner says so); clicks and every other key do nothing.
//
//   claude-intro-3d                    background agent (the normal mode)
//   claude-intro-3d --play             play once now over Claude's window, then quit
//   claude-intro-3d --snapshot D [S]   render over a 1280x800 stand-in window, off screen
//                                      and ignoring the mouse, a frame
//                                      every S seconds (default 0.1) into folder D, named
//                                      by their ms (README previews; tools/record.sh);
//                                      --landing takes the pet ending (she lands
//                                      on the pet's spot in that stand-in window)
//                   [--size WxH]       with a stand-in of that size instead
//   claude-intro-3d --uninstall        stop opening at login, then quit
//   claude-intro-3d --watch ID         agent that reacts to another app (for testing)
//
// Also hosts the desktop pet (Sources/pet.swift): once the intro for a
// launch finishes (or there is none to play), a PetController shows her
// standing in Claude's left sidebar until Claude quits.
//   claude-intro-3d --pet on|off       enable/disable the pet, then start normally
//   claude-intro-3d --pet-snapshot D [S]   render ONLY the pet page, off screen,
//                                      a frame every S seconds (default 0.1) into D
//                   [--size WxH]       stand-in Claude window size (default 1152x1024)
//                   [--script a,b,c]   queue these clips in order via ClaudePet.play()
//                   [--quota sample]   feed a fixed sample quota so the bubble renders
import AppKit
import ServiceManagement
import WebKit

let claudeBundleID = "com.anthropic.claudefordesktop"
// ClaudeIntro.DURATION_MS in Resources/web/intro.js: the longest the page can
// play (the pet ending). Without a pet it posts 'done' after CORE_MS (12.1 s);
// this is only the dead-man's-switch timeout and the --snapshot span.
let durationSeconds = 20.0

enum Log {
  static let url: URL = {
    let folder = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Logs/Claude Intro 3D", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    return folder.appendingPathComponent("app.log")
  }()

  static func write(_ message: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
    guard let data = line.data(using: .utf8) else { return }
    if let handle = try? FileHandle(forWritingTo: url) {
      handle.seekToEndOfFile()
      handle.write(data)
      try? handle.close()
    } else {
      try? data.write(to: url)
    }
  }
}

// Where the app's window is, in Cocoa screen coordinates.
enum AppWindow {
  // Quartz and Electron measure from the top-left of the main display; Cocoa
  // from its bottom-left.
  static func cocoa(_ rect: CGRect) -> NSRect {
    let mainHeight = NSScreen.screens.first?.frame.height ?? rect.maxY
    return NSRect(x: rect.minX, y: mainHeight - rect.maxY, width: rect.width, height: rect.height)
  }

  // The largest normal window the process has on screen.
  static func live(pid: pid_t) -> NSRect? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    let frames = list.compactMap { info -> CGRect? in
      guard info[kCGWindowOwnerPID as String] as? pid_t == pid,
            info[kCGWindowLayer as String] as? Int == 0,
            let bounds = info[kCGWindowBounds as String] as? NSDictionary,
            let rect = CGRect(dictionaryRepresentation: bounds),
            rect.width >= 300, rect.height >= 200 else { return nil }
      return rect
    }
    return frames.max { $0.width * $0.height < $1.width * $1.height }.map(cocoa)
  }

  // The frame Claude saved when it last closed, which it reopens at.
  static func saved() -> NSRect? {
    let file = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Application Support/Claude/window-state.json")
    guard let data = try? Data(contentsOf: file),
          let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    func rect(_ value: Any?) -> CGRect? {
      guard let box = value as? [String: Any],
            let x = box["x"] as? Double, let y = box["y"] as? Double,
            let width = box["width"] as? Double, let height = box["height"] as? Double,
            width >= 300, height >= 200 else { return nil }
      return CGRect(x: x, y: y, width: width, height: height)
    }
    let whole = state["isMaximized"] as? Bool == true || state["isFullScreen"] as? Bool == true
    guard let frame = whole ? rect(state["displayBounds"]) : rect(state) else { return nil }
    let result = cocoa(frame)
    // Only trust it if it is still on a connected screen.
    return NSScreen.screens.contains { $0.frame.intersects(result) } ? result : nil
  }

  static var standInSize = NSSize(width: 1280, height: 800)

  // Off every screen, so recording never shows a window or gets in the way
  // of the mouse (the web view keeps rendering: see IntroPlayer.start).
  static func standIn() -> NSRect {
    let right = NSScreen.screens.map(\.frame.maxX).max() ?? 0
    let size = standInSize
    return NSRect(x: right + 4000, y: 0, width: size.width, height: size.height)
  }

  static func fallback() -> NSRect {
    let mouse = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
    let area = screen.visibleFrame
    let size = NSSize(width: min(1280, area.width * 0.8), height: min(820, area.height * 0.8))
    return NSRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2, width: size.width, height: size.height)
  }
}

// A panel that never activates this app or takes the main window from the
// app starting underneath it. While it plays it is the key window (a
// non-activating panel can be, with Claude still the active app), so Esc
// reaches it; when it closes, keyboard focus returns to Claude.
final class IntroPanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}

final class IntroPlayer: NSObject, WKScriptMessageHandler {
  private let pid: pid_t?
  private let snapshotFolder: URL?
  static var snapshotEvery = 0.1
  // --snapshot --landing: the stand-in window's pet rect, so a recording
  // takes the pet ending (she leaps out and lands on the pet's spot).
  static var snapshotPetFrame: (x: Double, y: Double, w: Double, h: Double)?
  // The pet's clip-frame rect in the Claude window's own top-left
  // coordinates (nil if the pet's geometry isn't known yet, e.g. no
  // PetController in --play/--snapshot). On a cold launch Claude's window is
  // still being created and resized when the page starts, so it is nearly
  // always nil at 'ready': petFeed asks again every 0.25s from 'ready' until
  // she lands or the intro ends, which also keeps the landing spot current
  // if the window is resized while she plays.
  private let petFrame: (() -> (x: Double, y: Double, w: Double, h: Double)?)?
  private var petFeed: Timer?
  private var petFrameSent = false
  // Called when the page posts "landed" (the pet should reveal instantly).
  private let onLanded: (() -> Void)?
  private(set) var landed = false
  private let onFinish: () -> Void
  private var panel: IntroPanel?
  private var webView: WKWebView?
  private var follow: Timer?
  private var keys: Any?
  private var shown = false
  private var prepared = false
  private var playing = false
  private var finished = false
  private let began = Date()

  // pid: the app whose window to cover; nil covers a centered stand-in.
  init(pid: pid_t?, snapshotFolder: URL? = nil, petFrame: (() -> (x: Double, y: Double, w: Double, h: Double)?)? = nil, onLanded: (() -> Void)? = nil, onFinish: @escaping () -> Void) {
    self.pid = pid
    self.snapshotFolder = snapshotFolder
    self.petFrame = petFrame
    self.onLanded = onLanded
    self.onFinish = onFinish
  }

  private func elapsed() -> String { String(format: "%.2fs", Date().timeIntervalSince(began)) }

  func start() {
    guard let page = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "web") else {
      Log.write("missing web/index.html")
      return finish()
    }
    let panel = IntroPanel(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = .floating
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]

    let configuration = WKWebViewConfiguration()
    configuration.userContentController.add(self, name: "intro")
    // The character's clip is started from script, with no click.
    configuration.mediaTypesRequiringUserActionForPlayback = []
    let webView = WKWebView(frame: panel.contentLayoutRect, configuration: configuration)
    webView.autoresizingMask = [.width, .height]
    webView.setValue(false, forKey: "drawsBackground")
    if snapshotFolder != nil {
      // Recording happens off screen: clicks pass through, and WebKit is
      // told not to pause a window it cannot see (it would stop rendering).
      panel.ignoresMouseEvents = true
      let occlusion = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
      if webView.responds(to: occlusion) {
        typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(webView.method(for: occlusion), to: Setter.self)(webView, occlusion, false)
      } else {
        Log.write("note: cannot keep the off-screen web view rendering")
      }
    }
    panel.contentView = webView
    webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    self.panel = panel
    self.webView = webView

    // Cover the frame Claude reopens at right away; snap to the real window
    // once it exists, and keep following it if it moves.
    if snapshotFolder != nil {
      show(at: AppWindow.standIn())
    } else if let pid {
      if let frame = AppWindow.live(pid: pid) ?? AppWindow.saved() { show(at: frame) }
    } else {
      show(at: AppWindow.saved() ?? AppWindow.fallback())
    }
    follow = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.track() }

    DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
      guard let self, !self.finished, !self.playing else { return }
      Log.write("no window or page after 10s; giving up")
      self.finish()
    }
  }

  private func track() {
    guard let pid, snapshotFolder == nil, !finished else { return }
    guard NSRunningApplication(processIdentifier: pid) != nil else {
      Log.write("app quit")
      return finish()
    }
    guard let frame = AppWindow.live(pid: pid) else { return }
    if !shown {
      show(at: frame)
    } else if let panel, !NSEqualRects(panel.frame, frame) {
      panel.setFrame(frame, display: true)
    }
    // Claude's own window takes the keyboard when it appears; take it back
    // so Esc still reaches the panel while it plays.
    if let panel, shown, !panel.isKeyWindow { panel.makeKey() }
  }

  private func show(at frame: NSRect) {
    guard let panel else { return }
    panel.setFrame(frame, display: false)
    // It has to be on screen for the page to animate; the page itself is
    // transparent until the band is inserted.
    panel.orderFrontRegardless()
    // A recording takes neither the keyboard nor Esc.
    if snapshotFolder == nil { panel.makeKey() }
    if keys == nil, snapshotFolder == nil {
      // Every key is ours while she plays: Esc ends it, any other key is
      // swallowed here (never skips, never reaches WebKit to beep).
      keys = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
        if event.keyCode == 53 {  // Esc
          Log.write("skipped with Esc")
          self?.finish(fade: 0.2)
        }
        return nil
      }
    }
    shown = true
    Log.write("covering \(NSStringFromRect(frame)) at \(elapsed())")
    playIfReady()
  }

  private func playIfReady() {
    guard shown, prepared, !playing else { return }
    playing = true
    webView?.evaluateJavaScript("ClaudeIntro.play(document)")
  }

  private func sendPet(_ frame: (x: Double, y: Double, w: Double, h: Double)) {
    webView?.evaluateJavaScript("typeof ClaudeIntro.setPet === 'function' && ClaudeIntro.setPet({x: \(frame.x), y: \(frame.y), w: \(frame.w), h: \(frame.h)})")
  }

  private func feedPetFrame() {
    guard !finished, !landed, let frame = petFrame?() else { return }
    if !petFrameSent {
      petFrameSent = true
      Log.write("pet spot known at \(elapsed())")
    }
    sendPet(frame)
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    let body = "\(message.body)"
    switch body {
    case "prepared":
      prepared = true
      Log.write("layers decoded at \(elapsed())")
      playIfReady()
    case "ready":
      Log.write("playing at \(elapsed())")
      if let folder = snapshotFolder {
        // Handed over before any seek, so a recording plays the same ending.
        if let frame = IntroPlayer.snapshotPetFrame { sendPet(frame) }
        return captureFrames(into: folder)
      }
      feedPetFrame()
      petFeed = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.feedPetFrame() }
      DispatchQueue.main.asyncAfter(deadline: .now() + durationSeconds + 2) { [weak self] in self?.finish() }
    case "landed":
      Log.write("pet landed; revealing instantly")
      petFeed?.invalidate()
      landed = true
      onLanded?()
      finish(fade: 0)
    case "done":
      finish()
    case let note where note.hasPrefix("stats:") || note.hasPrefix("note:"):
      Log.write(note)
    default:
      Log.write("page: \(body)")
      finish()
    }
  }

  // Renders the intro frame by frame for previews: the page freezes every
  // animation and her clip at each moment (ClaudeIntro.seek), then the frame
  // is taken and encoded off the main thread. Files are named by their ms.
  private func captureFrames(into folder: URL) {
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let encoder = DispatchQueue(label: "snapshot-encoder", qos: .utility)
    let times = Array(stride(from: 0.0, through: durationSeconds, by: IntroPlayer.snapshotEvery))
    func step(_ index: Int) {
      guard index < times.count, let webView else {
        encoder.sync {}
        Log.write("rendered \(times.count) frames")
        return finish()
      }
      let ms = (times[index] * 1000).rounded()
      webView.callAsyncJavaScript("await ClaudeIntro.seek(ms)", arguments: ["ms": ms], in: nil, in: .page) { [weak self] _ in
        webView.takeSnapshot(with: nil) { image, error in
          if let image, let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            encoder.async {
              let url = folder.appendingPathComponent(String(format: "frame-%05.0f.png", ms))
              guard let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { return }
              CGImageDestinationAddImage(destination, cgImage, nil)
              CGImageDestinationFinalize(destination)
            }
          } else {
            Log.write("snapshot \(ms) failed: \(error?.localizedDescription ?? "no image")")
          }
          guard self != nil else { return }
          step(index + 1)
        }
      }
    }
    step(0)
  }

  private func finish(fade: Double = 0.15) {
    guard !finished else { return }
    finished = true
    follow?.invalidate()
    petFeed?.invalidate()
    if let keys { NSEvent.removeMonitor(keys) }
    keys = nil
    let panel = self.panel
    NSAnimationContext.runAnimationGroup({ context in
      context.duration = fade
      panel?.animator().alphaValue = 0
    }, completionHandler: { [weak self] in
      panel?.orderOut(nil)
      self?.webView?.configuration.userContentController.removeScriptMessageHandler(forName: "intro")
      self?.webView = nil
      self?.panel = nil
      self?.onFinish()
    })
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var watchedBundleID = claudeBundleID
  private var knownProcesses = Set<pid_t>()
  private var observation: NSKeyValueObservation?
  private var player: IntroPlayer?
  // nil for --play/--snapshot/--pet-snapshot/--uninstall; created once for
  // every other mode (including --watch) right before watch() starts.
  private var pet: PetController?

  func applicationDidFinishLaunching(_ notification: Notification) {
    let arguments = CommandLine.arguments
    // '--pet on'/'--pet off': just flip the stored preference and fall
    // through to normal startup below -- if another instance of this agent
    // is already running, it re-reads this default every tick and the
    // otherAgentIsRunning() check further down still makes this short-lived
    // invocation quit right after.
    if let index = arguments.firstIndex(of: "--pet"), index + 1 < arguments.count {
      switch arguments[index + 1] {
      case "on":
        UserDefaults.standard.set(true, forKey: "petEnabled")
        UserDefaults.standard.removeObject(forKey: "petSnoozeUntil")
        Log.write("pet enabled via --pet on")
      case "off":
        UserDefaults.standard.set(false, forKey: "petEnabled")
        UserDefaults.standard.removeObject(forKey: "petSnoozeUntil")
        Log.write("pet disabled via --pet off")
      default:
        Log.write("unknown --pet value: \(arguments[index + 1])")
      }
    }
    if let index = arguments.firstIndex(of: "--pet-snapshot"), index + 1 < arguments.count {
      let folder = URL(fileURLWithPath: arguments[index + 1], isDirectory: true)
      var every = 0.1
      if index + 2 < arguments.count, let value = Double(arguments[index + 2]), value >= 0.01 {
        every = value
      }
      var size = NSSize(width: 1152, height: 1024)
      if let at = arguments.firstIndex(of: "--size"), at + 1 < arguments.count {
        let parts = arguments[at + 1].split(separator: "x").compactMap { Double($0) }
        if parts.count == 2, parts[0] >= 320, parts[1] >= 240 { size = NSSize(width: parts[0], height: parts[1]) }
      }
      var script: [String] = []
      if let at = arguments.firstIndex(of: "--script"), at + 1 < arguments.count {
        script = arguments[at + 1].split(separator: ",").map(String.init).filter { !$0.isEmpty }
      }
      var useQuotaSample = false
      if let at = arguments.firstIndex(of: "--quota"), at + 1 < arguments.count, arguments[at + 1] == "sample" {
        useQuotaSample = true
      }
      let snapshotPlayer = PetSnapshotPlayer(folder: folder, every: every, script: script, useQuotaSample: useQuotaSample, standInSize: size)
      snapshotPlayer.start()
      return
    }
    if arguments.contains("--uninstall") {
      UserDefaults.standard.set(false, forKey: "openAtLogin")
      do {
        try SMAppService.mainApp.unregister()
        Log.write("unregistered from login items")
      } catch {
        Log.write("unregister failed: \(error.localizedDescription)")
      }
      return NSApp.terminate(nil)
    }
    if arguments.contains("--play") {
      return playIntro(pid: runningClaude()) { NSApp.terminate(nil) }
    }
    if let index = arguments.firstIndex(of: "--snapshot"), index + 1 < arguments.count {
      let folder = URL(fileURLWithPath: arguments[index + 1], isDirectory: true)
      if index + 2 < arguments.count, let every = Double(arguments[index + 2]), every >= 0.01 {
        IntroPlayer.snapshotEvery = every
      }
      if let at = arguments.firstIndex(of: "--size"), at + 1 < arguments.count {
        let parts = arguments[at + 1].split(separator: "x").compactMap { Double($0) }
        if parts.count == 2, parts[0] >= 320, parts[1] >= 240 {
          AppWindow.standInSize = NSSize(width: parts[0], height: parts[1])
        }
      }
      if arguments.contains("--landing") {
        IntroPlayer.snapshotPetFrame = standInPetFrame(windowSize: AppWindow.standInSize)
        Log.write("snapshot: pet ending at \(String(describing: IntroPlayer.snapshotPetFrame))")
      }
      return playIntro(pid: nil, snapshotFolder: folder) { NSApp.terminate(nil) }
    }
    if let index = arguments.firstIndex(of: "--watch"), index + 1 < arguments.count {
      watchedBundleID = arguments[index + 1]
    } else if otherAgentIsRunning() {
      Log.write("another agent is already running; quitting")
      return NSApp.terminate(nil)
    } else {
      openAtLogin()
    }
    pet = PetController()
    watch()
  }

  private func runningClaude() -> pid_t? {
    NSRunningApplication.runningApplications(withBundleIdentifier: claudeBundleID).first?.processIdentifier
  }

  private func otherAgentIsRunning() -> Bool {
    let me = ProcessInfo.processInfo.processIdentifier
    return NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
      .contains { $0.processIdentifier != me }
  }

  // Registers again after a rebuild changes the ad-hoc signature.
  private func openAtLogin() {
    guard UserDefaults.standard.object(forKey: "openAtLogin") as? Bool ?? true else { return }
    guard SMAppService.mainApp.status != .enabled else { return }
    do {
      try SMAppService.mainApp.register()
      Log.write("registered to open at login")
    } catch {
      Log.write("login item registration failed: \(error.localizedDescription)")
    }
  }

  private func watchedProcesses() -> Set<pid_t> {
    Set(NSWorkspace.shared.runningApplications
      .filter { $0.bundleIdentifier == watchedBundleID }
      .map(\.processIdentifier))
  }

  // runningApplications changes as soon as the process starts, before its
  // first window, so the panel is up before the app has drawn anything.
  private func watch() {
    knownProcesses = watchedProcesses()
    Log.write("watching \(watchedBundleID); already running: \(knownProcesses.sorted())")
    if let pid = knownProcesses.first {
      // Already running with no intro to hand off from: show the pet
      // directly, once the tracker finds the window.
      pet?.setClaudePID(pid)
      pet?.reveal(fade: 0.4)
    }
    observation = NSWorkspace.shared.observe(\.runningApplications, options: [.new]) { [weak self] _, _ in
      DispatchQueue.main.async { self?.processesChanged() }
    }
  }

  private func processesChanged() {
    let current = watchedProcesses()
    let started = current.subtracting(knownProcesses)
    knownProcesses = current
    // Tell the pet about the current pid on every change, including back to
    // nil when Claude quits, so its 10Hz tracker always stops in that case.
    pet?.setClaudePID(current.first)
    guard let pid = started.first else { return }
    Log.write("\(watchedBundleID) started: \(pid)")
    guard player == nil else { return }
    playIntro(pid: pid) {}
  }

  private func playIntro(pid: pid_t?, snapshotFolder: URL? = nil, then done: @escaping () -> Void) {
    pet?.holdForIntro()
    let player = IntroPlayer(
      pid: pid, snapshotFolder: snapshotFolder,
      petFrame: { [weak self] in self?.pet?.frameForIntro() },
      onLanded: { [weak self] in self?.pet?.reveal(fade: 0) }
    ) { [weak self] in
      guard let self else { return }
      if self.player?.landed != true { self.pet?.reveal(fade: 0.4) }
      self.player = nil
      Log.write("finished")
      done()
    }
    self.player = player
    player.start()
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
