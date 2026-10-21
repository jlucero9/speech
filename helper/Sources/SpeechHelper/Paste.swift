import AppKit
import ApplicationServices
import Carbon

// Pegado del texto dictado en la app que tenía el foco al empezar a dictar.
//
// 1. Al empezar el dictado, main pide `CaptureTarget`: se anotan la app de
//    delante, su ventana y el elemento con foco.
// 2. Al pegar, si esa app ya no está delante se la vuelve a traer, con su
//    ventana y su campo. Si se cerró o no vuelve, no se pega.
// 3. Se espera a que el usuario suelte ⌘, ⇧, ⌥ y ⌃ (1 s como mucho).
// 4. Se guarda el portapapeles: todos sus elementos, con todos sus tipos.
// 5. Se publica un elemento que *promete* el texto: el dato no se entrega
//    hasta que una app lo pide. Lleva las marcas de contenido pasajero de
//    nspasteboard.org para que los gestores de portapapeles que las respetan
//    ni lo lean ni lo guarden, y no se comparte con otros equipos.
// 6. ⌘V sintético, marcado para que el tap propio no lo tome por el usuario.
// 7. Si alguna app pide el dato en 1 s, el pegado llegó. Como un gestor de
//    portapapeles que lea el dato daría un falso éxito, se comprueba además
//    por Accesibilidad que el texto esté en el campo cuando este deja leer su
//    contenido. Confirmado, se restaura el portapapeles 0,5 s después de la
//    petición, salvo que alguien haya copiado otra cosa entretanto.
// 8. Si nadie pide el dato, si lo pide alguien antes del ⌘V (un gestor) sin
//    que el texto aparezca en el campo, o si el campo deja leer su contenido y
//    el texto no está: se escribe el texto de verdad en el portapapeles (para
//    que no dependa de este proceso), no se restaura nada y main avisa.
//
// Todo corre en la cola principal: el sistema pide el dato prometido por ahí,
// así que nada de esto la bloquea más de unos milisegundos.

struct PasteTarget {
    let pid: pid_t
    let bundleId: String?
    let name: String?
    let window: AXUIElement?
    let element: AXUIElement?
}

enum PasteResult: String {
    /// Una app pidió el dato y el texto está en el campo con foco.
    case pasted
    /// Una app pidió el dato; el campo no deja leer su contenido.
    case pastedUnverified = "pasted_unverified"
    /// Alguien pidió el dato, pero no consta que llegara al campo.
    case unconfirmed
    /// Nadie pidió el dato en 1 s.
    case notRequested = "not_requested"
    /// La app de destino se cerró antes de pegar.
    case targetGone = "target_gone"
    /// La app de destino no volvió a ponerse delante.
    case focusFailed = "focus_failed"

    var succeeded: Bool { self == .pasted || self == .pastedUnverified }
}

private enum Verification: String {
    case found
    case notFound = "not_found"
    /// El elemento con foco no es de texto (una lista, un botón…).
    case notEditable = "not_editable"
    /// No se pudo leer el contenido del elemento con foco.
    case unavailable
}

private final class ActivePaste {
    let id: String
    let text: String
    let pid: pid_t?
    let appName: String?
    let bundleId: String?
    let receivedAt = Date()
    var keystrokeAt: Date?
    var requestedAt: Date?
    var earlyRead = false
    var timeout: DispatchWorkItem?
    var reported = false

    init(id: String, text: String, pid: pid_t?, appName: String?, bundleId: String?) {
        self.id = id
        self.text = text
        self.pid = pid
        self.appName = appName
        self.bundleId = bundleId
    }

    func ms(_ date: Date?) -> Any {
        guard let date else { return NSNull() }
        return Int((date.timeIntervalSince(receivedAt) * 1000).rounded())
    }
}

private func orNull(_ value: Any?) -> Any {
    value ?? NSNull()
}

final class Paster: NSObject, NSPasteboardItemDataProvider {
    /// Valor del campo «datos del origen» de los eventos sintéticos.
    static let syntheticEventMarker: Int64 = 0x5350_4348

    private static let requestTimeout: TimeInterval = 1.0
    private static let restoreDelay: TimeInterval = 0.5
    private static let writeSettle: TimeInterval = 0.010
    private static let keyGapMicroseconds: useconds_t = 5_000
    private static let focusTimeout: TimeInterval = 1.0
    private static let modifiersTimeout: TimeInterval = 1.0
    private static let pollInterval: TimeInterval = 0.020
    /// Comprobaciones del campo tras la petición del dato; la última antes de restaurar.
    private static let verifyDelays: [TimeInterval] = [0.05, 0.15, 0.3, 0.45]
    /// Un contenido más largo no se compara (terminales con mucho historial).
    private static let verifyMaxLength = 500_000
    private static let axTimeout: Float = 0.25
    /// Papeles de Accesibilidad que nunca reciben texto pegado. Los ambiguos
    /// (AXGroup, AXScrollArea, AXLayoutArea…) no están: hay editores propios
    /// que se presentan así.
    private static let nonTextRoles: Set<String> = [
        "AXList", "AXOutline", "AXTable", "AXBrowser", "AXRow", "AXCell", "AXButton", "AXCheckBox",
        "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXImage", "AXSlider", "AXTabGroup", "AXToolbar",
        "AXWindow", "AXSheet", "AXMenu", "AXMenuItem", "AXDisclosureTriangle", "AXLink",
    ]
    private static let keptTargets = 8

    private static let transientType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
    private static let autoGeneratedType = NSPasteboard.PasteboardType("org.nspasteboard.AutoGeneratedType")
    private static let modifierMask: CGEventFlags = [.maskCommand, .maskShift, .maskAlternate, .maskControl]

    /// Resultado de cada pegado, una vez.
    var onOutcome: (([String: Any]) -> Void)?

    private var targets: [(id: String, target: PasteTarget)] = []
    /// Los pegados van de uno en uno: el siguiente espera al resultado del anterior.
    private var queue: [() -> Void] = []
    private var active: ActivePaste?
    /// Texto prometido ahora mismo en el portapapeles.
    private var promised: String?
    /// Lo que había antes del primer pegado de una serie, hasta restaurarlo.
    private var saved: [[(NSPasteboard.PasteboardType, Data)]]?
    /// `changeCount` tras escribir el texto: si cambia, alguien copió otra cosa.
    private var ownChangeCount: Int?
    private var restoreWork: DispatchWorkItem?
    /// La última app ajena a Speech que pasó a primer plano. La barra flotante
    /// no se activa al hacer clic, pero si Accesibilidad la diera por la app
    /// con el foco, el texto iría a parar a Speech: se usa esta en su lugar.
    private var lastExternalApp: NSRunningApplication?
    private var activationObserver: NSObjectProtocol?

    override init() {
        super.init()
        if let front = NSWorkspace.shared.frontmostApplication, !Paster.isOwn(front) { lastExternalApp = front }
        activationObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            if !Paster.isOwn(app) { self?.lastExternalApp = app }
        }
    }

    /// Speech (el proceso que lanzó el helper, o cualquier app local.speech.*).
    private static func isOwn(_ app: NSRunningApplication) -> Bool {
        app.processIdentifier == getppid() || (app.bundleIdentifier?.hasPrefix("local.speech.") ?? false)
    }

    /// La app de delante, sin contar a Speech: la que dice Accesibilidad, la del
    /// workspace o, si las dos son Speech, la última ajena que estuvo delante.
    private func frontApp() -> NSRunningApplication? {
        let workspace = NSWorkspace.shared.frontmostApplication
        let live = Paster.frontPid().flatMap { NSRunningApplication(processIdentifier: $0) }
        if live?.processIdentifier != workspace?.processIdentifier {
            Log.warn("Frontmost app: workspace says \(workspace?.localizedName ?? "none") (\(workspace?.processIdentifier ?? 0)), accessibility says \(live?.localizedName ?? "none") (\(live?.processIdentifier ?? 0))")
        }
        for candidate in [live, workspace] {
            guard let app = candidate else { continue }
            if !Paster.isOwn(app) { return app }
        }
        if let app = lastExternalApp, !app.isTerminated {
            Log.warn("Speech is in front; using the last other app in front, \(app.localizedName ?? "?")")
            return app
        }
        return nil
    }

    // MARK: Destino

    /// Anota la app de delante y su elemento con foco con la clave `id`.
    func captureTarget(id: String) -> [String: Any] {
        guard let app = frontApp() else {
            Log.warn("CaptureTarget: no frontmost app")
            return [:]
        }
        let pid = app.processIdentifier
        let axApp = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(axApp, Paster.axTimeout)
        let started = Date()
        TextContext.enableManualAccessibility(axApp, pid: pid)
        let target = PasteTarget(
            pid: pid,
            bundleId: app.bundleIdentifier,
            name: app.localizedName,
            window: Paster.element(axApp, kAXFocusedWindowAttribute),
            element: Paster.element(axApp, kAXFocusedUIElementAttribute)
        )
        targets.removeAll { $0.id == id }
        targets.append((id, target))
        if targets.count > Paster.keptTargets { targets.removeFirst(targets.count - Paster.keptTargets) }
        let role = target.element.flatMap { Paster.string($0, kAXRoleAttribute) } ?? "none"
        let context = TextContext.read(target.element)
        let ms = Int((Date().timeIntervalSince(started) * 1000).rounded())
        // En el registro, solo cuánto texto se leyó: nunca el texto.
        let read = (context["unavailable"] as? String).map { "text not read: \($0)" }
            ?? "text read: \((context["before"] as? String)?.utf16.count ?? 0) before, \((context["after"] as? String)?.utf16.count ?? 0) after"
        Log.info("Paste target: \(target.name ?? "?") (\(target.bundleId ?? "?"), pid \(pid)), focused \(role), \(read), \(ms) ms")
        return [
            "pid": Int(pid),
            "appName": orNull(target.name),
            "bundleId": orNull(target.bundleId),
            "context": context,
        ]
    }

    // MARK: Pegado

    /// Pega `text`. `posted` se llama una vez, al enviar el ⌘V o al saber que
    /// no se enviará; el resultado llega después por `onOutcome`.
    func paste(id: String, text: String, targetId: String?, posted: @escaping ([String: Any]) -> Void) {
        queue.append { [weak self] in self?.start(id: id, text: text, targetId: targetId, posted: posted) }
        if active == nil {
            queue.removeFirst()()
        } else {
            Log.info("Paste \(id.prefix(8)) waits for the previous one")
        }
    }

    private func start(id: String, text: String, targetId: String?, posted: @escaping ([String: Any]) -> Void) {
        let target = targetId.flatMap { id in targets.first { $0.id == id }?.target }
        if targetId != nil, target == nil { Log.warn("Paste target \(targetId!.prefix(8)) unknown; pasting where the focus is") }
        let front = target == nil ? frontApp() : nil
        let p = ActivePaste(
            id: id,
            text: text,
            pid: target?.pid ?? front?.processIdentifier,
            appName: target?.name ?? front?.localizedName,
            bundleId: target?.bundleId ?? front?.bundleIdentifier
        )
        active = p

        bringBack(target) { [weak self] result in
            guard let self, self.active === p else { return }
            if let result {
                self.leaveOnClipboard(p.text)
                self.finish(p, result, verification: nil)
                posted(["posted": false])
                return
            }
            self.whenModifiersUp { [weak self] in
                guard let self, self.active === p else { return }
                self.writeAndPaste(p, posted: posted)
            }
        }
    }

    private func writeAndPaste(_ p: ActivePaste, posted: @escaping ([String: Any]) -> Void) {
        let pb = NSPasteboard.general
        let started = Date()

        // Si lo que hay es el texto del pegado anterior, aún sin restaurar, lo
        // guardado sigue siendo lo del usuario.
        restoreWork?.cancel()
        restoreWork = nil
        if saved == nil || pb.changeCount != ownChangeCount {
            saved = Paster.snapshot(pb)
        }
        let saveMs = Int(Date().timeIntervalSince(started) * 1000)

        let before = pb.changeCount
        _ = pb.prepareForNewContents(with: .currentHostOnly)
        let item = NSPasteboardItem()
        item.setDataProvider(self, forTypes: [.string])
        item.setData(Data(), forType: Paster.transientType)
        item.setData(Data(), forType: Paster.autoGeneratedType)
        promised = p.text
        pb.writeObjects([item])
        ownChangeCount = pb.changeCount

        DispatchQueue.main.asyncAfter(deadline: .now() + Paster.writeSettle) { [weak self] in
            guard let self, self.active === p else { return }
            if pb.changeCount == before { Log.warn("Pasteboard content was not updated") }
            Paster.postCommandV()
            p.keystrokeAt = Date()
            if p.requestedAt != nil { p.earlyRead = true }
            Log.info("Paste \(p.id.prefix(8)): ⌘V sent to \(p.appName ?? "?") \(p.ms(p.keystrokeAt)) ms after the request (clipboard saved in \(saveMs) ms)")
            posted(["posted": true])
            if p.requestedAt != nil {
                self.startVerification(p)
            } else {
                let work = DispatchWorkItem { [weak self] in
                    guard let self, self.active === p, !p.reported else { return }
                    Log.warn("Paste \(p.id.prefix(8)): no app asked for the text within \(Paster.requestTimeout) s")
                    self.leaveOnClipboard(p.text)
                    self.finish(p, .notRequested, verification: nil)
                }
                p.timeout = work
                DispatchQueue.main.asyncAfter(deadline: .now() + Paster.requestTimeout, execute: work)
            }
        }
    }

    // MARK: NSPasteboardItemDataProvider

    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        guard let text = promised else { return }
        item.setString(text, forType: type)
        guard let p = active, !p.reported, p.requestedAt == nil, p.text == text else { return }
        p.requestedAt = Date()
        p.timeout?.cancel()
        if p.keystrokeAt == nil {
            // Antes del ⌘V solo puede haberlo pedido otro proceso.
            Log.warn("Paste \(p.id.prefix(8)): the text was read before ⌘V, probably by a clipboard manager")
        } else {
            Log.info("Paste \(p.id.prefix(8)): text requested \(p.ms(p.requestedAt)) ms after the request")
            startVerification(p)
        }
    }

    func pasteboardFinishedWithDataProvider(_ pasteboard: NSPasteboard) {}

    // MARK: Comprobación y final

    private func startVerification(_ p: ActivePaste) {
        var remaining = Paster.verifyDelays
        let base = p.requestedAt ?? Date()
        func next() {
            let delay = remaining.removeFirst()
            let deadline = DispatchTime.now() + max(0, delay - Date().timeIntervalSince(base))
            DispatchQueue.main.asyncAfter(deadline: deadline) { [weak self] in
                guard let self, self.active === p, !p.reported else { return }
                let v = Paster.verify(p.text, pid: p.pid)
                if v == .found || remaining.isEmpty {
                    self.conclude(p, v)
                } else {
                    next()
                }
            }
        }
        next()
    }

    private func conclude(_ p: ActivePaste, _ v: Verification) {
        let result: PasteResult
        switch v {
        case .found: result = .pasted
        case .unavailable: result = p.earlyRead ? .unconfirmed : .pastedUnverified
        case .notFound, .notEditable: result = .unconfirmed
        }
        if result.succeeded {
            scheduleRestore(after: max(0, Paster.restoreDelay - Date().timeIntervalSince(p.requestedAt ?? Date())))
        } else {
            Log.warn("Paste \(p.id.prefix(8)): could not confirm it reached the text field (\(v.rawValue), read before ⌘V: \(p.earlyRead))")
            leaveOnClipboard(p.text)
        }
        finish(p, result, verification: v)
    }

    private func finish(_ p: ActivePaste, _ result: PasteResult, verification: Verification?) {
        guard !p.reported else { return }
        p.reported = true
        p.timeout?.cancel()
        Log.info("Paste \(p.id.prefix(8)): \(result.rawValue)")
        onOutcome?([
            "pasteId": p.id,
            "result": result.rawValue,
            "keystrokeMs": p.ms(p.keystrokeAt),
            "requestedMs": p.ms(p.requestedAt),
            "verification": orNull(verification?.rawValue),
            "earlyRead": p.earlyRead,
            "appName": orNull(p.appName),
            "bundleId": orNull(p.bundleId),
        ])
        if active === p {
            active = nil
            if !queue.isEmpty {
                let next = queue.removeFirst()
                DispatchQueue.main.async(execute: next)
            }
        }
    }

    // MARK: Portapapeles

    private func scheduleRestore(after delay: TimeInterval) {
        restoreWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.restoreWork = nil
            self.restore()
        }
        restoreWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func restore() {
        let pb = NSPasteboard.general
        defer {
            saved = nil
            ownChangeCount = nil
            promised = nil
        }
        guard let saved else { return }
        guard pb.changeCount == ownChangeCount else {
            Log.info("Clipboard changed after pasting; not restoring it")
            return
        }
        pb.clearContents()
        let items = saved.map { entries -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in entries { item.setData(data, forType: type) }
            return item
        }
        if !items.isEmpty { pb.writeObjects(items) }
        Log.info("Clipboard restored (\(items.count) item(s))")
    }

    /// El texto, escrito de verdad, para pegarlo a mano. Lo guardado se descarta.
    private func leaveOnClipboard(_ text: String) {
        restoreWork?.cancel()
        restoreWork = nil
        saved = nil
        promised = nil
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        ownChangeCount = nil
    }

    private static func snapshot(_ pb: NSPasteboard) -> [[(NSPasteboard.PasteboardType, Data)]] {
        let items = (pb.pasteboardItems ?? []).map { item in
            item.types.compactMap { type in item.data(forType: type).map { (type, $0) } }
        }
        let bytes = items.reduce(0) { $0 + $1.reduce(0) { $0 + $1.1.count } }
        Log.info("Saved clipboard: \(items.count) item(s), \(items.reduce(0) { $0 + $1.count }) type(s), \(bytes) bytes")
        return items
    }

    // MARK: Foco

    /// Devuelve nil si el destino está delante (o no hay destino); si no, por qué no se pega.
    private func bringBack(_ target: PasteTarget?, done: @escaping (PasteResult?) -> Void) {
        guard let target else { return done(nil) }
        // La lista de apps del workspace puede no tener la app un momento
        // aunque siga abierta: solo cuenta como cerrada si su proceso no existe.
        let listed = NSRunningApplication(processIdentifier: target.pid)
        let app = listed?.isTerminated == false ? listed : nil
        if app == nil {
            guard kill(target.pid, 0) == 0 else {
                Log.warn("Paste target \(target.name ?? "?") has quit")
                return done(.targetGone)
            }
            Log.warn("Paste target \(target.name ?? "?") is not listed as running (\(listed == nil ? "no entry" : "terminated")), but its process is alive")
        }
        let focusElement = {
            guard let element = target.element else { return }
            let axApp = AXUIElementCreateApplication(target.pid)
            AXUIElementSetMessagingTimeout(axApp, Paster.axTimeout)
            if let current = Paster.element(axApp, kAXFocusedUIElementAttribute), CFEqual(current, element) { return }
            let err = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            Log.info("Focus moved inside \(target.name ?? "?"); returning it to the original field: \(err == .success ? "ok" : "AX error \(err.rawValue)")")
        }
        if Paster.frontPid() == target.pid {
            focusElement()
            return done(nil)
        }

        Log.info("\(target.name ?? "?") is no longer in front; bringing it back")
        let axApp = AXUIElementCreateApplication(target.pid)
        AXUIElementSetMessagingTimeout(axApp, Paster.axTimeout)
        if let window = target.window {
            AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
            AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        }
        AXUIElementSetAttributeValue(axApp, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        if let app {
            if #available(macOS 14, *) { app.activate() } else { app.activate(options: []) }
        }

        let started = Date()
        func check() {
            if Paster.frontPid() == target.pid {
                Log.info("\(target.name ?? "?") back in front after \(Int(Date().timeIntervalSince(started) * 1000)) ms")
                focusElement()
                // Que la ventana termine de ser la principal antes de la tecla.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { done(nil) }
            } else if Date().timeIntervalSince(started) >= Paster.focusTimeout {
                Log.warn("\(target.name ?? "?") did not come back in front")
                done(.focusFailed)
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + Paster.pollInterval, execute: check)
            }
        }
        check()
    }

    /// Espera a que no haya ⌘, ⇧, ⌥ ni ⌃ pulsados en el teclado; fn no
    /// molesta. Se mira el estado físico: el de la sesión puede quedarse con
    /// un modificador «pulsado» por eventos sintéticos de otros programas.
    private func whenModifiersUp(_ done: @escaping () -> Void) {
        let started = Date()
        func check() {
            let held = CGEventSource.flagsState(.hidSystemState).intersection(Paster.modifierMask)
            if held.isEmpty {
                done()
            } else if Date().timeIntervalSince(started) >= Paster.modifiersTimeout {
                Log.warn("Modifier keys still held after \(Paster.modifiersTimeout) s (flags 0x\(String(held.rawValue, radix: 16))); pasting anyway")
                done()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + Paster.pollInterval, execute: check)
            }
        }
        check()
    }

    /// La app con el foco del teclado, preguntada al momento.
    private static func frontPid() -> pid_t? {
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, axTimeout)
        if let app = element(system, kAXFocusedApplicationAttribute) {
            var pid: pid_t = 0
            if AXUIElementGetPid(app, &pid) == .success { return pid }
        }
        Log.warn("Accessibility did not say which app is in front; asking the workspace")
        return NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

    // MARK: Tecla

    private static func postCommandV() {
        let key = keyCode(for: "v") ?? 0x09
        let source = CGEventSource(stateID: .combinedSessionState)
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else {
                Log.error("Could not create the ⌘V event")
                return
            }
            event.flags = .maskCommand
            event.setIntegerValueField(.eventSourceUserData, value: syntheticEventMarker)
            event.post(tap: .cgSessionEventTap)
            if down { usleep(keyGapMicroseconds) }
        }
    }

    /// Tecla que escribe `character` en la distribución de teclado activa.
    private static func keyCode(for character: Character) -> CGKeyCode? {
        guard
            let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
            let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
        else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        let target = Array(String(character).utf16)
        return data.withUnsafeBytes { bytes -> CGKeyCode? in
            guard let layout = bytes.bindMemory(to: UCKeyboardLayout.self).baseAddress else { return nil }
            for code in 0..<128 {
                var deadKeys: UInt32 = 0
                var length = 0
                var chars = [UniChar](repeating: 0, count: 4)
                let status = UCKeyTranslate(
                    layout, UInt16(code), UInt16(kUCKeyActionDisplay), 0, UInt32(LMGetKbdType()),
                    OptionBits(kUCKeyTranslateNoDeadKeysMask), &deadKeys, chars.count, &length, &chars
                )
                if status == noErr, Array(chars.prefix(length)) == target { return CGKeyCode(code) }
            }
            return nil
        }
    }

    // MARK: Accesibilidad

    /// ¿Está el texto en el elemento con foco de la app? Se comparan sin
    /// espacios ni saltos: las terminales parten las líneas largas.
    private static func verify(_ text: String, pid: pid_t?) -> Verification {
        guard let pid else { return .unavailable }
        let axApp = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(axApp, axTimeout)
        guard let focused = element(axApp, kAXFocusedUIElementAttribute) else { return .unavailable }
        guard let value = string(focused, kAXValueAttribute), value.utf16.count <= verifyMaxLength else {
            let role = string(focused, kAXRoleAttribute) ?? ""
            return nonTextRoles.contains(role) ? .notEditable : .unavailable
        }
        let needle = compact(text)
        if needle.isEmpty { return .unavailable }
        return compact(value).contains(needle) ? .found : .notFound
    }

    private static func compact(_ s: String) -> String {
        String(String.UnicodeScalarView(s.unicodeScalars.filter { !CharacterSet.whitespacesAndNewlines.contains($0) }))
    }

    private static func element(_ from: AXUIElement, _ attribute: String) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(from, attribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return nil }
        return (value as! AXUIElement)
    }

    private static func string(_ from: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(from, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }
}
