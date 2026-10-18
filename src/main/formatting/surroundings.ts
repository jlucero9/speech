import type { TextSurroundings } from './formatter';

// Ajuste del texto dictado al que ya hay en el campo, justo antes de pegar y
// tanto si se formateó como si no:
// - un espacio delante si el texto anterior no acaba en espacio (dos dictados
//   seguidos no quedan pegados) y uno detrás si lo que sigue empieza por letra;
// - minúscula inicial si continúa una frase empezada;
// - sin punto final si detrás del cursor sigue la frase.
// Sin contexto (el campo no deja leerse) el texto se pega tal cual.

/** Palabras que siempre van en mayúscula aunque continúen una frase. */
const ALWAYS_CAPITALIZED = /^(I|I'm|I'll|I've|I'd|OK)$/;
/** Tras estos caracteres no hace falta espacio. */
const NO_SPACE_AFTER = /[\s([{¿¡"'“‘«/\-–—@#]$/u;
/** El texto dictado que empieza por esto no lleva espacio delante. */
const NO_SPACE_BEFORE = /^[\s,.;:!?)\]}»”’…%]/u;
const SENTENCE_END = /[.!?…:]["'”’»)\]]*$/u;
/** Una frase empezada acaba en letra, cifra, coma o cierre; un prompt de
 *  terminal («~ %», «$», «❯», «>») no, y lo que se dicta ahí empieza de cero. */
const MID_SENTENCE = /[\p{L}\p{N},;)\]"'”’»]$/u;

export function fitToSurroundings(text: string, s: TextSurroundings | null, vocabulary: string[] = []): string {
  if (!s || !text) return text;
  let out = text;
  const before = s.before;
  const after = s.after;
  // Lo que decide si la frase continúa es lo anterior a los espacios y a los
  // paréntesis o comillas de apertura.
  const beforeTrimmed = before.replace(/[ \t([{¿¡"'“‘«]+$/u, '');

  // Continúa una frase: el texto anterior acaba en mitad de una, no en punto.
  const continues = MID_SENTENCE.test(beforeTrimmed) && !SENTENCE_END.test(beforeTrimmed);
  if (continues) out = lowerFirst(out, vocabulary);

  if (before.length > 0 && !NO_SPACE_AFTER.test(before) && !NO_SPACE_BEFORE.test(out)) out = ` ${out}`;

  // Detrás sigue texto: si empieza en minúscula, la frase continúa y sobra el
  // punto; si va pegado al cursor, hace falta un espacio.
  const next = after.replace(/^[ \t]+/, '').charAt(0);
  if (/\p{Ll}/u.test(next) && /[^.]\.$/.test(out)) out = out.slice(0, -1);
  if (/^[\p{L}\p{N}]/u.test(after)) out = `${out} `;
  return out;
}

function lowerFirst(text: string, vocabulary: string[]): string {
  const m = /^(\p{Lu})(\S*)/u.exec(text);
  if (!m) return text;
  const word = m[0].replace(/[^\p{L}\p{N}']+$/u, '');
  // Siglas, nombres del diccionario y «I» se quedan como están.
  if (ALWAYS_CAPITALIZED.test(word)) return text;
  if (word.length > 1 && word === word.toUpperCase()) return text;
  if (vocabulary.some((v) => v.split(/\s+/)[0] === word)) return text;
  return m[1].toLowerCase() + text.slice(1);
}
