# Valores compartidos por los scripts de firma. Se carga con `source`.
IDENTIDAD="Speech Local Signing"
LLAVERO="$HOME/Library/Keychains/speech-signing.keychain-db"
SERVICIO_CLAVE="speech.signing-keychain"

# Desbloquea el llavero propio con la contraseña guardada en el de sesión.
desbloquear_llavero() {
  if [[ ! -e "$LLAVERO" ]]; then
    echo "Falta la identidad de firma. Ejecuta antes: npm run firma:crear" >&2
    return 1
  fi
  local clave
  clave=$(security find-generic-password -a "$USER" -s "$SERVICIO_CLAVE" -w)
  security unlock-keychain -p "$clave" "$LLAVERO"
  anadir_a_busqueda
}

# codesign solo encuentra identidades en los llaveros de la lista de búsqueda.
anadir_a_busqueda() {
  local actuales
  actuales=("${(@f)$(security list-keychains -d user | sed -e 's/^ *"//' -e 's/"$//')}")
  if (( ! ${actuales[(Ie)$LLAVERO]} )); then
    security list-keychains -d user -s "${actuales[@]}" "$LLAVERO"
  fi
}

# firmar <ruta> [opciones extra de codesign...]
firmar() {
  local ruta=$1; shift
  codesign --force --sign "$IDENTIDAD" --keychain "$LLAVERO" --timestamp=none "$@" "$ruta"
}

# Productos firmados (helper y Electron de desarrollo). Fuera del Escritorio:
# el file provider de iCloud añade atributos a los bundles recién firmados y
# rompe la verificación de la firma. Ver src/main/paths.ts.
COMPILACION="$HOME/Library/Developer/Speech"
