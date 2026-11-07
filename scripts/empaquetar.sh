#!/bin/zsh
# Empaqueta Speech.app para abrirla sin terminal, en ~/Library/Developer/Speech/dist/.
# Con --instalar, además la copia a /Applications (sustituyendo la anterior).
#
# Lleva dentro el código compilado (out/, package.json y resources/), el helper
# y el transcriptor tal como los firman sus scripts, y Electron con el nombre
# de la app. Se firma con la identidad estable; no se notariza (uso local).
#
# Fusibles de Electron: se apagan RunAsNode, NODE_OPTIONS y los argumentos de
# inspección. Las claves del llavero quedan ligadas a la firma de Speech: con
# ellos encendidos, cualquier programa podría ejecutar este binario como Node
# (o abrirle un inspector) y leerlas como si fuera Speech.
#
# Uso: npm run empaquetar [-- --instalar]
set -euo pipefail

RAIZ="${0:A:h:h}"
source "$RAIZ/scripts/firma/comun.sh"

NOMBRE=Speech
ID=local.speech
VERSION=$(node -p "require('$RAIZ/package.json').version")
ORIGEN="$RAIZ/node_modules/electron/dist/Electron.app"
DESTINO="$COMPILACION/dist/$NOMBRE.app"
C="$DESTINO/Contents"
INSTALADA="/Applications/$NOMBRE.app"

node "$RAIZ/scripts/build.mjs"
"$RAIZ/scripts/helper.sh"
"$RAIZ/scripts/transcriber.sh"
[[ -f "$RAIZ/resources/speech.icns" ]] || node "$RAIZ/scripts/iconos.mjs"
[[ -d "$ORIGEN" ]] || node "$RAIZ/node_modules/electron/install.js"

echo "Montando $DESTINO…"
rm -rf "$DESTINO"
mkdir -p "${DESTINO:h}"
cp -cR "$ORIGEN" "$DESTINO"
xattr -cr "$DESTINO"

pb() { /usr/libexec/PlistBuddy -c "$2" "$1"; }
pon() { pb "$1" "Set :$2 $3" 2>/dev/null || pb "$1" "Add :$2 string $3"; }

# Ejecutable principal y procesos auxiliares con el nombre de la app. Electron
# busca los auxiliares por el nombre del ejecutable, y `app.isPackaged` es
# verdadero cuando no se llama «Electron».
mv "$C/MacOS/Electron" "$C/MacOS/$NOMBRE"
for sufijo in "" " (Renderer)" " (GPU)" " (Plugin)"; do
  viejo="$C/Frameworks/Electron Helper$sufijo.app"
  [[ -d "$viejo" ]] || continue
  nuevo="$C/Frameworks/$NOMBRE Helper$sufijo.app"
  mv "$viejo" "$nuevo"
  mv "$nuevo/Contents/MacOS/Electron Helper$sufijo" "$nuevo/Contents/MacOS/$NOMBRE Helper$sufijo"
  # No «local.speech.helper»: es el del helper de Swift, al que macOS liga el
  # permiso de Accesibilidad.
  tipo=${${sufijo//[() ]/}:l}
  plist="$nuevo/Contents/Info.plist"
  pon "$plist" CFBundleExecutable "$NOMBRE Helper$sufijo"
  pon "$plist" CFBundleName "$NOMBRE Helper$sufijo"
  pon "$plist" CFBundleDisplayName "$NOMBRE Helper$sufijo"
  pon "$plist" CFBundleIdentifier "$ID.electron${tipo:+.$tipo}"
done

PLIST="$C/Info.plist"
pon "$PLIST" CFBundleExecutable "$NOMBRE"
pon "$PLIST" CFBundleIdentifier "$ID"
pon "$PLIST" CFBundleName "$NOMBRE"
pon "$PLIST" CFBundleDisplayName "$NOMBRE"
pon "$PLIST" CFBundleShortVersionString "$VERSION"
pon "$PLIST" CFBundleVersion "$VERSION"
pon "$PLIST" CFBundleIconFile speech.icns
pon "$PLIST" LSApplicationCategoryType public.app-category.productivity
pon "$PLIST" NSMicrophoneUsageDescription "Speech uses the microphone to transcribe what you dictate."
pb "$PLIST" "Delete :LSUIElement" 2>/dev/null || true
pb "$PLIST" "Add :LSUIElement bool true"
# Permisos que Speech no usa: fuera, para que nunca se pidan.
for clave in NSCameraUsageDescription NSBluetoothAlwaysUsageDescription NSBluetoothPeripheralUsageDescription NSAudioCaptureUsageDescription; do
  pb "$PLIST" "Delete :$clave" 2>/dev/null || true
done

# Recursos: el código de la app en lugar de la app por defecto de Electron.
R="$C/Resources"
rm -f "$R/default_app.asar" "$R/electron.icns"
cp "$RAIZ/resources/speech.icns" "$R/speech.icns"
mkdir -p "$R/app"
cp -R "$RAIZ/out" "$RAIZ/package.json" "$RAIZ/resources" "$R/app/"
find "$R/app/out" -name '*.map' -delete
# Productos ya firmados por sus scripts: se copian con su firma.
ditto "$COMPILACION/helper/SpeechHelper.app" "$R/SpeechHelper.app"
ditto "$COMPILACION/transcriber/SpeechTranscriber" "$R/SpeechTranscriber"

# Fusibles (antes de firmar: cambian el binario del framework).
node - "$C/Frameworks/Electron Framework.framework/Versions/A/Electron Framework" <<'EOF'
const fs = require('node:fs');
const file = process.argv[2];
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
// Posiciones en la versión 1 del cableado: 0 RunAsNode, 2 NODE_OPTIONS, 3 --inspect.
const OFF = { 0: 'RunAsNode', 2: 'EnableNodeOptionsEnvironmentVariable', 3: 'EnableNodeCliInspectArguments' };
const buf = fs.readFileSync(file);
const at = buf.indexOf(SENTINEL);
if (at < 0 || buf.indexOf(SENTINEL, at + 1) >= 0) throw new Error('Fuse wire not found exactly once');
const version = buf[at + SENTINEL.length];
const count = buf[at + SENTINEL.length + 1];
if (version !== 1 || count < 4) throw new Error(`Unexpected fuse wire v${version} with ${count} fuses`);
const start = at + SENTINEL.length + 2;
for (const [i, name] of Object.entries(OFF)) {
  const c = String.fromCharCode(buf[start + Number(i)]);
  if (c !== '0' && c !== '1') throw new Error(`Fuse ${name} has unexpected value ${c}`);
  buf[start + Number(i)] = 0x30;
}
fs.writeFileSync(file, buf);
console.log(`Fusibles: ${buf.subarray(start, start + count).toString()} (${Object.values(OFF).join(', ')} apagados)`);
EOF

# Firma, de dentro afuera. El helper y el transcriptor ya van firmados.
desbloquear_llavero
for f in "$R/app/out/native/"*.node; do firmar "$f"; done
for fw in "$C/Frameworks/"*.framework; do firmar "$fw" --deep; done
for app in "$C/Frameworks/"*.app; do firmar "$app"; done
firmar "$DESTINO" --identifier "$ID"
codesign --verify --deep --strict "$DESTINO"
echo "Firma: $(codesign -dr- "$DESTINO" 2>&1 | grep designated)"

if [[ " $* " == *" --instalar "* ]]; then
  if pgrep -f "^$INSTALADA/Contents/MacOS/$NOMBRE" >/dev/null; then
    echo "Speech está abierta desde /Applications: ciérrala antes de instalar." >&2
    exit 1
  fi
  rm -rf "$INSTALADA"
  ditto "$DESTINO" "$INSTALADA"
  codesign --verify --deep --strict "$INSTALADA"
  echo "Instalada: $INSTALADA"
else
  echo "Lista: $DESTINO (npm run empaquetar -- --instalar la copia a /Applications)"
fi
