// Sustituciones del diccionario: «cuando salga esta frase, escribe esto otro».
// Se aplican al texto final (formateado o no), antes de ajustarlo al texto que
// rodea al cursor y de pegarlo.
//
// Reglas:
// - Solo palabras completas: la frase no puede ir pegada a una letra, cifra o
//   guion bajo por ningún lado.
// - Sin distinguir mayúsculas; los espacios de la frase valen por cualquier
//   espacio del texto.
// - Si dos frases se solapan, gana la más larga.
// - En inglés, «can» no coincide dentro de «can't».
// - El reemplazo se escribe tal cual se guardó.

export interface SubstitutionPair {
  phrase: string;
  replacement: string;
}

export interface Substituted {
  text: string;
  /** Cuántas coincidencias se sustituyeron. */
  count: number;
}

export type Substitute = (text: string) => Substituted;

const key = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildSubstitute(pairs: SubstitutionPair[]): Substitute {
  const map = new Map<string, string>();
  for (const p of pairs) {
    const k = key(p.phrase);
    if (k && !map.has(k)) map.set(k, p.replacement);
  }
  if (map.size === 0) return (text) => ({ text, count: 0 });
  const alternatives = [...map.keys()]
    .sort((a, b) => b.length - a.length)
    .map((k) => k.split(' ').map(escape).join('\\s+'));
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternatives.join('|')})(?![\\p{L}\\p{N}_])(?!['‘’´\`′]t(?![\\p{L}\\p{N}]))`,
    'giu',
  );
  return (text) => {
    let count = 0;
    const out = text.replace(re, (m) => {
      const r = map.get(key(m));
      if (r == null) return m;
      count++;
      return r;
    });
    return { text: out, count };
  };
}
