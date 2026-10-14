import Foundation

// macOS atribuye los permisos (TCC) al «proceso responsable». Un proceso lanzado
// por otro hereda la responsabilidad de su padre: lanzado por Electron, el
// permiso de Accesibilidad se pediría para Electron; lanzado desde una
// terminal, para la terminal. Para que el permiso sea del helper y de su firma,
// el helper se reejecuta a sí mismo renunciando a esa herencia
// (responsibility_spawnattrs_setdisclaim, la misma técnica de Chromium).
//
// POSIX_SPAWN_SETEXEC sustituye la imagen sin crear un proceso nuevo: el PID y
// los descriptores (stdin y el 3) son los mismos que ve main.

enum Responsibility {
    static let markerVariable = "SPEECH_HELPER_DISCLAIMED"
    /// Solo para pruebas: no renunciar, para heredar los permisos del proceso padre.
    static let skipVariable = "SPEECH_HELPER_NO_DISCLAIM"

    static var isDisclaimed: Bool {
        ProcessInfo.processInfo.environment[markerVariable] == "1"
    }

    /// Vuelve solo si no hace falta o si la reejecución falla.
    static func disclaimByReexecIfNeeded() {
        let env = ProcessInfo.processInfo.environment
        if env[markerVariable] == "1" || env[skipVariable] == "1" { return }

        typealias DisclaimFn = @convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim") else {
            Log.warn("responsibility_spawnattrs_setdisclaim not available; permissions will follow the parent process")
            return
        }
        let disclaim = unsafeBitCast(symbol, to: DisclaimFn.self)

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETEXEC))
        if disclaim(&attr, 1) != 0 {
            Log.warn("Could not set responsibility disclaim")
            return
        }

        var envList = env.map { "\($0.key)=\($0.value)" }
        envList.append("\(markerVariable)=1")
        let path = Bundle.main.executablePath ?? CommandLine.arguments[0]
        let argv: [UnsafeMutablePointer<CChar>?] = CommandLine.arguments.map { strdup($0) } + [nil]
        let envp: [UnsafeMutablePointer<CChar>?] = envList.map { strdup($0) } + [nil]

        var pid: pid_t = 0
        let rc = argv.withUnsafeBufferPointer { a in
            envp.withUnsafeBufferPointer { e in
                posix_spawn(&pid, path, nil, &attr, a.baseAddress, e.baseAddress)
            }
        }
        // Solo se llega aquí si falló.
        Log.warn("Re-exec with responsibility disclaim failed (\(rc)); continuing without it")
    }
}
