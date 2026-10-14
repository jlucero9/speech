import AppKit
import ApplicationServices

// Ciclo de vida y mensajes del helper. Todo corre en la cola principal.
//
// Se cierra solo si:
// - stdin llega a EOF (main cerró la tubería o murió);
// - su proceso padre termina;
// - pasan 15 s sin ningún mensaje de main.

final class Helper {
    static let protocolVersion = 1
    private static let orphanTimeout: TimeInterval = 15
    private static let accessibilityPollInterval: TimeInterval = 2

    private let launchedAt: Date
    private var ipc: IPC!
    private var lastMessageAt = Date()
    private var accessibilityTrusted = AXIsProcessTrusted()
    private var timers: [DispatchSourceTimer] = []
    private var parentWatcher: DispatchSourceProcess?
    private var activity: NSObjectProtocol?

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
        watchParent()
        startTimers()
        observeAccessibilityChanges()
        Log.info("Helper started: pid \(getpid()), responsibility disclaimed: \(Responsibility.isDisclaimed), accessibility: \(accessibilityTrusted)")
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
            ])
        case "GetAccessibilityStatus":
            ipc.respond(to: request.id, type: "AccessibilityStatus", payload: ["trusted": checkAccessibility()])
        case "RequestAccessibilityPermission":
            // Muestra el diálogo del sistema si no hay permiso.
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            let trusted = AXIsProcessTrustedWithOptions(options)
            Log.info("Requested accessibility permission; trusted: \(trusted)")
            ipc.respond(to: request.id, type: "AccessibilityStatus", payload: ["trusted": trusted])
        default:
            Log.warn("Unknown request type \(request.type)")
            ipc.respond(to: request.id, type: "Error", payload: ["message": "Unknown request type \(request.type)"])
        }
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
        }
    }

    private func addTimer(every interval: TimeInterval, _ handler: @escaping () -> Void) {
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(100))
        timer.setEventHandler(handler: handler)
        timer.resume()
        timers.append(timer)
    }

    static func quit(_ reason: String) -> Never {
        Log.info("Helper exiting: \(reason)")
        // Dar tiempo a que salga la línea de registro.
        usleep(50_000)
        exit(0)
    }
}
