// Descarga Figtree y EB Garamond (fuentes variables, licencia SIL OFL) del
// repositorio oficial de Google Fonts y las deja en src/renderer/assets/fonts.
// Uso: npm run fuentes
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ORIGEN = 'https://raw.githubusercontent.com/google/fonts/main/ofl';
const DESTINO = join(import.meta.dirname, '..', 'src', 'renderer', 'assets', 'fonts');

const FICHEROS = [
  ['figtree/Figtree[wght].ttf', 'Figtree-Variable.ttf'],
  ['figtree/OFL.txt', 'Figtree-OFL.txt'],
  ['ebgaramond/EBGaramond[wght].ttf', 'EBGaramond-Variable.ttf'],
  ['ebgaramond/OFL.txt', 'EBGaramond-OFL.txt'],
];

await mkdir(DESTINO, { recursive: true });
for (const [ruta, nombre] of FICHEROS) {
  const url = `${ORIGEN}/${ruta.replace('[', '%5B').replace(']', '%5D')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const datos = Buffer.from(await res.arrayBuffer());
  await writeFile(join(DESTINO, nombre), datos);
  const hash = createHash('sha256').update(datos).digest('hex');
  console.log(`${nombre}  ${datos.length} bytes  sha256 ${hash}`);
}
