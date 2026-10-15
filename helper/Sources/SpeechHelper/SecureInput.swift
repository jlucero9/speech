import AppKit
import Carbon
import IOKit

// Entrada segura: mientras una app la tiene activa (un campo de contraseña,
// un terminal con «Secure Keyboard Entry»…), el sistema no entrega sus
// teclas a los event taps y el atajo deja de responder. Se consulta cada
// segundo y se avisa a main de cada cambio, con la app responsable.

struct SecureInputOwner: Equatable {
    let pid: Int
    let appName: String?
    let bundleId: String?
}

final class SecureInputMonitor {
    static let pollInterval: TimeInterval = 1

    /// Se llama en la cola principal con el nuevo estado (nil = sin bloqueo).
    var onChange: ((SecureInputOwner?, Date?) -> Void)?

    private(set) var owner: SecureInputOwner?
    private(set) var since: Date?

    func poll() {
        let next = SecureInputMonitor.currentOwner()
        guard next != owner else { return }
        owner = next
        since = next == nil ? nil : Date()
        if let next {
            Log.info("Secure input on: \(next.appName ?? "unknown app") (pid \(next.pid), \(next.bundleId ?? "-"))")
        } else {
            Log.info("Secure input off")
        }
        onChange?(next, since)
    }

    var payload: [String: Any] {
        guard let owner else { return ["blocked": false] }
        return [
            "blocked": true,
            "pid": owner.pid,
            "appName": owner.appName ?? NSNull(),
            "bundleId": owner.bundleId ?? NSNull(),
            "since": since.map { Int($0.timeIntervalSince1970 * 1000) } ?? NSNull(),
        ]
    }

    /// Quién tiene la entrada segura, si alguien la tiene y bloquea el atajo.
    private static func currentOwner() -> SecureInputOwner? {
        guard IsSecureEventInputEnabled() else { return nil }
        guard let pid = secureInputPID() else {
            return SecureInputOwner(pid: 0, appName: nil, bundleId: nil)
        }
        // La pantalla de bloqueo la activa siempre; no es un problema del usuario.
        let app = NSRunningApplication(processIdentifier: pid_t(pid))
        if app?.bundleIdentifier == "com.apple.loginwindow" { return nil }
        if pid == Int(getpid()) { return nil }
        return SecureInputOwner(
            pid: pid,
            appName: app?.localizedName ?? processName(pid),
            bundleId: app?.bundleIdentifier
        )
    }

    /// El PID responsable figura en el registro de IOKit, en la sesión de consola.
    private static func secureInputPID() -> Int? {
        let root = IORegistryGetRootEntry(kIOMainPortDefault)
        defer { IOObjectRelease(root) }
        guard
            let value = IORegistryEntryCreateCFProperty(root, "IOConsoleUsers" as CFString, kCFAllocatorDefault, 0)?
                .takeRetainedValue(),
            let users = value as? [[String: Any]]
        else { return nil }
        for user in users {
            if let pid = user["kCGSSessionSecureInputPID"] as? Int { return pid }
        }
        return nil
    }

    private static func processName(_ pid: Int) -> String? {
        var buffer = [CChar](repeating: 0, count: 256)
        let length = proc_name(Int32(pid), &buffer, UInt32(buffer.count))
        return length > 0 ? String(cString: buffer) : nil
    }
}

// MARK: Tecla 🌐

/// Lo que hace macOS al pulsar la tecla 🌐 / fn (Ajustes › Teclado). Si no es
/// «nada», macOS reacciona además del atajo.
enum FnUsage {
    static func current() -> String {
        // Sin esto se leería la copia en caché del primer acceso.
        CFPreferencesAppSynchronize("com.apple.HIToolbox" as CFString)
        let value = CFPreferencesCopyValue(
            "AppleFnUsageType" as CFString,
            "com.apple.HIToolbox" as CFString,
            kCFPreferencesCurrentUser,
            kCFPreferencesAnyHost
        )
        guard let number = value as? Int else { return "unknown" }
        switch number {
        case 0: return "nothing"
        case 1: return "input-source"
        case 2: return "emoji"
        case 3: return "dictation"
        default: return "unknown"
        }
    }
}
