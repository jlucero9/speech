import AppKit
import ApplicationServices

// Ciclo de vida y mensajes del helper. Todo corre en la cola principal salvo
// el callback del event tap (Keyboard.swift), que tiene su hilo.
//
// El tap se crea en cuanto hay permiso de Accesibilidad y se quita si se
// retira; la comprobación periódica lo vuelve a crear o a activar.
//
// Se cierra solo si:
// - stdin llega a EOF (main cerró la tubería o murió);
// - su proceso padre termina;
// - pasan 15 s sin ningún mensaje de main.

final class Helper {
    static let protocolVersion = 4
    private static let orphanTimeout: TimeInterval = 15
    private static let accessibilityPollInterval: TimeInterval = 2
    private static let tapRetryInterval: TimeInterval = 10

    private let launchedAt: Date
    private var ipc: IPC!
    private var lastMessageAt = Date()
    private var accessibilityTrusted = AXIsProcessTrusted()
    private var lastTapAttempt = Date.distantPast
    private var timers: [DispatchSourceTimer] = []
    private var parentWatcher: DispatchSourceProcess?
    private var activity: NSObjectProtocol?
    private let keyboard = Keyboard()
    private let secureInput = SecureInputMonitor()
    private let paster = Paster()

    init(launchedAt: Date) {
        self.launchedAt = launchedAt
    }

    func start() {
        // Que el sistema no lo duerma (App Nap) mientras main dependa de él.
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical],
            reason: "Speech helper handles shortcuts and pasting"
        )

        ipc = IPC(
            onRequest: { [weak self] request in self?.handle(request) },
            onClose: { Helper.quit("main closed the connection") }
        )
        ipc.startReading()
        setUpKeyboard()
        watchParent()
        startTimers()
        observeAccessibilityChanges()
        observeWake()
        Log.info("Helper started: pid \(getpid()), responsibility disclaimed: \(Responsibility.isDisclaimed), accessibility: \(accessibilityTrusted)")
        if #available(macOS 15.4, *) {
            Log.info("Clipboard access: \(NSPasteboard.general.accessBehavior.rawValue) (0 default, 1 ask, 2 allow, 3 deny)")
        }
    }

    // MARK: Mensajes

    private func handle(_ request: IncomingRequest) {
        lastMessageAt = Date()
        switch request.type {
        case "IsReady":
            ipc.respond(to: request.id, type: "ACK", payload: [
                "pid": Int(getpid()),
                "protocolVersion": Helper.protocolVersion,
                "launchMs": Int(Date().timeIntervalSince(launchedAt) * 1000),
                "disclaimed": Responsibility.isDisclaimed,
                "tap": keyboard.state.rawValue,
            ])
        case "GetAccessibilityStatus":
            ipc.respond(to: request.id, type: "AccessibilityStatus", payload: ["trusted": checkAccessibility()])
        case "RequestAccessibilityPermission":
            // Muestra el diálogo del sistema si no hay permiso.
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            let trusted = AXIsProcessTrustedWithOptions(options)
            Log.info("Requested accessibility permission; trusted: \(trusted)")
            ipc.respond(to: request.id, type: "AccessibilityStatus", payload: ["trusted": trusted])
        case "UpdateShortcuts":
            let list = (request.payload["shortcuts"] as? [[String: Any]] ?? []).compactMap { item -> Shortcut? in
                guard let action = item["action"] as? String, let keys = item["keys"] as? [Int], !keys.isEmpty else {
                    Log.warn("Skipping unparseable shortcut \(item)")
                    return nil
                }
                let set = Set(keys)
                return Shortcut(action: action, keys: set, hasModifier: set.contains { Keyboard.isModifier($0) })
            }
            keyboard.setShortcuts(list)
            ipc.respond(to: request.id, type: "OK")
        case "SetDictationActive":
            keyboard.setDictationActive(request.payload["active"] as? Bool ?? false)
            ipc.respond(to: request.id, type: "OK")
        case "CheckStaleKeys":
            let keys = request.payload["keys"] as? [Int] ?? []
            let released = keyboard.releasedKeys(among: keys)
            if !released.isEmpty { Log.info("Stale keys released: \(released)") }
            ipc.respond(to: request.id, type: "StaleKeys", payload: ["released": released])
        case "CaptureTarget":
            let id = request.payload["id"] as? String ?? ""
            ipc.respond(to: request.id, type: "Target", payload: paster.captureTarget(id: id))
        case "PasteText":
            guard let pasteId = request.payload["pasteId"] as? String, let text = request.payload["text"] as? String else {
                ipc.respond(to: request.id, type: "Error", payload: ["message": "PasteText needs pasteId and text"])
                return
            }
            let targetId = request.payload["targetId"] as? String
            paster.paste(id: pasteId, text: text, targetId: targetId) { [ipc] payload in
                ipc?.respond(to: request.id, type: "PasteStarted", payload: payload)
            }
        case "GetKeyboardStatus":
            ipc.respond(to: request.id, type: "KeyboardStatus", payload: keyboardStatus())
        case "RequestInputMonitoring":
            // Muestra el diálogo del sistema si no hay permiso.
            let granted = CGRequestListenEventAccess()
            Log.info("Requested input monitoring permission; granted: \(granted)")
            ipc.respond(to: request.id, type: "InputMonitoringStatus", payload: ["granted": granted])
        default:
            Log.warn("Unknown request type \(request.type)")
            ipc.respond(to: request.id, type: "Error", payload: ["message": "Unknown request type \(request.type)"])
        }
    }

    // MARK: Teclado

    private func setUpKeyboard() {
        keyboard.onKey = { [ipc] index, key, down, hidden in
            ipc?.emit(event: "KeyEvent", payload: ["index": index, "key": key, "down": down, "hidden": hidden])
        }
        keyboard.onTapStatus = { [weak self] state, reason in
            guard let self else { return }
            self.ipc.emit(event: "TapStatus", payload: [
                "state": state.rawValue,
                "reason": reason,
                "listenAccess": CGPreflightListenEventAccess(),
            ])
        }
        paster.onOutcome = { [ipc] payload in
            ipc?.emit(event: "PasteOutcome", payload: payload)
        }
        secureInput.onChange = { [weak self] _, _ in
            guard let self else { return }
            self.ipc.emit(event: "SecureInputStatus", payload: self.secureInput.payload)
        }
        syncTap()
        secureInput.poll()
    }

    /// Crea o quita el tap según el permiso, y lo reactiva si el sistema lo apagó.
    private func syncTap() {
        if accessibilityTrusted {
            if keyboard.isRunning {
                keyboard.watchdog()
            } else if keyboard.state != .failed || Date().timeIntervalSince(lastTapAttempt) >= Helper.tapRetryInterval {
                lastTapAttempt = Date()
                keyboard.start()
            }
        } else if keyboard.isRunning || keyboard.state != .noPermission {
            keyboard.stop(state: .noPermission, reason: "accessibility permission not granted")
        }
    }

    private func keyboardStatus() -> [String: Any] {
        [
            "tap": keyboard.state.rawValue,
            "reason": keyboard.stateReason,
            "listenAccess": CGPreflightListenEventAccess(),
            "secureInput": secureInput.payload,
            "fnUsage": FnUsage.current(),
        ]
    }

    private func observeWake() {
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in self?.keyboard.noteWake() }
    }

    // MARK: Accesibilidad

    /// Lee el permiso y avisa a main si cambió.
    @discardableResult
    private func checkAccessibility() -> Bool {
        let trusted = AXIsProcessTrusted()
        if trusted != accessibilityTrusted {
            accessibilityTrusted = trusted
            Log.info("Accessibility permission changed: \(trusted)")
            ipc.emit(event: "AccessibilityStatusChanged", payload: ["trusted": trusted])
            syncTap()
        }
        return trusted
    }

    /// El sistema publica esta notificación al cambiar la lista de Accesibilidad.
    /// El cambio tarda un poco en reflejarse, así que se comprueba con retraso.
    private func observeAccessibilityChanges() {
        DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("com.apple.accessibility.api"),
            object: nil,
            queue: .main
        ) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self?.checkAccessibility() }
        }
    }

    // MARK: Vigilancia

    private func watchParent() {
        let parent = getppid()
        if parent == 1 {
            Helper.quit("parent already gone")
        }
        let source = DispatchSource.makeProcessSource(identifier: parent, eventMask: .exit, queue: .main)
        source.setEventHandler { Helper.quit("parent process \(parent) exited") }
        source.resume()
        parentWatcher = source
    }

    private func startTimers() {
        addTimer(every: 1) { [weak self] in
            guard let self else { return }
            if Date().timeIntervalSince(self.lastMessageAt) > Helper.orphanTimeout {
                Helper.quit("no message from main in \(Int(Helper.orphanTimeout)) s")
            }
        }
        addTimer(every: Helper.accessibilityPollInterval) { [weak self] in
            self?.checkAccessibility()
            self?.syncTap()
        }
        addTimer(every: SecureInputMonitor.pollInterval) { [weak self] in
            self?.secureInput.poll()
        }
    }

    private func addTimer(every interval: TimeInterval, _ handler: @escaping () -> Void) {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(100))
        timer.setEventHandler(handler: handler)
        timer.resume()
        timers.append(timer)
    }

    static func quit(_ reason: String, code: Int32 = 0) -> Never {
        Log.info("Helper exiting: \(reason)")
        // Dar tiempo a que salga la línea de registro.
        usleep(50_000)
        exit(code)
    }
}
