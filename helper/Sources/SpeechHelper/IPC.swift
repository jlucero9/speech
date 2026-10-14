import Foundation

// Transporte con main (contrato en src/shared/helper-protocol.ts):
// entrada por stdin, salida por el descriptor 3, un objeto JSON por línea.
// stdout y stderr son solo registro.

enum Log {
    private static let queue = DispatchQueue(label: "speech.helper.log")

    static func info(_ message: String) { write("INFO", message) }
    static func warn(_ message: String) { write("WARN", message) }
    static func error(_ message: String) { write("ERROR", message) }

    private static func write(_ level: String, _ message: String) {
        queue.async {
            FileHandle.standardError.write(Data("\(level) \(message)\n".utf8))
        }
    }
}

struct IncomingRequest {
    let id: String
    let type: String
    let payload: [String: Any]
}

final class IPC {
    static let maxLineBytes = 1024 * 1024

    private let output: FileHandle
    private let writeQueue = DispatchQueue(label: "speech.helper.ipc.write")
    private let onRequest: (IncomingRequest) -> Void
    private let onClose: () -> Void

    init(onRequest: @escaping (IncomingRequest) -> Void, onClose: @escaping () -> Void) {
        self.output = FileHandle(fileDescriptor: 3, closeOnDealloc: false)
        self.onRequest = onRequest
        self.onClose = onClose
    }

    /// Lee stdin en un hilo propio y entrega cada petición en la cola principal.
    func startReading() {
        let thread = Thread { [weak self] in self?.readLoop() }
        thread.name = "speech.helper.ipc.read"
        thread.start()
    }

    func respond(to id: String, type: String, payload: [String: Any] = [:]) {
        send(["kind": "response", "id": id, "type": type, "payload": payload])
    }

    func emit(event type: String, payload: [String: Any] = [:]) {
        send(["kind": "event", "type": type, "payload": payload])
    }

    private func send(_ message: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: message) else {
            Log.error("Failed to serialize message \(message["type"] ?? "?")")
            return
        }
        data.append(0x0A)
        writeQueue.async { [output, onClose] in
            do {
                try output.write(contentsOf: data)
            } catch {
                // main ya no escucha: no tiene sentido seguir.
                Log.error("Write to main failed: \(error)")
                DispatchQueue.main.async { onClose() }
            }
        }
    }

    private func readLoop() {
        let input = FileHandle.standardInput
        var buffer = Data()
        while true {
            let chunk = input.availableData
            if chunk.isEmpty {
                // EOF: main cerró la tubería o murió.
                DispatchQueue.main.async { [onClose] in onClose() }
                return
            }
            buffer.append(chunk)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                handle(line: line)
            }
            if buffer.count > IPC.maxLineBytes {
                Log.error("Discarding oversized message (\(buffer.count) bytes)")
                buffer.removeAll()
            }
        }
    }

    private func handle(line: Data) {
        guard !line.isEmpty else { return }
        guard
            let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            object["kind"] as? String == "request",
            let id = object["id"] as? String,
            let type = object["type"] as? String
        else {
            Log.warn("Ignoring malformed message: \(String(decoding: line.prefix(200), as: UTF8.self))")
            return
        }
        let request = IncomingRequest(id: id, type: type, payload: object["payload"] as? [String: Any] ?? [:])
        DispatchQueue.main.async { [onRequest] in onRequest(request) }
    }
}
