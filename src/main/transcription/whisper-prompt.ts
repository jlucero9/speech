// Pista para los motores whisper, en el equipo o en la nube.

/** Whisper usa como mucho unos 224 tokens de pista. */
const MAX_PROMPT_CHARS = 600;

/**
 * Texto previo con puntuación en el idioma del dictado. Sin él, los dictados
 * largos salen a menudo sin puntos, comas ni mayúsculas. Frases neutras: con
 * palabras que se dicen mucho («esto», «esta»…), el modelo tiende a copiarlas.
 */
const STYLE_PROMPTS: Record<string, string> = {
  es: 'Hola, ¿qué tal? Bien, gracias.',
  en: 'Hello, how are you? Fine, thanks.',
  pt: 'Olá, tudo bem? Tudo bem, obrigado.',
  ca: 'Hola, què tal? Bé, gràcies.',
  fr: 'Bonjour, ça va ? Oui, merci.',
  it: 'Ciao, come stai? Bene, grazie.',
  de: 'Hallo, wie geht’s? Gut, danke.',
  nl: 'Hallo, hoe gaat het? Goed, dank je.',
};

/**
 * La frase de estilo del idioma y los términos del diccionario (whisper tiende
 * a escribirlos igual que en la pista).
 */
export function buildWhisperPrompt(language: string, terms: string[]): string {
  let prompt = STYLE_PROMPTS[language] ?? '';
  let list = '';
  for (const t of terms) {
    const next = list ? `${list}, ${t}` : t;
    if (prompt.length + 1 + next.length > MAX_PROMPT_CHARS) break;
    list = next;
  }
  if (list) prompt = prompt ? `${prompt} ${list}` : list;
  return prompt;
}
