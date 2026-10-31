import CoreAudio
import Foundation

// Silencio de la salida de audio mientras se dicta. Solo se quita el silencio
// que puso el helper: si la salida ya estaba silenciada, se deja como estaba.
// Si el helper sale con el silencio puesto (main se cierra, se cuelga…), lo
// quita antes de salir.

enum OutputMute {
    /// Dispositivo que se silenció, para devolverle el sonido aunque cambie el de por defecto.
    private static var mutedDevice: AudioObjectID?

    /// Silencia (o devuelve el sonido). Devuelve si cambió algo y, si no, por qué.
    static func set(_ muted: Bool) -> (changed: Bool, detail: String) {
        if !muted {
            guard let device = mutedDevice else { return (false, "not muted by Speech") }
            mutedDevice = nil
            return write(device, false) ? (true, "unmuted") : (false, "could not unmute")
        }
        if mutedDevice != nil { return (false, "already muted by Speech") }
        guard let device = defaultOutput() else { return (false, "no output device") }
        guard let current = read(device) else { return (false, "the output device cannot be muted") }
        if current { return (false, "already muted") }
        guard write(device, true) else { return (false, "could not mute") }
        mutedDevice = device
        return (true, "muted")
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
