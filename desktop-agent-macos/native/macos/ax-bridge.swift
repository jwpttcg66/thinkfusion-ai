import Foundation
import AppKit
import ApplicationServices
import CoreGraphics

// JSON Lines AX helper. One request per stdin line, one JSON object per stdout line.
// Read commands stay. Mutations are an allow-list (press, setValue, keypress, scroll,
// drag, focus). There is no shell and no arbitrary command execution.
// Key names must stay aligned with COMPUTER_KEYS in src/agent/computer/types.ts.

let stdoutBuffer = ""

func emit(_ object: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else {
        print("{\"ok\":false,\"code\":\"HELPER_FAILED\",\"error\":\"response was not valid JSON\"}")
        fflush(stdout)
        return
    }
    print(text)
    fflush(stdout)
}

func fail(_ code: String, _ message: String) -> [String: Any] {
    ["ok": false, "code": code, "error": message]
}

func ok(_ result: Any) -> [String: Any] {
    ["ok": true, "result": result]
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value as? String
}

func axFrame(_ element: AXUIElement) -> [String: Double]? {
    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
          let pos = posRef, let size = sizeRef else { return nil }
    var point = CGPoint.zero
    var cgSize = CGSize.zero
    guard CFGetTypeID(pos) == AXValueGetTypeID(),
          AXValueGetValue(pos as! AXValue, .cgPoint, &point),
          CFGetTypeID(size) == AXValueGetTypeID(),
          AXValueGetValue(size as! AXValue, .cgSize, &cgSize) else { return nil }
    return ["x": Double(point.x), "y": Double(point.y), "width": Double(cgSize.width), "height": Double(cgSize.height)]
}

func isMenuRole(_ role: String) -> Bool {
    role == "AXMenuBar" || role == "AXMenu" || role == "AXMenuItem" || role == "AXMenuBarItem"
}

/// 有些应用会把同进程的 AXApplication 嵌进 children/windows，直接递归会只看到菜单。
func visibleChildren(_ element: AXUIElement, includeMenus: Bool, unwrapDepth: Int = 0) -> [AXUIElement] {
    if unwrapDepth > 4 { return [] }
    var childrenRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
          let children = childrenRef as? [AXUIElement] else { return [] }
    var out: [AXUIElement] = []
    for child in children.prefix(100) {
        let role = axString(child, kAXRoleAttribute) ?? ""
        if role == "AXApplication" {
            out.append(contentsOf: visibleChildren(child, includeMenus: includeMenus, unwrapDepth: unwrapDepth + 1))
            continue
        }
        if !includeMenus && isMenuRole(role) { continue }
        out.append(child)
    }
    return out
}

func windowElements(_ app: AXUIElement) -> [AXUIElement] {
    var wins: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &wins) == .success,
          let list = wins as? [AXUIElement] else { return [] }
    var out: [AXUIElement] = []
    for window in list.prefix(20) {
        let role = axString(window, kAXRoleAttribute) ?? ""
        if role == "AXApplication" {
            let nested = visibleChildren(window, includeMenus: false, unwrapDepth: 0)
            if nested.isEmpty { continue }
            out.append(contentsOf: nested)
        } else if role == "AXWindow" || axFrame(window) != nil {
            out.append(window)
        } else {
            out.append(window)
        }
    }
    return out
}

func node(_ element: AXUIElement, depth: Int, maxDepth: Int, id: String, includeMenus: Bool = false) -> [String: Any] {
    let role = axString(element, kAXRoleAttribute) ?? "unknown"
    var result: [String: Any] = ["role": role, "id": id]
    if let title = axString(element, kAXTitleAttribute), !title.isEmpty { result["title"] = title }
    if let value = axString(element, kAXValueAttribute) { result["value"] = value }
    if let frame = axFrame(element) { result["frame"] = frame }
    if depth < maxDepth {
        let children = visibleChildren(element, includeMenus: includeMenus)
        result["children"] = children.prefix(100).enumerated().map { index, child in
            node(child, depth: depth + 1, maxDepth: maxDepth, id: "\(id).\(index)", includeMenus: includeMenus)
        }
    }
    return result
}

func applicationTree(_ element: AXUIElement, maxDepth: Int) -> [String: Any] {
    let id = "p\(pidOf(element))"
    let windows = windowElements(element)
    if !windows.isEmpty {
        return [
            "id": id,
            "role": "AXApplication",
            "title": axString(element, kAXTitleAttribute) ?? "",
            "children": windows.prefix(20).enumerated().map { index, window in
                node(window, depth: 1, maxDepth: maxDepth, id: "\(id).\(index)", includeMenus: false)
            }
        ]
    }
    return node(element, depth: 0, maxDepth: maxDepth, id: id, includeMenus: false)
}

func focusedApplicationElement() -> AXUIElement? {
    let system = AXUIElementCreateSystemWide()
    var appRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &appRef) == .success,
          let appRef else { return nil }
    return (appRef as! AXUIElement)
}

func pidOf(_ element: AXUIElement) -> pid_t {
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    return pid
}

func isLoginWindow(_ bundleId: String?) -> Bool {
    bundleId == "com.apple.loginwindow"
}

func appElement(bundleId: String) -> AXUIElement? {
    guard let running = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == bundleId }) else {
        return nil
    }
    return AXUIElementCreateApplication(running.processIdentifier)
}

func frontAppElement() -> AXUIElement? {
    if let running = NSWorkspace.shared.frontmostApplication,
       !isLoginWindow(running.bundleIdentifier) {
        return AXUIElementCreateApplication(running.processIdentifier)
    }
    if let focused = focusedApplicationElement() {
        let running = NSRunningApplication(processIdentifier: pidOf(focused))
        if !isLoginWindow(running?.bundleIdentifier) { return focused }
    }
    // 锁屏进程不能当目标应用：退到最近一个普通前台候选。
    if let running = NSWorkspace.shared.runningApplications.first(where: {
        $0.activationPolicy == .regular && !isLoginWindow($0.bundleIdentifier) && $0.isActive
    }) {
        return AXUIElementCreateApplication(running.processIdentifier)
    }
    return nil
}

func appPayload(_ element: AXUIElement) -> [String: Any] {
    let running = NSRunningApplication(processIdentifier: pidOf(element))
    return ["name": running?.localizedName ?? "Unknown", "bundleId": running?.bundleIdentifier ?? ""]
}

func frontmostPayload() -> Any {
    guard let appElement = frontAppElement() else { return NSNull() }
    return appPayload(appElement)
}

func screenPayload() -> [String: Double] {
    let screen = NSScreen.main
    let frame = screen?.frame ?? .zero
    return [
        "width": Double(frame.width),
        "height": Double(frame.height),
        "scaleFactor": Double(screen?.backingScaleFactor ?? 1)
    ]
}

func listWindows() -> [[String: Any]] {
    var out: [[String: Any]] = []
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    for app in apps.prefix(40) {
        let element = AXUIElementCreateApplication(app.processIdentifier)
        let list = windowElements(element)
        for (index, window) in list.prefix(20).enumerated() {
            var item: [String: Any] = [
                "windowId": "p\(app.processIdentifier):\(index)",
                "title": axString(window, kAXTitleAttribute) ?? "",
                "app": app.localizedName ?? "",
                "bundleId": app.bundleIdentifier ?? ""
            ]
            if let frame = axFrame(window) { item["frame"] = frame }
            out.append(item)
            if out.count >= 200 { return out }
        }
    }
    return out
}

func resolveElement(_ id: String) -> AXUIElement? {
    let parts = id.split(separator: ".")
    guard let head = parts.first, head.hasPrefix("p"), let pid = pid_t(head.dropFirst()) else { return nil }
    var element = AXUIElementCreateApplication(pid)
    for part in parts.dropFirst() {
        guard let index = Int(part) else { return nil }
        var childrenRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
              let children = childrenRef as? [AXUIElement], index >= 0, index < children.count else { return nil }
        element = children[index]
    }
    return element
}

func resolveWindow(_ id: String) -> AXUIElement? {
    let parts = id.split(separator: ":")
    guard parts.count == 2, parts[0].hasPrefix("p"),
          let pid = pid_t(parts[0].dropFirst()),
          let index = Int(parts[1]) else { return nil }
    let app = AXUIElementCreateApplication(pid)
    var wins: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &wins) == .success,
          let list = wins as? [AXUIElement], index >= 0, index < list.count else { return nil }
    return list[index]
}

func matches(_ element: AXUIElement, _ request: [String: Any]) -> Bool {
    if let role = request["expectedRole"] as? String, !role.isEmpty, axString(element, kAXRoleAttribute) != role {
        return false
    }
    if let title = request["expectedTitle"] as? String, !title.isEmpty, axString(element, kAXTitleAttribute) != title {
        return false
    }
    return true
}

func number(_ request: [String: Any], _ key: String) -> Double? {
    if let value = request[key] as? Double { return value }
    if let value = request[key] as? Int { return Double(value) }
    if let value = request[key] as? NSNumber { return value.doubleValue }
    return nil
}

func postMouse(_ type: CGEventType, _ point: CGPoint) {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { return }
    event.post(tap: .cghidEventTap)
}

func click(at point: CGPoint) {
    postMouse(.leftMouseDown, point)
    postMouse(.leftMouseUp, point)
}

let keyCodes: [String: CGKeyCode] = [
    "return": 36, "tab": 48, "escape": 53, "space": 49, "delete": 51, "forwarddelete": 117,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5, "h": 4, "i": 34, "j": 38,
    "k": 40, "l": 37, "m": 46, "n": 45, "o": 31, "p": 35, "q": 12, "r": 15, "s": 1, "t": 17,
    "u": 32, "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25
]

func flags(_ request: [String: Any]) -> CGEventFlags {
    let names = request["modifiers"] as? [String] ?? []
    var flags = CGEventFlags()
    for name in names {
        switch name {
        case "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "option": flags.insert(.maskAlternate)
        case "control": flags.insert(.maskControl)
        default: break
        }
    }
    return flags
}

func postKey(_ code: CGKeyCode, _ flags: CGEventFlags) {
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { return }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

func postText(_ text: String) {
    var rest = Array(text.utf16)
    while !rest.isEmpty {
        let chunk = Array(rest.prefix(16))
        rest.removeFirst(chunk.count)
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { return }
        chunk.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
    }
}

func pointOf(_ request: [String: Any]) -> CGPoint? {
    guard let x = number(request, "x"), let y = number(request, "y") else { return nil }
    guard x >= 0, y >= 0, x <= 20_000, y <= 20_000 else { return nil }
    return CGPoint(x: x, y: y)
}

let writableRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXTextView"]

func handle(_ request: [String: Any]) -> [String: Any] {
    guard let command = request["command"] as? String, !command.isEmpty else {
        return fail("UNSUPPORTED_ACTION", "missing command")
    }
    if command == "capabilities" {
        return ok([
            "platform": "darwin",
            "trusted": AXIsProcessTrusted(),
            "commands": [
                "capabilities", "frontmostApplication", "focusedTree", "observe", "windows",
                "press", "setValue", "keypress", "scroll", "drag", "focus"
            ]
        ])
    }
    guard AXIsProcessTrusted() else { return fail("PERMISSION_REQUIRED", "Accessibility permission is not granted") }
    let maxDepth = min(max((request["maxDepth"] as? Int) ?? (request["maxDepth"] as? NSNumber)?.intValue ?? 4, 1), 8)

    if command == "frontmostApplication" { return ok(frontmostPayload()) }
    if command == "focusedTree" {
        guard let app = frontAppElement() else { return ok([String: Any]()) }
        return ok(applicationTree(app, maxDepth: maxDepth))
    }
    if command == "windows" { return ok(listWindows()) }
    if command == "observe" {
        let requestedBundle = request["bundleId"] as? String
        let app: AXUIElement? = {
            if let requestedBundle, let element = appElement(bundleId: requestedBundle) { return element }
            return frontAppElement()
        }()
        let tree: Any = app.map { applicationTree($0, maxDepth: maxDepth) } ?? [String: Any]()
        let application: Any = app.map { appPayload($0) } ?? NSNull()
        return ok([
            "application": application,
            "screen": screenPayload(),
            "windows": listWindows(),
            "tree": tree
        ])
    }

    if command == "press" {
        if let elementId = request["elementId"] as? String {
            guard let element = resolveElement(elementId) else { return fail("TARGET_UNCERTAIN", "element is gone") }
            guard matches(element, request) else { return fail("WINDOW_CHANGED", "element identity changed") }
            let pressed = AXUIElementPerformAction(element, kAXPressAction as CFString)
            if pressed == .success { return ok(["method": "ax"]) }
            // 文本框等控件常不支持 AXPress；用控件中心坐标点一次，避免点击能力在真机上不可用。
            if let frame = axFrame(element),
               let x = frame["x"], let y = frame["y"], let width = frame["width"], let height = frame["height"],
               width > 0, height > 0 {
                click(at: CGPoint(x: x + width / 2, y: y + height / 2))
                return ok(["method": "coordinate-fallback", "axPress": pressed.rawValue])
            }
            return fail("HELPER_FAILED", "AXPress failed: \(pressed.rawValue)")
        }
        guard (request["allowCoordinate"] as? Bool) == true, let point = pointOf(request) else {
            return fail("TARGET_UNCERTAIN", "click needs an element or an authorized coordinate")
        }
        click(at: point)
        return ok(["method": "coordinate"])
    }

    if command == "setValue" {
        guard let text = request["text"] as? String else { return fail("TARGET_UNCERTAIN", "missing text") }
        if text.count > 2_000 { return fail("INPUT_TOO_LARGE", "text is too long") }
        guard let elementId = request["elementId"] as? String, let element = resolveElement(elementId) else {
            return fail("TARGET_UNCERTAIN", "missing element")
        }
        guard matches(element, request) else { return fail("WINDOW_CHANGED", "element identity changed") }
        let role = axString(element, kAXRoleAttribute) ?? ""
        if writableRoles.contains(role) {
            let wrote = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFTypeRef)
            if wrote == .success { return ok(["method": "ax"]) }
        }
        guard let app = focusedApplicationElement() else { return fail("TARGET_UNCERTAIN", "no focused application") }
        let focused = AXUIElementSetAttributeValue(app, kAXFocusedUIElementAttribute as CFString, element)
        if focused != .success { return fail("HELPER_FAILED", "cannot focus element for typing") }
        postText(text)
        return ok(["method": "keyboard"])
    }

    if command == "keypress" {
        guard let key = request["key"] as? String, let code = keyCodes[key] else {
            return fail("UNSUPPORTED_ACTION", "key is not allowed")
        }
        if let elementId = request["elementId"] as? String, let element = resolveElement(elementId), let app = focusedApplicationElement() {
            guard matches(element, request) else { return fail("WINDOW_CHANGED", "element identity changed") }
            AXUIElementSetAttributeValue(app, kAXFocusedUIElementAttribute as CFString, element)
        }
        postKey(code, flags(request))
        return ok(["method": "keyboard"])
    }

    if command == "scroll" {
        let deltaY = Int(number(request, "deltaY") ?? 0)
        let deltaX = Int(number(request, "deltaX") ?? 0)
        if deltaX == 0 && deltaY == 0 { return fail("TARGET_UNCERTAIN", "scroll distance is zero") }
        if let point = pointOf(request) { postMouse(.mouseMoved, point) }
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(max(-5_000, min(5_000, deltaY))), wheel2: Int32(max(-5_000, min(5_000, deltaX))), wheel3: 0) else {
            return fail("HELPER_FAILED", "scroll event was not created")
        }
        event.post(tap: .cghidEventTap)
        return ok(["method": "coordinate"])
    }

    if command == "drag" {
        guard (request["allowCoordinate"] as? Bool) == true || request["elementId"] == nil else {
            return fail("UNSUPPORTED_ACTION", "drag is a coordinate action")
        }
        guard let start = pointOf(request),
              let x2 = number(request, "x2"), let y2 = number(request, "y2"),
              x2 >= 0, y2 >= 0, x2 <= 20_000, y2 <= 20_000 else {
            return fail("TARGET_UNCERTAIN", "drag needs two coordinates")
        }
        let end = CGPoint(x: x2, y: y2)
        postMouse(.leftMouseDown, start)
        postMouse(.leftMouseDragged, end)
        postMouse(.leftMouseUp, end)
        return ok(["method": "coordinate"])
    }

    if command == "focus" {
        let bundleId = request["bundleId"] as? String
        let running = NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == bundleId }
            ?? NSWorkspace.shared.frontmostApplication
        guard let running else { return fail("TARGET_UNCERTAIN", "application is not running") }
        running.activate(options: [.activateAllWindows])
        if let windowId = request["windowId"] as? String, let window = resolveWindow(windowId) {
            AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        }
        return ok(["method": "ax", "bundleId": running.bundleIdentifier ?? ""])
    }

    return fail("UNSUPPORTED_ACTION", "unsupported command")
}

while let line = readLine(strippingNewline: true) {
    if line.utf8.count > 65_536 {
        emit(fail("INPUT_TOO_LARGE", "request is too large"))
        continue
    }
    guard let data = line.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        emit(fail("HELPER_FAILED", "request is not a JSON object"))
        continue
    }
    emit(handle(object))
}
