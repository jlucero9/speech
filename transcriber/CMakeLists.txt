# Proceso de transcripción local: whisper.cpp enlazado de forma estática, con
# Metal. Lo compila scripts/transcriber.sh; WHISPER_SRC apunta al código de
# whisper.cpp descargado en la versión fijada allí.
cmake_minimum_required(VERSION 3.20)
project(SpeechTranscriber LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_OSX_ARCHITECTURES arm64)
set(CMAKE_OSX_DEPLOYMENT_TARGET 13.3)

if(NOT WHISPER_SRC)
  message(FATAL_ERROR "Falta -DWHISPER_SRC=<ruta al código de whisper.cpp>")
endif()

# Solo la biblioteca: sin ejemplos, pruebas ni servidor.
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(WHISPER_CURL OFF CACHE BOOL "" FORCE)
set(WHISPER_SDL2 OFF CACHE BOOL "" FORCE)
# Metal con los shaders dentro del binario: sin Xcode no hay compilador de
# Metal, así que se compilan al cargar (y macOS guarda el resultado en caché).
set(GGML_METAL ON CACHE BOOL "" FORCE)
set(GGML_METAL_EMBED_LIBRARY ON CACHE BOOL "" FORCE)
set(GGML_NATIVE ON CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_BLAS ON CACHE BOOL "" FORCE)
add_subdirectory(${WHISPER_SRC} whisper EXCLUDE_FROM_ALL)

add_executable(SpeechTranscriber main.cpp)
target_include_directories(SpeechTranscriber SYSTEM PRIVATE ${WHISPER_SRC}/examples)
target_link_libraries(SpeechTranscriber PRIVATE whisper)
target_compile_options(SpeechTranscriber PRIVATE -Wall -Wextra)
