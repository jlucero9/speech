// Cabecera WAV (RIFF, PCM lineal) de 44 bytes delante de las muestras.

export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;
/** Bytes de audio por milisegundo a 16 kHz, mono, 16 bits. */
export const BYTES_PER_MS = (SAMPLE_RATE * BYTES_PER_SAMPLE) / 1000;

export function wavFile(pcm: Buffer, sampleRate = SAMPLE_RATE, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // tamaño del bloque fmt
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(BYTES_PER_SAMPLE * 8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
