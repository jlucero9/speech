import { app } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';

// En desarrollo, los productos firmados (helper y Electron de desarrollo) viven
// fuera del proyecto: el Escritorio está bajo un file provider de iCloud que
// añade atributos a los bundles recién firmados y rompe su firma.
// Debe coincidir con COMPILACION en scripts/firma/comun.sh.
export const DEV_BUILD_DIR = join(homedir(), 'Library', 'Developer', 'Speech');

export function helperExecutable(): string {
  const bundle = join('SpeechHelper.app', 'Contents', 'MacOS', 'SpeechHelper');
  return app.isPackaged ? join(process.resourcesPath, bundle) : join(DEV_BUILD_DIR, 'helper', bundle);
}
