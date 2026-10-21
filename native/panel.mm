// Módulo nativo de la barra: hace que su panel no active la app al recibir
// un clic.
//
// Electron crea las ventanas `type: 'panel'` con una clase que solo dice
// tener el estilo de panel no activante; el servidor de ventanas no lo sabe,
// así que un clic en la barra activa Speech y el teclado deja de ir a la app
// donde se está escribiendo. AppKit tiene un ajuste por ventana que impide la
// activación; no es público, así que se comprueba todo antes de usarlo y, si
// falta, la barra sigue funcionando como antes.
//
// Se compila con scripts/build.mjs (Node-API, sin dependencias).

#include <node_api.h>
#import <AppKit/AppKit.h>
#import <objc/message.h>
#import <objc/runtime.h>
#include <cstring>
#include <pthread.h>

static napi_value Str(napi_env env, const char* s) {
  napi_value v = nullptr;
  napi_create_string_utf8(env, s, NAPI_AUTO_LENGTH, &v);
  return v;
}

static const char* Prevent(NSWindow* window) {
  // Solo para paneles que nunca toman el teclado: lo demás no se toca.
  if (!(window.styleMask & NSWindowStyleMaskNonactivatingPanel) || window.canBecomeKeyWindow ||
      window.canBecomeMainWindow) {
    return "ineligible-window";
  }
  SEL sel = NSSelectorFromString(@"_setPreventsActivation:");
  if (![window respondsToSelector:sel]) return "unsupported-selector";
  NSMethodSignature* sig = [window methodSignatureForSelector:sel];
  if (sig.numberOfArguments != 3 || strcmp(sig.methodReturnType, @encode(void)) != 0 ||
      strcmp([sig getArgumentTypeAtIndex:2], @encode(BOOL)) != 0) {
    return "unsupported-signature";
  }
  @try {
    ((void (*)(id, SEL, BOOL))objc_msgSend)(window, sel, YES);
  } @catch (NSException*) {
    return "native-exception";
  }
  return "applied";
}

// preventActivation(handle: Buffer): string
// `handle` es lo que devuelve BrowserWindow.getNativeWindowHandle(): el
// puntero a la vista de contenido de la ventana.
static napi_value PreventActivation(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1) {
    return Str(env, "invalid-handle");
  }
  bool isBuffer = false;
  void* data = nullptr;
  size_t length = 0;
  if (napi_is_buffer(env, argv[0], &isBuffer) != napi_ok || !isBuffer ||
      napi_get_buffer_info(env, argv[0], &data, &length) != napi_ok || length != sizeof(void*)) {
    return Str(env, "invalid-handle");
  }
  if (!pthread_main_np()) return Str(env, "wrong-thread");
  void* view = *static_cast<void**>(data);
  // Se busca entre las ventanas de la app en vez de fiarse del puntero.
  for (NSWindow* window in NSApp.windows) {
    if ((__bridge void*)window.contentView == view) return Str(env, Prevent(window));
  }
  return Str(env, "window-not-found");
}

NAPI_MODULE_INIT() {
  napi_value fn = nullptr;
  napi_create_function(env, "preventActivation", NAPI_AUTO_LENGTH, PreventActivation, nullptr, &fn);
  napi_set_named_property(env, exports, "preventActivation", fn);
  return exports;
}
