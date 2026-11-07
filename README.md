# Speech

Dictado para macOS. Mantienes pulsada **fn**, hablas, sueltas, y el texto aparece donde esté el cursor, en cualquier app. La transcripción (Whisper) y la limpieza del texto (un modelo pequeño en Ollama) se hacen en tu Mac: por defecto, nada de lo que dictas sale del equipo.

Es un proyecto personal en desarrollo (versión 0.1). Funciona a diario en un MacBook Air M1 de 8 GB, pero no está pulido para cualquier usuario.

## Requisitos

- **Mac con Apple Silicon** (M1 o posterior) y **macOS 13** o más reciente. No funciona en Macs con Intel, Windows ni Linux.
- Unos **700 MB libres**: la app y el modelo de transcripción, que se descarga solo la primera vez (574 MB, de Hugging Face).
- **Opcional, [Ollama](https://ollama.com)** con el modelo `qwen3:1.7b` (`ollama pull qwen3:1.7b`) para que el texto salga con puntuación y sin muletillas. Sin Ollama, Speech pega la transcripción tal cual y lo avisa.

## Instalar

1. Descarga `Speech-<versión>-arm64.dmg` de la página de [Releases](../../releases), ábrelo y arrastra **Speech** a **Aplicaciones**.
2. **La app no está verificada por Apple** (no tiene firma de desarrollador de pago), así que macOS no la deja abrir a la primera. Dos formas de permitirlo, una sola vez:
   - **Desde Ajustes:** abre Speech, cierra el aviso, ve a **Ajustes del Sistema › Privacidad y seguridad** y, abajo, pulsa **«Abrir igualmente»** junto a Speech. Confirma con tu contraseña.
   - **Desde Terminal:** `xattr -dr com.apple.quarantine /Applications/Speech.app` y ábrela normalmente.

   Si después de permitirlo no aparece el icono de Speech en la barra de menús, usa la opción de Terminal: quita la marca de descarga también a las piezas internas de la app.
3. Concede los permisos que pide:
   - **Micrófono**, para oírte.
   - **Accesibilidad** (Ajustes del Sistema › Privacidad y seguridad › Accesibilidad), para detectar el atajo y pegar el texto. Aparece como «Speech».
4. Espera a que termine la descarga del modelo (se ve en el menú del icono y en Settings).

## Usar

- **Mantén fn** mientras hablas y suelta: se pega el texto en la app activa.
- **fn + espacio**: manos libres; un toque de fn termina.
- **Esc** cancela.
- El icono de la barra de menús abre el historial (Open Speech), pega el último dictado y cambia micrófono e idioma. Los atajos se cambian en Settings › Shortcuts.

Si fn abre el selector de emojis o cambia de idioma de teclado, en Ajustes del Sistema › Teclado pon «Al pulsar la tecla 🌐» en «No hacer nada».

## Privacidad

- Los dictados, el historial y el diccionario se guardan solo en `~/Library/Application Support/Speech/`. El audio se borra a los 14 días.
- Sin conexiones fuera del equipo salvo la descarga del modelo. Puedes activar motores en la nube (Gemini, Groq) en Settings › Engines and Keys con tu propia clave; están apagados por defecto y las claves se guardan en el llavero de macOS.

## Compilar desde el código

Necesitas Xcode (o sus herramientas de línea de comandos), Node.js 22 o más reciente y `cmake` (`brew install cmake`).

```sh
npm install
npm run firma:crear   # una vez: identidad de firma local, para que macOS conserve los permisos entre compilaciones
npm start             # compila y abre la versión de desarrollo
npm run empaquetar -- --dmg   # Speech.app y el .dmg en ~/Library/Developer/Speech/dist/
```

`npm run typecheck` comprueba los tipos. La estructura del código: `src/main/` (proceso principal de Electron), `src/renderer/` (interfaz en React), `helper/` (proceso en Swift: teclado, pegado y permisos), `transcriber/` (whisper.cpp con Metal).

## Licencia

Sin licencia por ahora: el código se puede leer, pero no reutilizar. Las fuentes Figtree y EB Garamond (`src/renderer/assets/fonts/`) tienen licencia SIL Open Font License 1.1.
