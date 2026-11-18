/**
 * Outils de validation partagés par les tests QA (OpenCode).
 *
 * Le contrat shared/contract.ts ne contient que des types TypeScript : aucun
 * validateur exécutable. Ces fonctions comblent ce manque côté tests, sans
 * dépendance externe (Node 24 exécute le TypeScript directement).
 *
 * Convention : chaque fonction renvoie la liste des problèmes trouvés
 * (« chemin : message »), vide si l'objet respecte le contrat.
 */

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'tableau';
  if (typeof value === 'string') return 'chaîne';
  if (typeof value === 'number') return 'nombre';
  if (typeof value === 'boolean') return 'booléen';
  if (typeof value === 'object') return 'objet';
  return typeof value;
}

export class Problems {
  readonly list: string[] = [];

  add(path: string, message: string): void {
    this.list.push(`${path} : ${message}`);
  }

  get count(): number {
    return this.list.length;
  }
}

export function requireObject(value: unknown, path: string, problems: Problems): JsonObject | null {
  if (isObject(value)) return value;
  problems.add(path, `objet attendu (reçu : ${describeValue(value)})`);
  return null;
}

export function requireArray(value: unknown, path: string, problems: Problems): unknown[] | null {
  if (Array.isArray(value)) return value;
  problems.add(path, `tableau attendu (reçu : ${describeValue(value)})`);
  return null;
}

/** Vérifie les clés obligatoires et refuse tout champ hors contrat (divergence entre composants). */
export function requireKeys(
  object: JsonObject,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  problems: Problems,
): void {
  for (const key of required) {
    if (!(key in object)) problems.add(`${path}.${key}`, 'champ obligatoire manquant');
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) problems.add(`${path}.${key}`, 'champ inconnu du contrat');
  }
}

export interface StringOptions {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
}

export function readString(
  object: JsonObject,
  key: string,
  path: string,
  problems: Problems,
  options: StringOptions = {},
): string | null {
  if (!(key in object)) return null;
  const value = object[key];
  if (typeof value !== 'string') {
    problems.add(`${path}.${key}`, `chaîne attendue (reçu : ${describeValue(value)})`);
    return null;
  }
  const { minLength = 1, maxLength, pattern } = options;
  if (value.length < minLength) problems.add(`${path}.${key}`, `chaîne vide ou trop courte (min ${minLength})`);
  if (maxLength !== undefined && value.length > maxLength) {
    problems.add(`${path}.${key}`, `chaîne trop longue (max ${maxLength}, reçu ${value.length})`);
  }
  if (pattern !== undefined && !pattern.test(value)) {
    problems.add(`${path}.${key}`, `format invalide (« ${value} »)`);
  }
  return value;
}

export interface NumberOptions {
  min?: number;
  max?: number;
  integer?: boolean;
  /** Exige une valeur arrondie à la milliseconde. */
  msPrecision?: boolean;
}

export function readNumber(
  object: JsonObject,
  key: string,
  path: string,
  problems: Problems,
  options: NumberOptions = {},
): number | null {
  if (!(key in object)) return null;
  const value = object[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    problems.add(`${path}.${key}`, `nombre fini attendu (reçu : ${describeValue(value)})`);
    return null;
  }
  if (options.integer === true && !Number.isInteger(value)) {
    problems.add(`${path}.${key}`, `entier attendu (reçu ${value})`);
  }
  if (options.min !== undefined && value < options.min) {
    problems.add(`${path}.${key}`, `valeur < minimum ${options.min} (reçu ${value})`);
  }
  if (options.max !== undefined && value > options.max) {
    problems.add(`${path}.${key}`, `valeur > maximum ${options.max} (reçu ${value})`);
  }
  if (options.msPrecision === true && !isMillisecondPrecise(value)) {
    problems.add(`${path}.${key}`, `précision limitée à la milliseconde (reçu ${value})`);
  }
  return value;
}

export function readBoolean(object: JsonObject, key: string, path: string, problems: Problems): boolean | null {
  if (!(key in object)) return null;
  const value = object[key];
  if (typeof value !== 'boolean') {
    problems.add(`${path}.${key}`, `booléen attendu (reçu : ${describeValue(value)})`);
    return null;
  }
  return value;
}

export function readOneOf<T extends string>(
  object: JsonObject,
  key: string,
  path: string,
  problems: Problems,
  allowed: readonly T[],
): T | null {
  if (!(key in object)) return null;
  const value = object[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    problems.add(`${path}.${key}`, `valeur « ${String(value)} » hors contrat (attendu : ${allowed.join(' | ')})`);
    return null;
  }
  return value as T;
}

export function readNullableString(
  object: JsonObject,
  key: string,
  path: string,
  problems: Problems,
  options: StringOptions = {},
): string | null {
  if (!(key in object)) return null;
  const value = object[key];
  if (value === null) return null;
  return readString(object, key, path, problems, options);
}

/** Date ISO 8601 UTC (le contrat impose Date#toISOString, donc un suffixe Z). */
export function readIsoDate(object: JsonObject, key: string, path: string, problems: Problems): string | null {
  const value = readString(object, key, path, problems);
  if (value === null) return null;
  if (!value.endsWith('Z') || Number.isNaN(Date.parse(value))) {
    problems.add(`${path}.${key}`, `date ISO 8601 UTC attendue (reçu « ${value} »)`);
    return null;
  }
  return value;
}

export function readUrl(
  object: JsonObject,
  key: string,
  path: string,
  problems: Problems,
  { nullable = false }: { nullable?: boolean } = {},
): string | null {
  if (!(key in object)) return null;
  const value = object[key];
  if (value === null && nullable) return null;
  if (typeof value !== 'string') {
    problems.add(`${path}.${key}`, `URL sous forme de chaîne attendue (reçu : ${describeValue(value)})`);
    return null;
  }
  if (!isHttpUrl(value)) {
    problems.add(`${path}.${key}`, `URL HTTP(S) valide attendue (reçu « ${value} »)`);
    return null;
  }
  return value;
}

export function isHttpUrl(value: string): boolean {
  if (value.includes('\\') || value.includes('\n') || value.includes('\r')) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function isMillisecondPrecise(value: number): boolean {
  return Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-6;
}

export function nearlyEqual(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) <= epsilon;
}

const LEAK_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[A-Za-z]:\\/, 'chemin Windows exposé'],
  [/(?:^|\s)\/(?:home|Users|var|tmp|mnt|opt|root)\//, 'chemin Unix exposé'],
  [/node_modules/, 'chemin de dépendances exposé'],
  [/\bENOENT\b/, 'code système exposé'],
  [/\bSyntaxError\b/, 'détail JavaScript exposé'],
  [/\n\s+at\s+\S+/, 'stack trace exposée'],
  [/\bstack trace\b/i, 'stack trace exposée'],
  [/gsk_[A-Za-z0-9]{8,}/, 'clé Groq exposée'],
  [/sk-or-v1-[A-Za-z0-9]{8,}/, 'clé OpenRouter exposée'],
];

/** Un message destiné au navigateur ne doit contenir ni secret, ni chemin serveur, ni stack. */
export function checkNoLeak(text: string, path: string, problems: Problems): void {
  for (const [pattern, label] of LEAK_PATTERNS) {
    if (pattern.test(text)) problems.add(path, label);
  }
}

/** Vérifie qu'un corps JSON sérialisé ne contient aucun chemin serveur ni secret. */
export function checkSerializedNoLeak(text: string, path: string, problems: Problems): void {
  checkNoLeak(text, path, problems);
  if (/"(?:storedFileName|outputFile)"\s*:\s*"[^"]*[\\/]/.test(text)) {
    // Les noms de stockage sont des noms de fichier, jamais des chemins.
    problems.add(path, 'nom de fichier contenant un séparateur de chemin');
  }
}
