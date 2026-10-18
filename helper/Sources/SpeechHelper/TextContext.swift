import AppKit
import ApplicationServices

// Texto alrededor del cursor en el campo con foco, leído por Accesibilidad al
// empezar a dictar. Sirve para que el formateo sepa dónde va el texto y para
// ajustar espacios y mayúsculas al pegar. Solo sale de aquí un trozo a cada
// lado del cursor; nunca se lee un campo de contraseña.

enum TextContext {
    /// Caracteres (UTF-16) a cada lado del cursor que se envían a main.
    static let sideLength = 1_000
    /// Un campo más largo no se lee entero (documentos enormes, terminales).
    static let maxCharacters = 250_000
    /// Apps a las que ya se pidió que publiquen su árbol de Accesibilidad.
    private static var manualAccessibilityPids = Set<pid_t>()

    /// Las apps hechas con Chromium o Electron no publican su árbol de
    /// Accesibilidad hasta que alguien lo pide; en las demás no tiene efecto.
    static func enableManualAccessibility(_ axApp: AXUIElement, pid: pid_t) {
        guard !manualAccessibilityPids.contains(pid) else { return }
        manualAccessibilityPids.insert(pid)
        if manualAccessibilityPids.count > 64 { manualAccessibilityPids.removeAll() }
        AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    }

    /// `before`, `after` y `selected`, o un motivo si no se pudo leer.
    static func read(_ element: AXUIElement?) -> [String: Any] {
        guard let element else { return ["unavailable": "no focused element"] }
        let role = string(element, kAXRoleAttribute) ?? ""
        let subrole = string(element, kAXSubroleAttribute) ?? ""
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
            return ["unavailable": "secure field"]
        }
        if let count = int(element, kAXNumberOfCharactersAttribute), count > maxCharacters {
            return ["unavailable": "too long (\(count) characters)"]
        }
        guard let value = string(element, kAXValueAttribute) else {
            return ["unavailable": "no text value (\(role.isEmpty ? "no role" : role))"]
        }
        // Algunos campos vacíos devuelven el texto de ayuda como valor.
        if !value.isEmpty, value == string(element, kAXPlaceholderValueAttribute) {
            return ["before": "", "after": "", "selected": "", "role": role]
        }
        let text = value as NSString
        guard let range = selectedRange(element), range.location != kCFNotFound,
              range.location >= 0, range.location + range.length <= text.length
        else {
            return ["unavailable": "no cursor position (\(role))"]
        }
        let start = max(0, range.location - sideLength)
        let end = range.location + range.length
        let afterEnd = min(text.length, end + sideLength)
        return [
            "before": safeSubstring(text, NSRange(location: start, length: range.location - start)),
            "after": safeSubstring(text, NSRange(location: end, length: afterEnd - end)),
            "selected": safeSubstring(text, NSRange(location: range.location, length: min(range.length, sideLength))),
            "role": role,
        ]
    }

    /// Sin partir un carácter compuesto (emoji, acentos combinados) por la mitad.
    private static func safeSubstring(_ text: NSString, _ range: NSRange) -> String {
        guard range.length > 0 else { return "" }
        var r = range
        if r.location > 0 { r = NSUnionRange(r, text.rangeOfComposedCharacterSequence(at: r.location)) }
        let last = r.location + r.length - 1
        if last < text.length { r = NSUnionRange(r, text.rangeOfComposedCharacterSequence(at: last)) }
        return text.substring(with: r)
    }

    private static func selectedRange(_ element: AXUIElement) -> CFRange? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXValueGetTypeID()
        else { return nil }
        var range = CFRange()
        guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
        return range
    }

    private static func string(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }

    private static func int(_ element: AXUIElement, _ attribute: String) -> Int? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return (value as? NSNumber)?.intValue
    }
}
