import Foundation
import AppKit
import ApplicationServices

// Minimal read-only AX bridge protocol. One JSON request per stdin line;
// one JSON response per stdout line. Do not add arbitrary command execution.
struct Request: Decodable { let command: String; let maxDepth: Int? }
struct Response: Encodable { let ok: Bool; let result: AnyEncodable?; let error: String? }
struct AnyEncodable: Encodable {
    let value: Any
    init(_ value: Any) { self.value = value }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        if let v = value as? String { try c.encode(v) }
        else if let v = value as? Int { try c.encode(v) }
        else if let v = value as? Bool { try c.encode(v) }
        else if let v = value as? [Any] { try c.encode(v.map { AnyEncodable($0) }) }
        else if let v = value as? [String: Any] { try c.encode(v.mapValues { AnyEncodable($0) }) }
        else { try c.encode(String(describing: value)) }
    }
}

func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value as? String
}

func node(_ element: AXUIElement, depth: Int, maxDepth: Int) -> [String: Any] {
    let role = axString(element, kAXRoleAttribute as CFString) ?? "unknown"
    let title = axString(element, kAXTitleAttribute as CFString)
    let value = axString(element, kAXValueAttribute as CFString)
    var result: [String: Any] = ["role": role]
    if let title { result["title"] = title }
    if let value { result["value"] = value }
    if depth < maxDepth {
        var childrenRef: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
           let children = childrenRef as? [AXUIElement] {
            result["children"] = children.prefix(100).map { node($0, depth: depth + 1, maxDepth: maxDepth) }
        }
    }
    return result
}

func handle(_ request: Request) -> [String: Any] {
    guard AXIsProcessTrusted() else { return ["ok": false, "error": "Accessibility permission is not granted"] }
    let system = AXUIElementCreateSystemWide()
    if request.command == "frontmostApplication" {
        var appRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &appRef) == .success,
              let appElement = appRef else { return ["ok": true, "result": NSNull()] }
        let pid = UnsafeMutablePointer<pid_t>.allocate(capacity: 1)
        defer { pid.deallocate() }
        AXUIElementGetPid(appElement as! AXUIElement, pid)
        let running = NSRunningApplication(processIdentifier: pid.pointee)
        return ["ok": true, "result": ["name": running?.localizedName ?? "Unknown", "bundleId": running?.bundleIdentifier ?? ""]]
    }
    if request.command == "focusedTree" {
        var appRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &appRef) == .success,
              let appElement = appRef else { return ["ok": true, "result": []] }
        return ["ok": true, "result": node(appElement as! AXUIElement, depth: 0, maxDepth: min(max(request.maxDepth ?? 4, 1), 8))]
    }
    return ["ok": false, "error": "unsupported command"]
}

while let line = readLine() {
    guard let data = line.data(using: .utf8) else { continue }
    do {
        let req = try JSONDecoder().decode(Request.self, from: data)
        let result = handle(req)
        let out = try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed, .sortedKeys])
        print(String(data: out, encoding: .utf8) ?? "{}")
    } catch {
        let out = try? JSONSerialization.data(withJSONObject: ["ok": false, "error": String(describing: error)])
        print(out.flatMap { String(data: $0, encoding: .utf8) } ?? "{\"ok\":false}")
    }
}
