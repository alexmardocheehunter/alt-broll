import type { LogLevel } from '../config/env.ts';

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** Logger qui ajoute `fields` à chaque entrée. */
  child(fields: LogFields): Logger;
}

/** Reçoit chaque ligne JSON prête à écrire (remplaçable dans les tests). */
export type LogWriter = (level: LogLevel, line: string) => void;

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 5;

/** Clés dont la valeur n'est jamais écrite. */
const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|signature/i;

/** Secrets glissés dans du texte : paramètres d'URL (ex. clé Pixabay) et en-têtes Bearer. */
const SENSITIVE_TEXT: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /([?&](?:key|api_key|apikey|token|signature)=)[^&\s"']+/gi, replacement: `$1${REDACTED}` },
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, replacement: `$1${REDACTED}` },
];

const defaultWriter: LogWriter = (level, line) => {
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
};

/** Logs JSON, une ligne par événement, avec masquage des données sensibles. */
export function createLogger(
  minLevel: LogLevel,
  base: LogFields = {},
  writer: LogWriter = defaultWriter,
): Logger {
  const threshold = LEVEL_WEIGHT[minLevel];

  const write = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const entry = {
      time: new Date().toISOString(),
      level,
      event,
      ...sanitize(base),
      ...(fields === undefined ? {} : sanitize(fields)),
    };
    writer(level, JSON.stringify(entry));
  };

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child: (fields) => createLogger(minLevel, { ...base, ...fields }, writer),
  };
}

/** Copie journalisable : clés sensibles masquées, erreurs sérialisées, profondeur bornée. */
export function sanitize(fields: LogFields, depth = 0): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    safe[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(value, depth);
  }
  return safe;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return serializeError(value, depth);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  return sanitize(value as LogFields, depth + 1);
}

function serializeError(error: Error, depth: number): Record<string, unknown> {
  const extra = error as Error & { code?: unknown; details?: unknown };
  return {
    name: error.name,
    message: redactText(error.message),
    ...(extra.code === undefined ? {} : { code: extra.code }),
    ...(extra.details === undefined ? {} : { details: sanitizeValue(extra.details, depth + 1) }),
    ...(error.cause === undefined || depth >= MAX_DEPTH
      ? {}
      : { cause: sanitizeValue(error.cause, depth + 1) }),
    stack: error.stack === undefined ? undefined : redactText(error.stack),
  };
}

function redactText(text: string): string {
  return SENSITIVE_TEXT.reduce((result, rule) => result.replace(rule.pattern, rule.replacement), text);
}
