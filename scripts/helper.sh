#!/bin/zsh
# Compila el helper Swift, monta SpeechHelper.app en ~/Library/Developer/Speech/helper/ y lo firma con
# la identidad estable. Uso: npm run helper
set -euo pipefail

RAIZ="${0:A:h:h}"
source "$RAIZ/scripts/firma/comun.sh"

VERSION=$(node -p "require('$RAIZ/package.json').version")
APP="$COMPILACION/helper/SpeechHelper.app"
SWIFT=(swift build --package-path "$RAIZ/helper" --scratch-path "$COMPILACION/swift" -c release --arch arm64)

"${SWIFT[@]}" 2>&1 | grep -vE '^(Building|Build complete|\[)' || true
BIN="$("${SWIFT[@]}" --show-bin-path)/SpeechHelper"
[[ -x "$BIN" ]] || { echo "No se generó $BIN" >&2; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/SpeechHelper"
sed "s/__VERSION__/$VERSION/g" "$RAIZ/helper/Resources/Info.plist" > "$APP/Contents/Info.plist"

desbloquear_llavero
firmar "$APP" --options runtime --identifier local.speech.helper
codesign --verify --strict "$APP"
echo "Helper listo: $APP"
codesign -dr- "$APP" 2>&1 | grep designated
