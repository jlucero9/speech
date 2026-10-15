// Procesador de audio: agrupa las muestras del canal 0 en trozos de 640
// (40 ms a 16 kHz), los pasa a PCM de 16 bits con signo y los envía al hilo
// de la página con su volumen en dBFS. Con el mensaje 'flush' envía lo que
// quede, responde 'done' y deja de procesar.
// JavaScript plano: se carga tal cual con audioWorklet.addModule.

const CHUNK = 640;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK);
    this.length = 0;
    this.finished = false;
    this.port.onmessage = (e) => {
      if (e.data === 'flush' && !this.finished) {
        if (this.length > 0) this.emit();
        this.finished = true;
        this.port.postMessage({ done: true });
      }
    };
  }

  process(inputs) {
    if (this.finished) return false;
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let i = 0;
    while (i < channel.length) {
      const n = Math.min(CHUNK - this.length, channel.length - i);
      this.buffer.set(channel.subarray(i, i + n), this.length);
      this.length += n;
      i += n;
      if (this.length === CHUNK) this.emit();
    }
    return true;
  }

  emit() {
    const n = this.length;
    const pcm = new Int16Array(n);
    let sum = 0;
    let zero = true;
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, this.buffer[i]));
      if (s !== 0) zero = false;
      sum += s * s;
      pcm[i] = s < 0 ? s * 32768 : s * 32767;
    }
    const volume = 20 * Math.log10(Math.sqrt(sum / n) + 1e-10);
    this.port.postMessage({ pcm: pcm.buffer, volume, zero }, [pcm.buffer]);
    this.length = 0;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
