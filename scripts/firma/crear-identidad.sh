#!/bin/zsh
# Crea, una sola vez, la identidad de firma estable con la que se firman el
# helper y el Electron de desarrollo. macOS liga el permiso de Accesibilidad
# (y el de micrófono) a esta firma: mientras no cambie, el permiso se conserva
# entre compilaciones.
#
# - Certificado autofirmado «Speech Local Signing», válido 20 años.
# - Vive en un llavero propio (~/Library/Keychains/speech-signing.keychain-db)
#   para que firmar no dispare diálogos del llavero de sesión.
# - La contraseña de ese llavero es aleatoria y se guarda en el llavero de
#   sesión (servicio «speech.signing-keychain»). No se escribe en el proyecto.
#
# Quien tenga la clave privada puede firmar código que herede los permisos
# concedidos a Speech: no la exportes ni la copies.
set -euo pipefail

source "${0:A:h}/comun.sh"

if security find-certificate -c "$IDENTIDAD" "$LLAVERO" >/dev/null 2>&1; then
  echo "La identidad «$IDENTIDAD» ya existe en $LLAVERO. No se toca."
  exit 0
fi

if [[ -e "$LLAVERO" ]]; then
  echo "Existe $LLAVERO pero no contiene «$IDENTIDAD». Revísalo a mano antes de seguir." >&2
  exit 1
fi

TMP=$(mktemp -d)
chmod 700 "$TMP"
TERMINADO=0
limpiar() {
  rm -rf "$TMP"
  if (( ! TERMINADO )); then
    # Si algo falla a medias, no dejar un llavero sin identidad.
    security delete-keychain "$LLAVERO" 2>/dev/null || true
    security delete-generic-password -a "$USER" -s "$SERVICIO_CLAVE" >/dev/null 2>&1 || true
  fi
}
trap limpiar EXIT

CLAVE_LLAVERO=$(openssl rand -hex 24)
CLAVE_P12=$(openssl rand -hex 24)

# Contraseña del llavero propio, guardada en el llavero de sesión.
security add-generic-password -U -a "$USER" -s "$SERVICIO_CLAVE" -w "$CLAVE_LLAVERO" \
  -l "Speech: llavero de firma de desarrollo"

security create-keychain -p "$CLAVE_LLAVERO" "$LLAVERO"
# Sin bloqueo automático: se desbloquea en cada compilación de todos modos.
security set-keychain-settings "$LLAVERO"

cat > "$TMP/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTIDAD
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 7300 \
  -config "$TMP/cert.cnf" -keyout "$TMP/clave.pem" -out "$TMP/cert.pem" 2>/dev/null
openssl pkcs12 -export -inkey "$TMP/clave.pem" -in "$TMP/cert.pem" \
  -name "$IDENTIDAD" -out "$TMP/identidad.p12" -passout "pass:$CLAVE_P12" \
  -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES

security import "$TMP/identidad.p12" -k "$LLAVERO" -P "$CLAVE_P12" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$CLAVE_LLAVERO" "$LLAVERO" >/dev/null

anadir_a_busqueda
TERMINADO=1
echo "Identidad creada: «$IDENTIDAD»"
security find-certificate -c "$IDENTIDAD" -Z "$LLAVERO" | grep SHA-1
