// SpeechTranscriber: transcribe ficheros WAV con whisper.cpp.
//
// Proceso hijo de main. Habla por stdin/stdout con un JSON por línea (contrato
// en src/main/transcription/transcriber-protocol.ts). El modelo se carga con
// «load» y vive lo que vive el proceso: para liberar la memoria, main cierra
// stdin o mata el proceso. Así nada queda retenido por el sistema de memoria de
// Metal ni por la biblioteca.
//
// Un hilo lee stdin; el principal ejecuta las órdenes de una en una. «cancel»
// se atiende en el hilo lector para poder cortar una transcripción en curso.

#include <mach/mach.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <fstream>
#include <iostream>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "json.hpp"
#include "whisper.h"

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

namespace {

constexpr int PROTOCOL_VERSION = 1;
constexpr int SAMPLE_RATE = 16000;
constexpr double TRIM_MARGIN_S = 1.0;
// La ventana recortada va en múltiplos de 256 posiciones (unos 5 s). Con flash
// attention, el decodificador lee la caché de la atención cruzada redondeada a
// 256 y sin máscara, pero el codificador solo escribe las posiciones de la
// ventana: lo que sobra conservaría lo del dictado anterior y se colaría en el
// texto (frases de un dictado apareciendo en el siguiente).
constexpr int TRIM_CTX_STEP = 256;
// Tope de tokens por segmento con la ventana recortada, según la duración del
// audio. En algunas frases cortas el decodificador no cierra el segmento y
// sigue generando hasta su límite (~220 pasos por cada haz): 2 s perdidos para
// un texto que ya estaba completo. Nadie dice más de 8 tokens por segundo; al
// llegar al tope whisper fuerza una marca de tiempo y el texto no se pierde.
constexpr double TRIM_MAX_TOKENS_PER_S = 8.0;
constexpr int TRIM_MAX_TOKENS_BASE = 16;

std::mutex out_mutex;

void emit(const json &msg) {
  std::lock_guard<std::mutex> lock(out_mutex);
  std::string line = msg.dump(-1, ' ', false, json::error_handler_t::replace);
  line.push_back('\n');
  fwrite(line.data(), 1, line.size(), stdout);
  fflush(stdout);
}

void emit_error(const std::string &id, const std::string &code, const std::string &message) {
  emit({{"type", "error"}, {"id", id}, {"code", code}, {"message", message}});
}

double ms_since(Clock::time_point t0) {
  return std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
}

/** Memoria del proceso según macOS (la que muestra el Monitor de Actividad). */
json memory() {
  task_vm_info_data_t info{};
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  if (task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&info), &count) != KERN_SUCCESS) {
    return nullptr;
  }
  json m = {{"footprint", info.phys_footprint}, {"resident", info.resident_size}};
  if (count >= TASK_VM_INFO_REV2_COUNT) m["peak"] = info.ledger_phys_footprint_peak;
  return m;
}

// Registro de whisper.cpp y ggml: solo avisos y errores, por stderr (main los
// copia a su registro). La carga del modelo escribe decenas de líneas de
// información que no aportan.
void on_log(ggml_log_level level, const char *text, void *) {
  if (level == GGML_LOG_LEVEL_WARN || level == GGML_LOG_LEVEL_ERROR) {
    fputs(text, stderr);
  }
}

// MARK: WAV

/** Lee un WAV PCM de 16 bits a 16 kHz (mono o estéreo) como float en [-1, 1]. */
bool read_wav(const std::string &path, std::vector<float> &out, std::string &error) {
  std::ifstream f(path, std::ios::binary);
  if (!f) {
    error = "cannot open " + path;
    return false;
  }
  std::vector<char> data((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
  auto u16 = [&](size_t at) { return uint16_t(uint8_t(data[at]) | uint8_t(data[at + 1]) << 8); };
  auto u32 = [&](size_t at) { return uint32_t(u16(at)) | uint32_t(u16(at + 2)) << 16; };
  if (data.size() < 12 || memcmp(data.data(), "RIFF", 4) != 0 || memcmp(data.data() + 8, "WAVE", 4) != 0) {
    error = "not a WAV file";
    return false;
  }
  uint16_t format = 0, channels = 0, bits = 0;
  uint32_t rate = 0;
  size_t pos = 12;
  while (pos + 8 <= data.size()) {
    uint32_t size = u32(pos + 4);
    size_t body = pos + 8;
    if (memcmp(data.data() + pos, "fmt ", 4) == 0 && size >= 16 && body + 16 <= data.size()) {
      format = u16(body);
      channels = u16(body + 2);
      rate = u32(body + 4);
      bits = u16(body + 14);
    } else if (memcmp(data.data() + pos, "data", 4) == 0) {
      if (format != 1 || bits != 16 || rate != SAMPLE_RATE || channels < 1 || channels > 2) {
        error = "unsupported WAV format (need 16-bit PCM at 16 kHz)";
        return false;
      }
      size_t end = std::min(data.size(), body + size_t(size));
      size_t frames = (end - body) / (2 * channels);
      out.resize(frames);
      for (size_t i = 0; i < frames; i++) {
        float sum = 0;
        for (uint16_t c = 0; c < channels; c++) {
          sum += float(int16_t(u16(body + (i * channels + c) * 2))) / 32768.0f;
        }
        out[i] = sum / channels;
      }
      return true;
    }
    pos = body + size + (size & 1);
  }
  error = "WAV file has no audio data";
  return false;
}

/**
 * Un bloque de 4 palabras o más seguido de sí mismo («a b c d a b c d»). Es la
 * forma en que el modelo repite; en un dictado real casi no ocurre, y si
 * ocurre solo cuesta una segunda pasada.
 */
bool has_loop(const std::string &text) {
  std::vector<std::string> words;
  std::istringstream in(text);
  for (std::string w; in >> w;) words.push_back(w);
  const size_t n = words.size();
  for (size_t w = 4; w * 2 <= n; w++) {
    for (size_t i = 0; i + 2 * w <= n; i++) {
      if (std::equal(words.begin() + i, words.begin() + i + w, words.begin() + i + w)) return true;
    }
  }
  return false;
}

// MARK: Órdenes

struct Worker {
  whisper_context *ctx = nullptr;
  std::string model_path;
  int threads = 4;

  std::mutex mutex;
  std::condition_variable cv;
  std::deque<json> queue;
  bool input_closed = false;

  std::mutex current_mutex;
  std::string current_id;
  /** Cancelados antes de empezar. */
  std::set<std::string> cancelled_ids;
  std::atomic<bool> cancel{false};

  void load(const json &cmd) {
    std::string id = cmd.value("id", "");
    std::string path = cmd.value("model", "");
    if (ctx) {
      if (path == model_path) {
        emit({{"type", "loaded"}, {"id", id}, {"ms", 0}, {"memory", memory()}});
      } else {
        // Un modelo por proceso: para cambiarlo, main abre otro proceso.
        emit_error(id, "bad_request", "a different model is already loaded");
      }
      return;
    }
    threads = std::clamp(cmd.value("threads", 4), 1, 16);
    whisper_context_params params = whisper_context_default_params();
    params.use_gpu = cmd.value("gpu", true);
    auto t0 = Clock::now();
    ctx = whisper_init_from_file_with_params(path.c_str(), params);
    if (!ctx) {
      emit_error(id, "model_failed", "could not load the model " + path);
      return;
    }
    model_path = path;
    double load_ms = ms_since(t0);

    // Una pasada con un segundo de silencio prepara los kernels de la GPU, así
    // el primer dictado no paga ese coste. Con el idioma de los dictados: la
    // detección automática usa kernels propios.
    double warmup_ms = 0;
    if (cmd.value("warmup", false)) {
      auto t1 = Clock::now();
      std::vector<float> silence(SAMPLE_RATE, 0.0f);
      const std::string language = cmd.value("language", "auto"), prompt;
      run(silence, language, prompt, 0, true);
      warmup_ms = ms_since(t1);
    }
    emit({{"type", "loaded"},
          {"id", id},
          {"ms", load_ms},
          {"warmupMs", warmup_ms},
          {"model", whisper_model_type_readable(ctx)},
          {"multilingual", whisper_is_multilingual(ctx) != 0},
          {"memory", memory()}});
  }

  /** Posiciones del codificador para el audio dado (50 por segundo, 1500 como máximo). */
  int trimmed_audio_ctx(size_t samples) {
    int full = whisper_model_n_audio_ctx(ctx);
    double seconds = double(samples) / SAMPLE_RATE + TRIM_MARGIN_S;
    int needed = int(seconds * full / 30.0 + 0.999);
    needed = (needed + TRIM_CTX_STEP - 1) / TRIM_CTX_STEP * TRIM_CTX_STEP;
    return std::min(full, needed);
  }

  // Guarda punteros a `language` y `prompt`: deben vivir hasta que acabe whisper_full.
  whisper_full_params base_params(const std::string &language, const std::string &prompt) {
    whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    p.n_threads = threads;
    p.no_context = true;
    p.no_timestamps = true;
    p.print_special = false;
    p.print_progress = false;
    p.print_realtime = false;
    p.print_timestamps = false;
    // Sin «[Music]», «(applause)» y similares en un dictado.
    p.suppress_nst = true;
    p.language = language.c_str();
    p.detect_language = false;
    p.initial_prompt = prompt.empty() ? nullptr : prompt.c_str();
    p.abort_callback = [](void *data) { return static_cast<Worker *>(data)->cancel.load(); };
    p.abort_callback_user_data = this;
    p.encoder_begin_callback = [](whisper_context *, whisper_state *, void *data) {
      return !static_cast<Worker *>(data)->cancel.load();
    };
    p.encoder_begin_callback_user_data = this;
    return p;
  }

  int run(const std::vector<float> &pcm, const std::string &language, const std::string &prompt, int beam,
          bool trim) {
    whisper_full_params p = base_params(language, prompt);
    if (beam > 1) {
      p.strategy = WHISPER_SAMPLING_BEAM_SEARCH;
      p.beam_search.beam_size = beam;
    }
    if (trim) {
      // El codificador procesa siempre 30 s de audio, aunque el dictado dure
      // menos. Recortado al audio más un margen, un dictado corto va varias
      // veces más rápido. Sin marcas de tiempo, el modelo tiende a repetir el
      // texto con la ventana recortada; con ellas sabe dónde acaba.
      p.audio_ctx = trimmed_audio_ctx(pcm.size());
      p.no_timestamps = false;
      p.max_tokens = int(TRIM_MAX_TOKENS_PER_S * double(pcm.size()) / SAMPLE_RATE) + TRIM_MAX_TOKENS_BASE;
    }
    return whisper_full(ctx, p, pcm.data(), int(pcm.size()));
  }

  std::string collect_text() {
    std::string text;
    int n = whisper_full_n_segments(ctx);
    for (int i = 0; i < n; i++) text += whisper_full_get_segment_text(ctx, i);
    size_t start = text.find_first_not_of(" \t\n");
    size_t end = text.find_last_not_of(" \t\n");
    return start == std::string::npos ? "" : text.substr(start, end - start + 1);
  }

  void transcribe(const json &cmd) {
    std::string id = cmd.value("id", "");
    if (!ctx) {
      emit_error(id, "not_loaded", "no model loaded");
      return;
    }
    auto t0 = Clock::now();
    std::vector<float> pcm;
    std::string error;
    if (!read_wav(cmd.value("audio", ""), pcm, error)) {
      emit_error(id, "bad_audio", error);
      return;
    }
    std::string language = cmd.value("language", "auto");
    if (language.empty()) language = "auto";
    if (language != "auto" && whisper_lang_id(language.c_str()) < 0) {
      emit_error(id, "bad_request", "unknown language " + language);
      return;
    }
    std::string prompt = cmd.value("prompt", "");

    {
      std::lock_guard<std::mutex> lock(current_mutex);
      if (cancelled_ids.erase(id)) {
        emit_error(id, "cancelled", "cancelled");
        return;
      }
      current_id = id;
      cancel = false;
    }
    int beam = cmd.value("beam", 0);
    bool trim = cmd.value("trim", false);
    whisper_reset_timings(ctx);
    int rc = run(pcm, language, prompt, beam, trim);
    std::string text = rc == 0 ? collect_text() : "";
    // Con la ventana recortada, el modelo a veces repite lo dicho. Si pasa, se
    // transcribe otra vez con la ventana entera.
    bool retried = false;
    if (rc == 0 && trim && !cancel.load() && has_loop(text)) {
      fprintf(stderr, "Repetition with a trimmed window, retrying with the full window\n");
      retried = true;
      rc = run(pcm, language, prompt, beam, false);
      text = rc == 0 ? collect_text() : "";
    }
    bool cancelled = cancel.load();
    {
      std::lock_guard<std::mutex> lock(current_mutex);
      current_id.clear();
      cancel = false;
    }
    if (cancelled) {
      emit_error(id, "cancelled", "cancelled");
      return;
    }
    if (rc != 0) {
      emit_error(id, "failed", "whisper_full returned " + std::to_string(rc));
      return;
    }

    json timings = {{"total", ms_since(t0)}};
    if (whisper_timings *t = whisper_get_timings(ctx)) {
      timings["encode"] = t->encode_ms;
      timings["decode"] = t->decode_ms + t->batchd_ms;
      timings["prompt"] = t->prompt_ms;
    }
    const char *detected = whisper_lang_str(whisper_full_lang_id(ctx));
    emit({{"type", "result"},
          {"id", id},
          {"text", text},
          {"language", detected ? json(detected) : json(nullptr)},
          {"segments", whisper_full_n_segments(ctx)},
          {"retried", retried},
          {"audioMs", double(pcm.size()) * 1000.0 / SAMPLE_RATE},
          {"ms", timings},
          {"memory", memory()}});
  }

  // Hilo lector: encola las órdenes y atiende «cancel» al momento.
  void read_input() {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (line.empty()) continue;
      json cmd = json::parse(line, nullptr, false);
      if (cmd.is_discarded() || !cmd.is_object()) {
        emit_error("", "bad_request", "invalid JSON");
        continue;
      }
      if (cmd.value("type", "") == "cancel") {
        std::lock_guard<std::mutex> lock(current_mutex);
        std::string target = cmd.value("id", "");
        if (!current_id.empty() && current_id == target) {
          cancel = true;
        } else if (!target.empty()) {
          cancelled_ids.insert(target);
        }
        continue;
      }
      std::lock_guard<std::mutex> lock(mutex);
      queue.push_back(std::move(cmd));
      cv.notify_one();
    }
    std::lock_guard<std::mutex> lock(mutex);
    input_closed = true;
    cancel = true;
    cv.notify_one();
  }

  void run() {
    std::thread reader([this] { read_input(); });
    reader.detach();
    for (;;) {
      json cmd;
      {
        std::unique_lock<std::mutex> lock(mutex);
        cv.wait(lock, [this] { return input_closed || !queue.empty(); });
        if (input_closed) return;
        cmd = std::move(queue.front());
        queue.pop_front();
      }
      std::string type = cmd.value("type", "");
      if (type == "load") {
        load(cmd);
      } else if (type == "transcribe") {
        transcribe(cmd);
      } else if (type == "ping") {
        emit({{"type", "pong"}, {"id", cmd.value("id", "")}, {"memory", memory()}});
      } else {
        emit_error(cmd.value("id", ""), "bad_request", "unknown command " + type);
      }
    }
  }
};

}  // namespace

int main() {
  whisper_log_set(on_log, nullptr);
  ggml_log_set(on_log, nullptr);
  Worker worker;
  emit({{"type", "hello"},
        {"protocol", PROTOCOL_VERSION},
        {"whisper", whisper_version()},
        {"pid", getpid()},
        {"memory", memory()}});
  worker.run();
  // Salida inmediata: liberar el modelo pieza a pieza no hace falta.
  _exit(0);
}
