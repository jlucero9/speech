<p align="center">
  <img src=".github/assets/icon.png" alt="Speech" width="128" />
</p>

<h1 align="center">Speech</h1>

<p align="center"><strong>AI dictation for macOS. Hold fn, speak, release, and your words are typed wherever your cursor is.</strong></p>

<p align="center">
  <a href="https://github.com/jlucero9/speech/releases/latest"><img src="https://img.shields.io/github/v/release/jlucero9/speech?style=flat&label=release" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/macOS-13%2B%20%C2%B7%20Apple%20Silicon-lightgrey?style=flat&logo=apple" alt="macOS 13+, Apple Silicon" />
  <a href="LICENSE"><img src="https://img.shields.io/github/license/jlucero9/speech?style=flat" alt="MIT license" /></a>
</p>

<p align="center">
  <a href="https://github.com/jlucero9/speech/releases/latest"><b>Download</b></a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#build-from-source">Build from source</a>
</p>

<!-- DEMO: the GIF goes here -->

## Why Speech

- **Fast.** Release the key and the text is already in your app: Mail, Slack, VS Code, the browser, anything.
- **Clean text.** A small language model adds punctuation and capitals and removes the "um"s and "uh"s.
- **Local or cloud.** Whisper runs on your Mac out of the box; switch to Groq or Gemini with your own API key.
- **Yours to tune.** A personal dictionary for names and jargon, a searchable history, and custom shortcuts.
- **Free and open source,** under the MIT license.

## How it works

| Shortcut | What it does |
|---|---|
| Hold <kbd>fn</kbd> | Speak while you hold it. Release to paste. |
| <kbd>fn</kbd> + <kbd>Space</kbd> | Hands-free mode. Tap <kbd>fn</kbd> to finish. |
| <kbd>Esc</kbd> | Cancel. |

1. **Transcription:** Whisper Large v3 Turbo through [whisper.cpp](https://github.com/ggml-org/whisper.cpp), accelerated with Metal.
2. **Cleanup:** [Ollama](https://ollama.com) with `qwen3:1.7b`, also on your Mac.
3. **Optional cloud engines:** Groq or Gemini with your own API key. Off by default; keys are stored in the macOS Keychain.

## Install

**Requirements:** a Mac with Apple Silicon (M1 or later), macOS 13 or newer, and about 700 MB free. The speech model (574 MB) downloads the first time you open the app.

1. Download `Speech-<version>-arm64.dmg` from [Releases](https://github.com/jlucero9/speech/releases/latest) and drag **Speech** to **Applications**.
2. The app is not notarized by Apple, so macOS blocks it the first time. Allow it once, in either of two ways:
   - Open Speech, close the warning, then go to **System Settings › Privacy & Security** and click **Open Anyway**.
   - Or run `xattr -dr com.apple.quarantine /Applications/Speech.app` in Terminal.
3. Grant the permissions it asks for: **Microphone**, to hear you, and **Accessibility**, to detect the shortcut and paste the text.
4. Optional: install [Ollama](https://ollama.com) and run `ollama pull qwen3:1.7b` for punctuation and cleanup. Without it, Speech pastes the raw transcription and tells you so.

> [!TIP]
> If fn opens the emoji picker or switches the keyboard language, go to **System Settings › Keyboard** and set **Press 🌐 key to** **Do Nothing**.

## Your data

- Dictations, history and dictionary are stored only in `~/Library/Application Support/Speech/`. Audio is deleted after 14 days.
- The only network request is the model download, unless you turn on a cloud engine in **Settings › Engines and Keys**.

## Build from source

You need Xcode (or its command line tools), Node.js 22 or newer, and `cmake` (`brew install cmake`).

```sh
npm install
npm run firma:crear           # once: local signing identity, so macOS keeps permissions between builds
npm start                     # build and open the development version
npm run empaquetar -- --dmg   # Speech.app and the .dmg in ~/Library/Developer/Speech/dist/
```

| Folder | What's inside |
|---|---|
| `src/main/` | Electron main process: dictation, transcription, history, database |
| `src/renderer/` | React interface: the floating bar, the history window and settings |
| `helper/` | Swift helper: keyboard shortcut, pasting and permissions |
| `transcriber/` | whisper.cpp with Metal, in C++ |

## License

[MIT](LICENSE). The Figtree and EB Garamond fonts (`src/renderer/assets/fonts/`) are under the SIL Open Font License 1.1.
