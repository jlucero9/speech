import { join } from 'node:path';
import { CLOUD_PROVIDER_NAMES, CLOUD_PROVIDERS, isPlausibleApiKey, type ApiKeyResult, type ApiKeyStatus, type CloudProvider } from '../shared/engines';
import { logger } from './log';
import type { Store } from './store';

// Claves de los proveedores en la nube, en el llavero de macOS. La interfaz solo
// las escribe: nunca vuelven a ella ni al registro. Se leen justo antes de usarlas,
// sin aviso posible; saber si hay clave no descifra nada.

const log = logger('keys');

const ERR_NOT_FOUND = -25300;
const ERR_INTERACTION_NOT_ALLOWED = -25308;
const ERR_AUTH_FAILED = -25293;

interface KeychainModule {
  status(account: string): Promise<{ status: number }>;
  get(account: string, interactive: boolean): Promise<{ status: number; value?: string }>;
  set(account: string, value: string): Promise<{ status: number }>;
  remove(account: string): Promise<{ status: number }>;
}

/** No se puede leer la clave ahora mismo. El mensaje es para el usuario. */
export class ApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyError';
  }
}

export type ReadApiKey = (provider: CloudProvider) => Promise<string>;

function loadModule(): KeychainModule | null {
  try {
    return require(join(__dirname, '..', 'native', 'keychain.node')) as KeychainModule;
  } catch (err) {
    log.error(`Could not load the keychain module: ${(err as Error).message}`);
    return null;
  }
}

function needsPermission(status: number): boolean {
  return status === ERR_INTERACTION_NOT_ALLOWED || status === ERR_AUTH_FAILED;
}

export class ApiKeys {
  private readonly keychain = loadModule();

  constructor(private readonly store: Store) {}

  private set(provider: CloudProvider, status: ApiKeyStatus): void {
    if (this.store.get().apiKeys[provider] === status) return;
    this.store.update((s) => ({ ...s, apiKeys: { ...s.apiKeys, [provider]: status } }));
  }

  /** Mira qué claves hay. No lee ninguna. */
  async refresh(): Promise<void> {
    await Promise.all(
      CLOUD_PROVIDERS.map(async (p) => {
        if (!this.keychain) return this.set(p, 'unavailable');
        const { status } = await this.keychain.status(p);
        if (status === ERR_NOT_FOUND) this.set(p, 'missing');
        else if (status !== 0 && !needsPermission(status)) {
          log.warn(`Keychain status for ${p}: ${status}`);
          this.set(p, 'unavailable');
        } else if (this.store.get().apiKeys[p] !== 'locked') this.set(p, 'saved');
      }),
    );
  }

  /** La clave, sin enseñar nunca un aviso. Falla con un mensaje si no se puede. */
  read: ReadApiKey = async (provider) => {
    const name = CLOUD_PROVIDER_NAMES[provider];
    if (!this.keychain) throw new ApiKeyError('The macOS Keychain is not available.');
    const r = await this.keychain.get(provider, false);
    if (r.status === 0 && r.value) {
      this.set(provider, 'saved');
      return r.value;
    }
    if (r.status === ERR_NOT_FOUND) {
      this.set(provider, 'missing');
      throw new ApiKeyError(`Add your ${name} key in Settings › Engines and Keys.`);
    }
    if (needsPermission(r.status)) {
      this.set(provider, 'locked');
      throw new ApiKeyError(`macOS needs your permission to read your ${name} key. Allow it in Settings › Engines and Keys.`);
    }
    log.warn(`Keychain read for ${provider}: ${r.status}`);
    throw new ApiKeyError(`Could not read your ${name} key from the Keychain.`);
  };

  async save(provider: CloudProvider, key: string): Promise<ApiKeyResult> {
    const value = typeof key === 'string' ? key.trim() : '';
    if (!isPlausibleApiKey(value)) return { ok: false, message: "That doesn't look like an API key." };
    if (!this.keychain) return { ok: false, message: 'The macOS Keychain is not available.' };
    const { status } = await this.keychain.set(provider, value);
    if (status !== 0) {
      log.warn(`Keychain save for ${provider}: ${status}`);
      return {
        ok: false,
        message: needsPermission(status)
          ? 'macOS needs your permission to change this key. Use Allow first, or delete it in Keychain Access.'
          : 'Could not save the key to the Keychain.',
      };
    }
    log.info(`Saved the ${provider} key in the Keychain`);
    this.set(provider, 'saved');
    return { ok: true };
  }

  async remove(provider: CloudProvider): Promise<ApiKeyResult> {
    if (!this.keychain) return { ok: false, message: 'The macOS Keychain is not available.' };
    const { status } = await this.keychain.remove(provider);
    if (status !== 0 && status !== ERR_NOT_FOUND) {
      log.warn(`Keychain delete for ${provider}: ${status}`);
      return {
        ok: false,
        message: needsPermission(status)
          ? 'macOS needs your permission to remove this key. Use Allow first, or delete it in Keychain Access.'
          : 'Could not remove the key from the Keychain.',
      };
    }
    log.info(`Removed the ${provider} key from the Keychain`);
    this.set(provider, 'missing');
    return { ok: true };
  }

  /** Solo a petición del usuario: aquí sí puede salir el aviso de macOS. */
  async allow(provider: CloudProvider): Promise<ApiKeyResult> {
    if (!this.keychain) return { ok: false, message: 'The macOS Keychain is not available.' };
    const r = await this.keychain.get(provider, true);
    if (r.status === 0) {
      this.set(provider, 'saved');
      return { ok: true };
    }
    if (r.status === ERR_NOT_FOUND) this.set(provider, 'missing');
    return { ok: false, message: 'macOS did not allow Speech to read the key.' };
  }

  /** Comprueba la clave con el proveedor. Solo pide su lista de modelos: no manda nada tuyo. */
  async test(provider: CloudProvider): Promise<ApiKeyResult> {
    try {
      const key = await this.read(provider);
      const res =
        provider === 'groq'
          ? await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) })
          : await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
              headers: { 'x-goog-api-key': key },
              signal: AbortSignal.timeout(10_000),
            });
      if (res.ok) return { ok: true };
      if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false, message: `${CLOUD_PROVIDER_NAMES[provider]} rejected this key.` };
      return { ok: false, message: `${CLOUD_PROVIDER_NAMES[provider]} answered with an error (${res.status}).` };
    } catch (err) {
      if (err instanceof ApiKeyError) return { ok: false, message: err.message };
      return { ok: false, message: `Couldn't reach ${CLOUD_PROVIDER_NAMES[provider]}.` };
    }
  }
}
