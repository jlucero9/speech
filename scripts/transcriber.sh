#!/bin/zsh
# Compila SpeechTranscriber (whisper.cpp con Metal, enlazado estático) en
# ~/Library/Developer/Speech/transcriber/ y lo firma con la identidad estable.
# La primera vez descarga whisper.cpp en la versión fijada y comprueba su commit.
# Uso: npm run transcriber
set -euo pipefail

RAIZ="${0:A:h:h}"
source "$RAIZ/scripts/firma/comun.sh"

WHISPER_VERSION=v1.9.5
WHISPER_COMMIT=d1be6fde11ac6e0407606b4e42fe72d34add8037
WHISPER_REPO=https://github.com/ggml-org/whisper.cpp

FUENTE="$COMPILACION/whisper/src"
OBRA="$COMPILACION/whisper/build"
DESTINO="$COMPILACION/transcriber"

if ! command -v cmake >/dev/null; then
  echo "Falta cmake. Instálalo con: brew install cmake" >&2
  exit 1
fi

if [[ ! -d "$FUENTE/.git" ]] || [[ "$(git -C "$FUENTE" rev-parse HEAD)" != "$WHISPER_COMMIT" ]]; then
  echo "Descargando whisper.cpp $WHISPER_VERSION…"
  rm -rf "$FUENTE"
  git -c advice.detachedHead=false clone -q --depth 1 --branch "$WHISPER_VERSION" "$WHISPER_REPO" "$FUENTE"
  real=$(git -C "$FUENTE" rev-parse HEAD)
  if [[ "$real" != "$WHISPER_COMMIT" ]]; then
    echo "El commit de whisper.cpp $WHISPER_VERSION no es el esperado ($real)" >&2
    rm -rf "$FUENTE"
    exit 1
  fi
fi

# La configuración avisa de detalles de ggml que no afectan; solo se muestra si falla.
if ! salida=$(cmake -S "$RAIZ/transcriber" -B "$OBRA" -DCMAKE_BUILD_TYPE=Release -DWHISPER_SRC="$FUENTE" 2>&1); then
  echo "$salida" >&2
  exit 1
fi
BIN="$OBRA/SpeechTranscriber"
rm -f "$BIN"
if ! salida=$(cmake --build "$OBRA" --target SpeechTranscriber -j "$(sysctl -n hw.ncpu)" 2>&1); then
  echo "$salida" | grep -vE '^\[ *[0-9]+%\]' >&2
  exit 1
fi
echo "$salida" | grep -E 'warning|error' || true
[[ -x "$BIN" ]] || { echo "No se generó $BIN" >&2; exit 1; }

mkdir -p "$DESTINO"
cp "$BIN" "$DESTINO/SpeechTranscriber.tmp"
desbloquear_llavero
firmar "$DESTINO/SpeechTranscriber.tmp" --options runtime --identifier local.speech.transcriber
mv -f "$DESTINO/SpeechTranscriber.tmp" "$DESTINO/SpeechTranscriber"
codesign --verify --strict "$DESTINO/SpeechTranscriber"
echo "Transcriptor listo: $DESTINO/SpeechTranscriber"
