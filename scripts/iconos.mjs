// Genera los iconos: el de la barra de menús (cinco barras redondeadas en
// forma de onda, en negro con transparencia, imagen de plantilla de macOS) y
// el de la app (las mismas barras en claro sobre un cuadrado redondeado
// oscuro, con la rejilla de los iconos de macOS).
// Uso: npm run iconos → resources/trayTemplate.png, trayTemplate@2x.png y speech.icns
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const SIZE_PT = 18;
// Barras en puntos: centro x, alto. Ancho común y extremos redondos.
const BAR_WIDTH = 2;
const BARS = [
  [3, 6],
  [6, 11],
  [9, 15],
  [12, 9],
  [15, 5],
];

function coverage(px, py) {
  // Distancia a una cápsula vertical, en puntos.
  let best = Infinity;
  for (const [cx, h] of BARS) {
    const r = BAR_WIDTH / 2;
    const half = h / 2 - r;
    const cy = SIZE_PT / 2;
    const dy = Math.max(Math.abs(py - cy) - half, 0);
    const d = Math.hypot(px - cx, dy) - r;
    best = Math.min(best, d);
  }
  return best;
}

function render(scale) {
  const n = SIZE_PT * scale;
  const rgba = Buffer.alloc(n * n * 4);
  const SS = 4; // submuestras por eje para suavizar bordes
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / scale;
          const py = (y + (sy + 0.5) / SS) / scale;
          if (coverage(px, py) <= 0) hits++;
        }
      }
      const i = (y * n + x) * 4;
      rgba[i + 3] = Math.round((255 * hits) / (SS * SS));
    }
  }
  return png(n, n, rgba);
}

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Icono de la app, en una rejilla de 1024: cuadrado redondeado de 824 con
// margen de 100 (la de macOS), fondo con un leve degradado y las barras del
// icono de la barra de menús, escaladas y centradas.
const APP = { inset: 100, size: 824, radius: 185 };
const BAR_SCALE = 30; // puntos de la rejilla de 18 → píxeles de 1024
const TOP = [0x2b, 0x2b, 0x29];
const BOTTOM = [0x14, 0x14, 0x13];
const BARS_RGB = [0xfc, 0xfc, 0xfb];

function roundedSquare(x, y) {
  const c = APP.inset + APP.size / 2;
  const half = APP.size / 2 - APP.radius;
  const dx = Math.max(Math.abs(x - c) - half, 0);
  const dy = Math.max(Math.abs(y - c) - half, 0);
  return Math.hypot(dx, dy) - APP.radius;
}

function appIcon(n) {
  const k = 1024 / n;
  const rgba = Buffer.alloc(n * n * 4);
  const SS = 4;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) * k;
          const py = (y + (sy + 0.5) / SS) * k;
          if (roundedSquare(px, py) > 0) continue;
          bg++;
          // A la rejilla del icono de la barra (18 pt), centrada.
          if (coverage(SIZE_PT / 2 + (px - 512) / BAR_SCALE, SIZE_PT / 2 + (py - 512) / BAR_SCALE) <= 0) fg++;
        }
      }
      const i = (y * n + x) * 4;
      const t = y / n;
      const a = fg / bg || 0;
      for (let ch = 0; ch < 3; ch++) {
        const back = TOP[ch] + (BOTTOM[ch] - TOP[ch]) * t;
        rgba[i + ch] = Math.round(back + (BARS_RGB[ch] - back) * a);
      }
      rgba[i + 3] = Math.round((255 * bg) / (SS * SS));
    }
  }
  return png(n, n, rgba);
}

const dir = join(import.meta.dirname, '..', 'resources');
writeFileSync(join(dir, 'trayTemplate.png'), render(1));
writeFileSync(join(dir, 'trayTemplate@2x.png'), render(2));
const iconset = join(mkdtempSync(join(tmpdir(), 'speech-icon-')), 'speech.iconset');
execFileSync('mkdir', ['-p', iconset]);
for (const pt of [16, 32, 128, 256, 512]) {
  writeFileSync(join(iconset, `icon_${pt}x${pt}.png`), appIcon(pt));
  writeFileSync(join(iconset, `icon_${pt}x${pt}@2x.png`), appIcon(pt * 2));
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(dir, 'speech.icns')]);
rmSync(join(iconset, '..'), { recursive: true, force: true });
console.log('resources/trayTemplate.png, resources/trayTemplate@2x.png, resources/speech.icns');
