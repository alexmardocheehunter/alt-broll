import { ERROR_CODES, ERROR_STAGES, type ErrorInfo } from '../../../shared/contract.ts';
import {
  checkNoLeak,
  describeValue,
  type JsonObject,
  Problems,
  readBoolean,
  readOneOf,
  readString,
  requireKeys,
  requireObject,
} from './core.ts';

/** Valide une ErrorInfo du contrat et vérifie qu'aucun secret ni chemin ne fuit. */
export function validateErrorInfo(value: unknown, path = 'error'): string[] {
  const problems = new Problems();
  const error = requireObject(value, path, problems);
  if (error === null) return problems.list;

  requireKeys(error, path, ['code', 'stage', 'message', 'retryable'], [], problems);
  readOneOf(error, 'code', path, problems, ERROR_CODES);
  readOneOf(error, 'stage', path, problems, ERROR_STAGES);
  const message = readString(error, 'message', path, problems, { minLength: 2, maxLength: 400 });
  readBoolean(error, 'retryable', path, problems);
  if (message !== null) checkNoLeak(message, `${path}.message`, problems);

  return problems.list;
}

/** Corps de réponse ApiErrorResponse. */
export function validateApiErrorResponse(value: unknown, path = 'response'): string[] {
  const problems = new Problems();
  const response = requireObject(value, path, problems);
  if (response === null) return problems.list;

  requireKeys(response, path, ['error', 'requestId'], [], problems);
  if ('error' in response) {
    for (const problem of validateErrorInfo(response.error, `${path}.error`)) problems.list.push(problem);
  }
  const requestId = readString(response, 'requestId', path, problems, { minLength: 8, maxLength: 128 });
  if (requestId !== null && !/^[A-Za-z0-9_-]+$/.test(requestId)) {
    problems.add(`${path}.requestId`, `identifiant de requête inattendu (« ${requestId} »)`);
  }
  return problems.list;
}

export interface ErrorLike {
  code: string;
  stage: string;
  message: string;
  retryable: boolean;
}

export function asErrorInfo(value: unknown): ErrorLike | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<ErrorLike>;
  if (
    typeof candidate.code !== 'string' ||
    typeof candidate.stage !== 'string' ||
    typeof candidate.message !== 'string' ||
    typeof candidate.retryable !== 'boolean'
  ) {
    return null;
  }
  return candidate as ErrorLike;
}

/** Vérifie qu'une valeur inconnue est bien une ErrorInfo (utile dans les assertions de parcours). */
export function expectErrorInfo(value: unknown): ErrorInfo {
  const problems = validateErrorInfo(value);
  if (problems.length > 0) {
    throw new Error(`ErrorInfo invalide :\n  - ${problems.join('\n  - ')}`);
  }
  return value as ErrorInfo;
}

export function describeError(value: unknown): string {
  const error = asErrorInfo(value);
  if (error === null) return `valeur inattendue : ${describeValue(value)}`;
  return `${error.code} (${error.stage}) : ${error.message}`;
}

export type { JsonObject };
