import AppKit
import ApplicationServices

// Atajo global: un event tap activo de sesión en un hilo propio.
//
// Privacidad: el helper no manda a main todas las teclas. Solo envía:
// - las teclas que forman parte de algún atajo;
// - mientras una de ellas está pulsada, las demás que se pulsen (así main sabe
//   que fn + ← no es «fn sola»), y la suelta de cada tecla que haya enviado.
// De las teclas pulsadas que no envió solo da la cuenta (`hidden`), para que
// main no confunda «A + fn» con «fn».
//
// Se traga dos cosas: Esc (o la tecla del atajo de cancelar) mientras hay un
// dictado, y la tecla no modificadora que completa un atajo con modificadores
// (para que, por ejemplo, fn + Espacio no escriba un espacio).
//
// Cada tecla de un atajo es un conjunto de teclas físicas: ⌘ «de cualquier
// lado» son las dos ⌘. Main manda esos códigos propios (0x1000 + la tecla
// izquierda) y aquí se traducen.
//
// Grabación de un atajo (editor de atajos del Hub): mientras dura, se envían
// todas las teclas, con su nombre en la distribución de teclado actual, y se
// tragan las que no son modificadores, para que no escriban nada. Solo la pide
// main mientras el editor espera una combinación, y se apaga sola al minuto.
//
// El callback del tap no hace trabajo: decide, encola el mensaje y vuelve. Si
// tarda, el sistema desactiva el tap.

/// Bits de las banderas de un evento para cada tecla modificadora: el del lado
/// concreto (NX_DEVICE…KEYMASK) y el de la familia. fn no tiene bit de lado.
private struct ModifierBits {
    let device: UInt64
    let family: UInt64
}

private let modifierBits: [Int: ModifierBits] = [
    0x37: ModifierBits(device: 0x08, family: 0x100000), // ⌘ izquierda
    0x36: ModifierBits(device: 0x10, family: 0x100000), // ⌘ derecha
    0x38: ModifierBits(device: 0x02, family: 0x20000), // ⇧ izquierda
    0x3C: ModifierBits(device: 0x04, family: 0x20000), // ⇧ derecha
    0x3A: ModifierBits(device: 0x20, family: 0x80000), // ⌥ izquierda
    0x3D: ModifierBits(device: 0x40, family: 0x80000), // ⌥ derecha
    0x3B: ModifierBits(device: 0x01, family: 0x40000), // ⌃ izquierda
    0x3E: ModifierBits(device: 0x2000, family: 0x40000), // ⌃ derecha
    0x3F: ModifierBits(device: 0, family: 0x800000), // fn / 🌐
]

/// Bits de lado de cada familia, para saber si el teclado los informa.
private let deviceBitsByFamily: [UInt64: UInt64] = {
    var out: [UInt64: UInt64] = [:]
    for bits in modifierBits.values { out[bits.family, default: 0] |= bits.device }
    return out
}()

/// Códigos de main para «este modificador, de cualquier lado».
private let anySide: [Int: [Int]] = [
    0x1037: [0x37, 0x36],
    0x1038: [0x38, 0x3C],
    0x103A: [0x3A, 0x3D],
    0x103B: [0x3B, 0x3E],
]

struct Shortcut {
    let action: String
    /// Una entrada por tecla del atajo: las teclas físicas que la cumplen.
    let slots: [Set<Int>]
    let hasModifier: Bool

    init(action: String, keys: [Int]) {
        self.action = action
        slots = keys.map { Set(anySide[$0] ?? [$0]) }
        hasModifier = slots.contains { $0.contains { Keyboard.isModifier($0) } }
    }

    var allKeys: Set<Int> { slots.reduce(into: Set<Int>()) { $0.formUnion($1) } }

    /// Todas sus teclas están pulsadas.
    func satisfied(by pressed: Set<Int>) -> Bool {
        slots.allSatisfy { !$0.isDisjoint(with: pressed) }
    }
}

enum TapState: String {
    case active
    case noPermission = "no-permission"
    case failed
    case stopped
}

final class Keyboard {
    /// Umbrales de la «tormenta»: tantas desactivaciones por tiempo agotado en
    /// la ventana indican que el tap no se recupera; el helper sale y main lo
    /// relanza. Las de después de despertar el equipo son normales.
    static let stormCount = 5
    static let stormWindow: TimeInterval = 60
    static let wakeGrace: TimeInterval = 30
    static let stormExitCode: Int32 = 86
    static let dismissAction = "dismiss"

    /// Se llaman desde el hilo del tap; deben ser seguras entre hilos.
    var onKey: ((_ index: Int, _ key: Int, _ down: Bool, _ hidden: Int, _ name: String?) -> Void)?
    var onTapStatus: ((_ state: TapState, _ reason: String) -> Void)?

    private let lock = NSLock()
    // Protegido por `lock`.
    private var shortcuts: [Shortcut] = []
    private var shortcutKeys: Set<Int> = []
    private var dismiss: Shortcut?
    private var recording = false
    private var layout: KeyLayout?
    private var dictationActive = false
    private var pressed: Set<Int> = []
    private var forwarded: Set<Int> = []
    private var swallowed: Set<Int> = []
    private var index = 0
    private var lastWake = Date.distantPast
    private var tap: CFMachPort?
    private var runLoop: CFRunLoop?

    // Solo en el hilo del tap.
    private var timeouts: [Date] = []
    private var exiting = false

    private(set) var state: TapState = .stopped
    private(set) var stateReason = "not started"

    // MARK: Configuración (cola principal)

    func setShortcuts(_ list: [Shortcut]) {
        lock.lock()
        shortcuts = list
        shortcutKeys = list.reduce(into: Set<Int>()) { $0.formUnion($1.allKeys) }
        dismiss = list.first { $0.action == Keyboard.dismissAction }
        lock.unlock()
        Log.info("Shortcuts: \(list.map { "\($0.action)=\($0.slots.map { $0.sorted() })" }.joined(separator: ", "))")
    }

    /// Cola principal: la distribución de teclado solo se lee aquí.
    func setRecording(_ on: Bool) {
        let newLayout = on ? KeyLayout.current() : nil
        lock.lock()
        let changed = recording != on
        recording = on
        layout = newLayout
        lock.unlock()
        if changed { Log.info("Shortcut recording \(on ? "on" : "off")") }
    }

    func setDictationActive(_ active: Bool) {
        lock.lock()
        dictationActive = active
        lock.unlock()
    }

    func noteWake() {
        lock.lock()
        lastWake = Date()
        lock.unlock()
        Log.info("System woke; tap timeouts in the next \(Int(Keyboard.wakeGrace)) s are not counted")
        resync(reason: "wake")
    }

    var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return tap != nil
    }

    // MARK: Ciclo de vida del tap (cola principal)

    /// Crea el tap en un hilo propio. Devuelve false si el sistema lo rechaza.
    @discardableResult
    func start() -> Bool {
        if isRunning { return true }
        let ready = DispatchSemaphore(value: 0)
        var created = false
        let thread = Thread { [weak self] in
            guard let self else { ready.signal(); return }
            let mask = (1 << CGEventType.keyDown.rawValue)
                | (1 << CGEventType.keyUp.rawValue)
                | (1 << CGEventType.flagsChanged.rawValue)
            guard let port = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                options: .defaultTap,
                eventsOfInterest: CGEventMask(mask),
                callback: keyboardTapCallback,
                userInfo: Unmanaged.passUnretained(self).toOpaque()
            ) else {
                ready.signal()
                return
            }
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
            let loop = CFRunLoopGetCurrent()
            CFRunLoopAddSource(loop, source, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            self.lock.lock()
            self.tap = port
            self.runLoop = loop
            self.lock.unlock()
            created = true
            ready.signal()
            CFRunLoopRun()
            CFRunLoopRemoveSource(loop, source, .commonModes)
            CFMachPortInvalidate(port)
        }
        thread.name = "speech.helper.keyboard"
        thread.qualityOfService = .userInteractive
        thread.start()
        _ = ready.wait(timeout: .now() + 2)

        if created {
            setState(.active, "created")
        } else {
            setState(.failed, "the system refused to create the event tap")
        }
        return created
    }

    func stop(state newState: TapState, reason: String) {
        lock.lock()
        let loop = runLoop
        tap = nil
        runLoop = nil
        pressed.removeAll()
        forwarded.removeAll()
        swallowed.removeAll()
        lock.unlock()
        if let loop { CFRunLoopStop(loop) }
        setState(newState, reason)
    }

    /// Red de seguridad por si se pierde el aviso de desactivación.
    func watchdog() {
        lock.lock()
        let port = tap
        lock.unlock()
        guard let port, !CGEvent.tapIsEnabled(tap: port) else { return }
        Log.warn("Event tap found disabled; re-enabling")
        CGEvent.tapEnable(tap: port, enable: true)
        onTapStatus?(.active, "reenabled-watchdog")
        resync(reason: "watchdog")
    }

    private func setState(_ newState: TapState, _ reason: String) {
        let changed = newState != state || reason != stateReason
        state = newState
        stateReason = reason
        if changed {
            Log.info("Event tap: \(newState.rawValue) (\(reason))")
            onTapStatus?(newState, reason)
        }
    }

    static func isModifier(_ key: Int) -> Bool {
        modifierBits[key] != nil
    }

    // MARK: Teclas atascadas

    /// Devuelve las teclas de la lista que no están pulsadas ahora y las quita
    /// del estado propio.
    func releasedKeys(among keys: [Int]) -> [Int] {
        let released = keys.filter { !Keyboard.isKeyDown($0) }
        if !released.isEmpty {
            lock.lock()
            for k in released {
                pressed.remove(k)
                forwarded.remove(k)
                swallowed.remove(k)
            }
            lock.unlock()
        }
        return released
    }

    /// Tras perder eventos (tap desactivado, equipo dormido) se compara el
    /// estado propio con el real y se envía la suelta de lo que ya no está.
    private func resync(reason: String) {
        lock.lock()
        let stale = pressed.filter { !Keyboard.isKeyDown($0) }
        var ups: [(Int, Int)] = []
        for k in stale {
            pressed.remove(k)
            swallowed.remove(k)
            if forwarded.remove(k) != nil {
                index += 1
                ups.append((index, k))
            }
        }
        let hidden = pressed.subtracting(forwarded).count
        lock.unlock()
        if !stale.isEmpty { Log.info("Resync after \(reason): released \(stale.sorted())") }
        for (i, k) in ups { onKey?(i, k, false, hidden, nil) }
    }

    /// Estado real de una tecla. Los modificadores se leen de las banderas
    /// globales; el resto, del estado de teclas de la sesión.
    static func isKeyDown(_ key: Int) -> Bool {
        if let bits = modifierBits[key] {
            let flags = CGEventSource.flagsState(.combinedSessionState).rawValue
            if flags & bits.family == 0 { return false }
            let sideBits = deviceBitsByFamily[bits.family] ?? 0
            if bits.device != 0, flags & sideBits != 0 { return flags & bits.device != 0 }
            return true
        }
        return CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(key))
    }

    // MARK: Callback (hilo del tap)

    fileprivate func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        // El ⌘V del pegado no es del usuario.
        if type != .tapDisabledByTimeout, type != .tapDisabledByUserInput,
           event.getIntegerValueField(.eventSourceUserData) == Paster.syntheticEventMarker {
            return Unmanaged.passUnretained(event)
        }
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            tapDisabled(byTimeout: type == .tapDisabledByTimeout)
            return Unmanaged.passUnretained(event)
        case .keyDown, .keyUp:
            let key = Int(event.getIntegerValueField(.keyboardEventKeycode))
            let repeated = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
            return process(key: key, down: type == .keyDown, repeated: repeated) ? nil : Unmanaged.passUnretained(event)
        case .flagsChanged:
            let key = Int(event.getIntegerValueField(.keyboardEventKeycode))
            guard let down = modifierDown(key: key, flags: event.flags.rawValue) else {
                return Unmanaged.passUnretained(event)
            }
            _ = process(key: key, down: down, repeated: false)
            // Los modificadores nunca se consumen.
            return Unmanaged.passUnretained(event)
        default:
            return Unmanaged.passUnretained(event)
        }
    }

    /// Pulsación o suelta de un modificador según sus bits; nil si no es uno
    /// de los que se vigilan (Bloq Mayús, por ejemplo) o si no cambia nada.
    private func modifierDown(key: Int, flags: UInt64) -> Bool? {
        guard let bits = modifierBits[key] else { return nil }
        lock.lock()
        let wasDown = pressed.contains(key)
        lock.unlock()
        let down: Bool
        if flags & bits.family == 0 {
            down = false
        } else if bits.device == 0 {
            down = true
        } else if flags & (deviceBitsByFamily[bits.family] ?? 0) != 0 {
            down = flags & bits.device != 0
        } else {
            // Teclado que no informa del lado: se alterna.
            down = !wasDown
        }
        return down == wasDown ? nil : down
    }

    /// Actualiza el estado, envía lo que toque y dice si hay que tragarse el evento.
    private func process(key: Int, down: Bool, repeated: Bool) -> Bool {
        var message: (Int, Int, Bool, Int)?
        var swallow = false

        lock.lock()
        if recording {
            // Todo se envía; lo que no es modificador no llega a ninguna app.
            let name = Keyboard.isModifier(key) ? nil : layout?.name(of: key)
            let isMod = Keyboard.isModifier(key)
            var send = false
            if down {
                if !repeated, !pressed.contains(key) {
                    pressed.insert(key)
                    forwarded.insert(key)
                    send = true
                }
                if !isMod { swallowed.insert(key) }
            } else {
                pressed.remove(key)
                swallowed.remove(key)
                send = forwarded.remove(key) != nil
            }
            if send { index += 1 }
            let i = index
            lock.unlock()
            if send { onKey?(i, key, down, 0, name) }
            return !isMod
        }
        if down {
            if repeated || pressed.contains(key) {
                // Autorrepetición: no se envía; se traga si se tragó la primera pulsación.
                swallow = swallowed.contains(key)
            } else {
                let shortcutHeld = !forwarded.isDisjoint(with: shortcutKeys)
                pressed.insert(key)
                if shortcutKeys.contains(key) || shortcutHeld {
                    if shortcutKeys.contains(key) { dropStaleHiddenKeys(except: key) }
                    forwarded.insert(key)
                    index += 1
                    message = (index, key, true, pressed.subtracting(forwarded).count)
                }
                swallow = shouldSwallow(key)
                if swallow { swallowed.insert(key) }
            }
        } else {
            pressed.remove(key)
            swallow = swallowed.remove(key) != nil
            if forwarded.remove(key) != nil {
                index += 1
                message = (index, key, false, pressed.subtracting(forwarded).count)
            }
        }
        lock.unlock()

        if let (i, k, d, h) = message { onKey?(i, k, d, h, nil) }
        return swallow
    }

    /// Con `lock` tomado. Las teclas no enviadas que constan como pulsadas
    /// pueden ser restos de una suelta perdida; se comprueban antes de contar.
    private func dropStaleHiddenKeys(except key: Int) {
        for k in pressed.subtracting(forwarded) where k != key && !Keyboard.isKeyDown(k) {
            pressed.remove(k)
            swallowed.remove(k)
        }
    }

    /// Con `lock` tomado.
    private func shouldSwallow(_ key: Int) -> Bool {
        if modifierBits[key] != nil { return false }
        if dictationActive, let d = dismiss, d.allKeys.contains(key), d.satisfied(by: pressed) { return true }
        let modifiersHeld = pressed.filter { modifierBits[$0] != nil }
        for s in shortcuts where s.hasModifier && s.allKeys.contains(key) {
            // Exactamente sus modificadores (uno por entrada) y esta tecla.
            let modSlots = s.slots.filter { $0.contains { modifierBits[$0] != nil } }
            let keySlots = s.slots.filter { !$0.contains { modifierBits[$0] != nil } }
            if modSlots.count == modifiersHeld.count,
               modSlots.allSatisfy({ !$0.isDisjoint(with: modifiersHeld) }),
               keySlots.count == 1, keySlots[0].contains(key) {
                return true
            }
        }
        return false
    }

    private func tapDisabled(byTimeout: Bool) {
        lock.lock()
        let port = tap
        let wake = lastWake
        lock.unlock()
        let reason = byTimeout ? "timeout" : "user-input"
        Log.warn("Event tap disabled by the system (\(reason)); re-enabling")
        if let port, CFMachPortIsValid(port) {
            CGEvent.tapEnable(tap: port, enable: true)
        }
        onTapStatus?(.active, "reenabled-after-\(reason)")
        resync(reason: "tap disabled (\(reason))")

        guard byTimeout, !exiting else { return }
        let now = Date()
        if now.timeIntervalSince(wake) < Keyboard.wakeGrace { return }
        timeouts.append(now)
        timeouts.removeAll { now.timeIntervalSince($0) > Keyboard.stormWindow }
        if timeouts.count >= Keyboard.stormCount {
            exiting = true
            Log.error("Event tap timed out \(timeouts.count) times in \(Int(Keyboard.stormWindow)) s; exiting so main restarts the helper")
            onTapStatus?(.failed, "storm")
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                Helper.quit("event tap storm", code: Keyboard.stormExitCode)
            }
        }
    }
}

private func keyboardTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    refcon: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let refcon else { return Unmanaged.passUnretained(event) }
    let keyboard = Unmanaged<Keyboard>.fromOpaque(refcon).takeUnretainedValue()
    return keyboard.handle(type: type, event: event)
}
