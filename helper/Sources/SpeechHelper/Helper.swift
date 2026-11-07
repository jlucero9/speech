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
// - pasan 15 s despierto sin ningún mensaje de main;
// - recibe SIGTERM o SIGINT.
// Al salir, devuelve el sonido si lo había silenciado.

final class Helper {
    static let protocolVersion = 6
    /// La grabación de un atajo se apaga sola pasado este tiempo.
    private static let recordingTimeout: TimeInterval = 60
    private static let orphanTimeout: TimeInterval = 15
    private static let accessibilityPollInterval: TimeInterval = 2
    private static let tapRetryInterval: TimeInterval = 10

    private let launchedAt: Date
    private var ipc: IPC!
    /// En tiempo despierto (systemUptime no avanza con el equipo dormido): al
    /// despertar de un reposo, aunque sea de mantenimiento, el silencio de main
    /// mientras dormía no cuenta como que main haya muerto.
    private var lastMessageAt = ProcessInfo.processInfo.systemUptime
    private var accessibilityTrusted = AXIsProcessTrusted()
    private var lastTapAttempt = Date.distantPast
    private var timers: [DispatchSourceTimer] = []
    private var parentWatcher: DispatchSourceProcess?
    private var activity: NSObjectProtocol?
    private var signalSources: [DispatchSourceSignal] = []
    private var recordingTimer: DispatchWorkItem?
    private var memoryPressure: DispatchSourceMemoryPressure?
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
        // Antes de atender a main: el sonido que dejó silenciado un helper anterior.
        OutputMute.recoverFromMarker()
        ipc.startReading()
        watchSignals()
        setUpKeyboard()
        watchParent()
        startTimers()
        observeAccessibilityChanges()
        observeWake()
        observeMemoryPressure()
        Log.info("Helper started: pid \(getpid()), responsibility disclaimed: \(Responsibility.isDisclaimed), accessibility: \(accessibilityTrusted)")
        if #available(macOS 15.4, *) {
            Log.info("Clipboard access: \(NSPasteboard.general.accessBehavior.rawValue) (0 default, 1 ask, 2 allow, 3 deny)")
        }
    }

    // MARK: Mensajes

    private func handle(_ request: IncomingRequest) {
        lastMessageAt = ProcessInfo.processInfo.systemUptime
        switch request.type {
        case "IsReady":
            ipc.respond(to: request.id, type: "ACK", payload: [
                "pid": Int(getpid()),
                "protocolVersion": Helper.protocolVersion,
                "launchMs": Int(Date().timeIntervalSince(launchedAt) * 1000),
                "disclaimed": Responsibility.isDisclaimed,
                "tap": keyboard.state.rawValue,
                "memoryPressure": Helper.memoryPressureLevel(),
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
                return Shortcut(action: action, keys: keys)
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
        case "SetShortcutRecording":
            setRecording(request.payload["on"] as? Bool ?? false)
            ipc.respond(to: request.id, type: "OK")
        case "SetOutputMuted":
            let muted = request.payload["muted"] as? Bool ?? false
            let r = OutputMute.set(muted)
            Log.info("Output mute \(muted ? "on" : "off"): \(r.detail)")
            ipc.respond(to: request.id, type: "OutputMute", payload: ["changed": r.changed, "detail": r.detail])
        case "CaptureTarget":
            let id = request.payload["id"] as? String ?? ""
            let readContext = request.payload["readContext"] as? Bool ?? true
            ipc.respond(to: request.id, type: "Target", payload: paster.captureTarget(id: id, readContext: readContext))
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
        keyboard.onKey = { [ipc] index, key, down, hidden, name in
            var payload: [String: Any] = ["index": index, "key": key, "down": down, "hidden": hidden]
            if let name { payload["name"] = name }
            ipc?.emit(event: "KeyEvent", payload: payload)
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

    private func setRecording(_ on: Bool) {
        recordingTimer?.cancel()
        recordingTimer = nil
        keyboard.setRecording(on)
        guard on else { return }
        let timer = DispatchWorkItem { [weak self] in
            Log.warn("Shortcut recording timed out")
            self?.keyboard.setRecording(false)
        }
        recordingTimer = timer
        DispatchQueue.main.asyncAfter(deadline: .now() + Helper.recordingTimeout, execute: timer)
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

    // MARK: Memoria

    /// El sistema avisa cuando la memoria escasea; main suelta entonces los
    /// modelos que no está usando. Sin sondeo: es un evento del kernel.
    private func observeMemoryPressure() {
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical], queue: .main)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            let event = source.data
            let level = event.contains(.critical) ? "critical" : event.contains(.warning) ? "warning" : "normal"
            Log.info("Memory pressure: \(level)")
            self.ipc.emit(event: "MemoryPressure", payload: ["level": level])
        }
        source.resume()
        memoryPressure = source
    }

    /// Nivel actual, para el arranque (1 normal, 2 aviso, 4 crítico).
    static func memoryPressureLevel() -> String {
        var level: Int32 = 0
        var size = MemoryLayout<Int32>.size
        guard sysctlbyname("kern.memorystatus_vm_pressure_level", &level, &size, nil, 0) == 0 else { return "normal" }
        return level >= 4 ? "critical" : level >= 2 ? "warning" : "normal"
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

    /// main lo para con SIGTERM; salir por aquí devuelve el sonido.
    private func watchSignals() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { Helper.quit("signal \(sig)") }
            source.resume()
            signalSources.append(source)
        }
    }

    private func startTimers() {
        addTimer(every: 1) { [weak self] in
            guard let self else { return }
            if ProcessInfo.processInfo.systemUptime - self.lastMessageAt > Helper.orphanTimeout {
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
        OutputMute.restore()
        // Dar tiempo a que salga la línea de registro.
        usleep(50_000)
        exit(code)
    }
}
