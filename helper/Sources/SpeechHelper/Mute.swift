import CoreAudio
import Foundation

// Silencio de la salida de audio mientras se dicta. Solo se quita el silencio
// que puso el helper: si la salida ya estaba silenciada, se deja como estaba.
// Si el helper sale con el silencio puesto (main se cierra, se cuelga…), lo
// quita antes de salir.
//
// Si muere sin poder hacerlo (SIGKILL, un cuelgue que main corta), la marca
// en disco dice qué dispositivo quedó silenciado: el helper relanzado, o el
// mismo ejecutable con --restore-output-mute, le devuelve el sonido.

enum OutputMute {
    /// Dispositivo que se silenció, para devolverle el sonido aunque cambie el de por defecto.
    private static var mutedDevice: AudioObjectID?

    /// Fichero de la marca, en la carpeta de datos de la app (la pasa main).
    private static var markerURL: URL? {
        guard let dir = ProcessInfo.processInfo.environment["SPEECH_DATA_DIR"], !dir.isEmpty else { return nil }
        return URL(fileURLWithPath: dir).appendingPathComponent("output-muted.json")
    }

    /// Silencia (o devuelve el sonido). Devuelve si cambió algo y, si no, por qué.
    static func set(_ muted: Bool) -> (changed: Bool, detail: String) {
        if !muted {
            guard let device = mutedDevice else { return (false, "not muted by Speech") }
            mutedDevice = nil
            let ok = write(device, false)
            if ok { removeMarker() }
            return ok ? (true, "unmuted") : (false, "could not unmute")
        }
        if mutedDevice != nil { return (false, "already muted by Speech") }
        guard let device = defaultOutput() else { return (false, "no output device") }
        guard let current = read(device) else { return (false, "the output device cannot be muted") }
        if current { return (false, "already muted") }
        // La marca va antes del silencio: si el helper muere entre los dos, sobra
        // una marca (y al recuperarla no se toca una salida que no está silenciada).
        writeMarker(device)
        guard write(device, true) else {
            removeMarker()
            return (false, "could not mute")
        }
        mutedDevice = device
        return (true, "muted")
    }

    /// Al arrancar: si un helper anterior murió con la salida silenciada, le devuelve el sonido.
    static func recoverFromMarker() {
        guard let url = markerURL, let data = try? Data(contentsOf: url) else { return }
        defer { removeMarker() }
        guard let info = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let uid = info["uid"] as? String else {
            Log.warn("Output mute marker unreadable; removed")
            return
        }
        guard let device = deviceWithUID(uid) else {
            Log.info("Output mute marker: device \(uid) is not connected; nothing to restore")
            return
        }
        guard read(device) == true else {
            Log.info("Output mute marker: \(uid) is not muted; nothing to restore")
            return
        }
        Log.info("Output mute marker: a previous helper left \(uid) muted; \(write(device, false) ? "unmuted" : "could not unmute")")
    }

    /// Al salir: devuelve el sonido si lo quitó el helper.
    static func restore() {
        if mutedDevice != nil {
            let r = set(false)
            Log.info("Output mute on exit: \(r.detail)")
        }
    }

    private static func defaultOutput() -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var device = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        return status == noErr && device != 0 ? device : nil
    }

    private static func writeMarker(_ device: AudioObjectID) {
        guard let url = markerURL, let uid = deviceUID(device) else { return }
        let info: [String: Any] = ["uid": uid, "at": Int(Date().timeIntervalSince1970 * 1000)]
        guard let data = try? JSONSerialization.data(withJSONObject: info) else { return }
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            Log.warn("Could not write the output mute marker: \(error.localizedDescription)")
        }
    }

    private static func removeMarker() {
        guard let url = markerURL else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// El UID dura entre reinicios del equipo; el AudioObjectID, no.
    private static func deviceUID(_ device: AudioObjectID) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uid: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &uid)
        guard status == noErr, let uid else { return nil }
        return uid.takeRetainedValue() as String
    }

    private static func deviceWithUID(_ uid: String) -> AudioObjectID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslateUIDToDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var cfUID = uid as CFString
        var device = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = withUnsafeMutablePointer(to: &cfUID) { ptr in
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &address,
                UInt32(MemoryLayout<CFString>.size), ptr, &size, &device
            )
        }
        return status == noErr && device != 0 ? device : nil
    }

    private static func muteAddress() -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyMute,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
    }

    private static func read(_ device: AudioObjectID) -> Bool? {
        var address = muteAddress()
        guard AudioObjectHasProperty(device, &address) else { return nil }
        var value = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value)
        return status == noErr ? value != 0 : nil
    }

    private static func write(_ device: AudioObjectID, _ muted: Bool) -> Bool {
        var address = muteAddress()
        var settable = DarwinBoolean(false)
        guard AudioObjectIsPropertySettable(device, &address, &settable) == noErr, settable.boolValue else { return false }
        var value = UInt32(muted ? 1 : 0)
        let status = AudioObjectSetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &value)
        if status != noErr { Log.warn("Setting output mute failed: \(status)") }
        return status == noErr
    }
}
