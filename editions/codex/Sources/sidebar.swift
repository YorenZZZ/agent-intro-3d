import AppKit
import ApplicationServices

// Expanded state is not persisted by current Codex builds. If the user has
// granted Accessibility to this companion, read the toggle's aria-expanded
// value. Otherwise use the manual sidebar switch without requesting access.
enum CodexSidebar {
  static func collapsed(pid: pid_t?) -> Bool? {
    guard let pid, AXIsProcessTrusted() else { return nil }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.05)
    func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
      var value: CFTypeRef?
      guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
      return value
    }
    guard let windows = attribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] else { return nil }
    var queue = windows.map { ($0, 0) }
    var index = 0
    while index < queue.count, index < 500 {
      let (element, depth) = queue[index]; index += 1
      let label = ((attribute(element, kAXTitleAttribute as CFString) as? String ?? "") + " " +
                   (attribute(element, kAXDescriptionAttribute as CFString) as? String ?? "")).lowercased()
      if label.contains("toggle sidebar") || label.contains("切换侧栏") || label.contains("切换侧边栏") {
        if let expanded = attribute(element, kAXExpandedAttribute as CFString) as? Bool { return !expanded }
      }
      if depth < 9, let children = attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] {
        queue += children.prefix(80).map { ($0, depth + 1) }
      }
    }
    return nil
  }
}
