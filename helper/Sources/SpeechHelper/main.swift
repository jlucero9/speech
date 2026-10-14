import AppKit

let launchedAt = Date()

// Si main muere, escribir en el descriptor 3 no debe matar el helper con
// SIGPIPE: el error se trata como cierre de la conexión.
signal(SIGPIPE, SIG_IGN)

Responsibility.disclaimByReexecIfNeeded()

let app = NSApplication.shared
// Sin Dock ni menús: es un proceso de fondo.
app.setActivationPolicy(.prohibited)

let helper = Helper(launchedAt: launchedAt)
helper.start()
app.run()
