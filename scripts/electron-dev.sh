#!/bin/zsh
# Prepara ~/Library/Developer/Speech/dev/Speech.app: una copia del Electron de
# node_modules con identidad propia (local.speech.dev, nombre «Speech», sin
# icono en el Dock) firmada con la identidad estable.
#
# Por qué: el Electron de npm va firmado «ad hoc», así que el permiso de
# micrófono se perdería con cada actualización; y lanzado desde una terminal,
# macOS atribuiría el permiso a la terminal. Este bundle se abre con `open`
# (scripts/dev.mjs) y es responsable de sí mismo.
#
# Solo se rehace si cambia la versión de Electron. Uso: lo llama npm start.
set -euo pipefail

RAIZ="${0:A:h:h}"
source "$RAIZ/scripts/firma/comun.sh"

ORIGEN="$RAIZ/node_modules/electron/dist/Electron.app"
DESTINO="$COMPILACION/dev/Speech.app"
SELLO="$COMPILACION/dev/sello"
VERSION_ELECTRON=$(node -p "require('$RAIZ/node_modules/electron/package.json').version")
ESPERADO="electron $VERSION_ELECTRON · $IDENTIDAD"

if [[ -d "$DESTINO" && -f "$SELLO" && "$(cat "$SELLO")" == "$ESPERADO" ]] \
  && codesign --verify "$DESTINO" 2>/dev/null; then
  exit 0
fi

[[ -d "$ORIGEN" ]] || node "$RAIZ/node_modules/electron/install.js"

echo "Preparando Electron de desarrollo ($VERSION_ELECTRON)…"
rm -rf "$DESTINO"
mkdir -p "${DESTINO:h}"
# Copia por clonado de APFS: instantánea y sin ocupar espacio extra.
cp -cR "$ORIGEN" "$DESTINO"
# La copia arrastra los atributos extendidos del Escritorio; codesign los rechaza.
xattr -cr "$DESTINO"

PLIST="$DESTINO/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "$1" "$PLIST"; }
pb "Set :CFBundleIdentifier local.speech.dev"
pb "Set :CFBundleName Speech"
pb "Add :CFBundleDisplayName string Speech" 2>/dev/null || pb "Set :CFBundleDisplayName Speech"
pb "Add :LSUIElement bool true" 2>/dev/null || pb "Set :LSUIElement true"
pb "Set :NSMicrophoneUsageDescription Speech uses the microphone to transcribe what you dictate."
# Permisos que Speech no usa: fuera, para que nunca se pidan.
for clave in NSCameraUsageDescription NSBluetoothAlwaysUsageDescription NSBluetoothPeripheralUsageDescription NSAudioCaptureUsageDescription; do
  pb "Delete :$clave" 2>/dev/null || true
done

desbloquear_llavero
# --deep firma también los frameworks y los procesos auxiliares de Electron.
firmar "$DESTINO" --deep --identifier local.speech.dev
codesign --verify --deep --strict "$DESTINO"
echo "$ESPERADO" > "$SELLO"
echo "Electron de desarrollo listo: $DESTINO"
