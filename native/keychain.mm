// Módulo nativo de las claves de API: las guarda en el llavero de inicio de
// sesión de macOS, con el acceso ligado a la firma de la app (otra app no las
// lee sin que macOS pregunte).
//
// Cada operación corre en otro hilo: si macOS tuviera que preguntar, main no
// se queda parado. Solo `get` con `interactive` puede enseñar un aviso; todo lo
// demás devuelve errSecInteractionNotAllowed si hiciera falta uno, para que un
// dictado nunca abra un diálogo.
//
// El interruptor de los avisos (SecKeychainSetUserInteractionAllowed) es de
// todo el proceso, y las operaciones corren a la vez en hilos distintos. Por
// eso se cuenta: las operaciones sin aviso pueden solaparse, el interruptor se
// apaga con la primera y vuelve a su valor con la última. La que puede avisar
// va sola, y mientras espera tu respuesta las demás no tocan el llavero:
// devuelven kBusy al momento (ni leen con los avisos permitidos ni dejan un
// dictado esperando al diálogo).
//
// Se compila con scripts/build.mjs (Node-API, sin dependencias).

#include <node_api.h>
#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <condition_variable>
#include <mutex>
#include <string>

static NSString* const kService = @"local.speech.api-keys";

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
// La única forma de impedir avisos en los llaveros de fichero.
static void AllowUI(bool on) { SecKeychainSetUserInteractionAllowed(on); }
#pragma clang diagnostic pop

// Hay un aviso del llavero abierto (o a punto de abrirse): vuelva a intentarlo después.
static const OSStatus kBusy = -1;

static std::mutex gMutex;
static std::condition_variable gIdle;
// Protegidos por gMutex.
static int gQuiet = 0;         // operaciones en curso con los avisos apagados
static bool gPrompting = false;  // operación en curso que puede avisar

// Devuelve false si no puede empezar (hay un aviso abierto).
static bool Enter(bool interactive) {
  std::unique_lock<std::mutex> lock(gMutex);
  if (interactive) {
    // Espera a que acaben las demás (milisegundos) y se queda sola.
    gIdle.wait(lock, [] { return gQuiet == 0 && !gPrompting; });
    gPrompting = true;
    AllowUI(true);
    return true;
  }
  if (gPrompting) return false;
  if (gQuiet++ == 0) AllowUI(false);
  return true;
}

static void Leave(bool interactive) {
  std::lock_guard<std::mutex> lock(gMutex);
  if (interactive) {
    gPrompting = false;
  } else if (--gQuiet == 0) {
    AllowUI(true);
  }
  gIdle.notify_all();
}

static NSMutableDictionary* Query(const std::string& account) {
  return [@{
    (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
    (__bridge id)kSecAttrService : kService,
    (__bridge id)kSecAttrAccount : [NSString stringWithUTF8String:account.c_str()],
  } mutableCopy];
}

enum class Kind { Status, Get, Set, Remove };

struct Work {
  Kind kind;
  std::string account;
  std::string value;
  bool interactive = false;
  OSStatus status = errSecSuccess;
  napi_deferred deferred = nullptr;
  napi_async_work work = nullptr;
};

static void Execute(napi_env, void* data) {
  Work* w = static_cast<Work*>(data);
  const bool interactive = w->kind == Kind::Get && w->interactive;
  if (!Enter(interactive)) {
    w->status = kBusy;
    return;
  }
  @autoreleasepool {
    NSMutableDictionary* q = Query(w->account);
    switch (w->kind) {
      case Kind::Status: {
        // Solo atributos: saber si existe no descifra nada ni pregunta nada.
        q[(__bridge id)kSecReturnAttributes] = @YES;
        q[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
        CFTypeRef out = nullptr;
        w->status = SecItemCopyMatching((__bridge CFDictionaryRef)q, &out);
        if (out) CFRelease(out);
        break;
      }
      case Kind::Get: {
        q[(__bridge id)kSecReturnData] = @YES;
        q[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
        CFTypeRef out = nullptr;
        w->status = SecItemCopyMatching((__bridge CFDictionaryRef)q, &out);
        if (w->status == errSecSuccess && out) {
          NSData* d = (__bridge_transfer NSData*)out;
          w->value.assign(static_cast<const char*>(d.bytes), d.length);
        } else if (out) {
          CFRelease(out);
        }
        break;
      }
      case Kind::Set: {
        // Solo se reemplaza una clave que esta app puede leer. El llavero liga
        // la lectura al binario exacto que creó el ítem, pero deja escribir a
        // cualquiera: reemplazarla desde otro binario (Speech actualizada) la
        // dejaría ilegible para todos sin decir nada.
        NSMutableDictionary* probe = Query(w->account);
        probe[(__bridge id)kSecReturnData] = @YES;
        probe[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
        CFTypeRef current = nullptr;
        OSStatus readable = SecItemCopyMatching((__bridge CFDictionaryRef)probe, &current);
        if (current) CFRelease(current);
        if (readable != errSecSuccess && readable != errSecItemNotFound) {
          w->status = readable;
          break;
        }
        NSData* d = [NSData dataWithBytes:w->value.data() length:w->value.size()];
        w->status = SecItemUpdate((__bridge CFDictionaryRef)q,
                                  (__bridge CFDictionaryRef) @{(__bridge id)kSecValueData : d});
        if (w->status == errSecItemNotFound) {
          q[(__bridge id)kSecValueData] = d;
          q[(__bridge id)kSecAttrLabel] = [NSString stringWithFormat:@"Speech API key (%s)", w->account.c_str()];
          w->status = SecItemAdd((__bridge CFDictionaryRef)q, nullptr);
        }
        break;
      }
      case Kind::Remove:
        w->status = SecItemDelete((__bridge CFDictionaryRef)q);
        break;
    }
  }
  Leave(interactive);
}

// Siempre se resuelve con { status, value? }: los códigos los interpreta JS.
static void Complete(napi_env env, napi_status, void* data) {
  Work* w = static_cast<Work*>(data);
  napi_value result = nullptr, status = nullptr;
  napi_create_object(env, &result);
  napi_create_int32(env, w->status, &status);
  napi_set_named_property(env, result, "status", status);
  if (w->kind == Kind::Get && w->status == errSecSuccess) {
    napi_value value = nullptr;
    napi_create_string_utf8(env, w->value.data(), w->value.size(), &value);
    napi_set_named_property(env, result, "value", value);
  }
  napi_resolve_deferred(env, w->deferred, result);
  napi_delete_async_work(env, w->work);
  delete w;
}

static bool ReadString(napi_env env, napi_value v, std::string* out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, v, nullptr, 0, &length) != napi_ok) return false;
  out->resize(length + 1);
  if (napi_get_value_string_utf8(env, v, out->data(), length + 1, &length) != napi_ok) return false;
  out->resize(length);
  return true;
}

// status(account) · get(account, interactive) · set(account, value) · remove(account)
template <Kind K>
static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  Work* w = new Work();
  w->kind = K;
  napi_value promise = nullptr;
  if (argc < 1 || !ReadString(env, argv[0], &w->account) || (K == Kind::Set && (argc < 2 || !ReadString(env, argv[1], &w->value)))) {
    delete w;
    napi_throw_type_error(env, nullptr, "Invalid arguments");
    return nullptr;
  }
  if (K == Kind::Get && argc > 1) napi_get_value_bool(env, argv[1], &w->interactive);
  napi_create_promise(env, &w->deferred, &promise);
  napi_value name = nullptr;
  napi_create_string_utf8(env, "keychain", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, nullptr, name, Execute, Complete, w, &w->work);
  napi_queue_async_work(env, w->work);
  return promise;
}

NAPI_MODULE_INIT() {
  const struct {
    const char* name;
    napi_callback fn;
  } fns[] = {{"status", Start<Kind::Status>}, {"get", Start<Kind::Get>}, {"set", Start<Kind::Set>}, {"remove", Start<Kind::Remove>}};
  for (const auto& f : fns) {
    napi_value v = nullptr;
    napi_create_function(env, f.name, NAPI_AUTO_LENGTH, f.fn, nullptr, &v);
    napi_set_named_property(env, exports, f.name, v);
  }
  return exports;
}
