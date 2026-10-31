import Carbon
import Foundation

// Nombre de una tecla en la distribución de teclado actual: el código virtual
// es la posición física, y la letra que lleva depende de la distribución (la
// tecla de «;» en un teclado estadounidense es «ñ» en uno español).

final class KeyLayout {
    private let data: Data
    private let keyboardType = UInt32(LMGetKbdType())

    private init(data: Data) {
        self.data = data
    }

    /// Cola principal: las funciones de fuentes de entrada no se llaman desde otros hilos.
    static func current() -> KeyLayout? {
        guard
            let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
            let pointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
        else { return nil }
        let cfData = Unmanaged<CFData>.fromOpaque(pointer).takeUnretainedValue()
        return KeyLayout(data: cfData as Data)
    }

    /// La letra o símbolo de la tecla sin modificadores; nil si no escribe nada visible.
    func name(of key: Int) -> String? {
        var deadKeys: UInt32 = 0
        var length = 0
        var chars = [UniChar](repeating: 0, count: 4)
        let status = data.withUnsafeBytes { raw -> OSStatus in
            guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return -1 }
            return UCKeyTranslate(
                layout,
                UInt16(key),
                UInt16(kUCKeyActionDisplay),
                0,
                keyboardType,
                OptionBits(kUCKeyTranslateNoDeadKeysBit),
                &deadKeys,
                chars.count,
                &length,
                &chars
            )
        }
        guard status == noErr, length > 0 else { return nil }
        let text = String(utf16CodeUnits: chars, count: length).trimmingCharacters(in: .whitespacesAndNewlines.union(.controlCharacters))
        return text.isEmpty ? nil : String(text.prefix(4)).lowercased()
    }
}
