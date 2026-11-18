import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { ApiErrorResponse, ErrorCode, ErrorInfo, ErrorStage } from '../contract.ts';
import type { Logger } from './logger.ts';
import { getRequestId } from './request-context.ts';

export interface AppErrorOptions {
  code: ErrorCode;
  stage: ErrorStage;
  /** Message pour l'utilisateur : français, sans secret, chemin serveur ni détail technique. */
  message: string;
  httpStatus: number;
  retryable?: boolean;
  /** Contexte technique : journalisé côté serveur, jamais renvoyé au navigateur. */
  details?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}

/** Erreur connue : son code, son étape et son message sont transmis au client. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly stage: ErrorStage;
  readonly httpStatus: number;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code;
    this.stage = options.stage;
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toInfo(): ErrorInfo {
    return { code: this.code, stage: this.stage, message: this.message, retryable: this.retryable };
  }
}

/** Réponse générique : la cause réelle d'une erreur inattendue reste dans les logs. */
const INTERNAL_ERROR: ErrorInfo = {
  code: 'INTERNAL_ERROR',
  stage: 'internal',
  message: 'Une erreur interne est survenue. Réessayez dans un instant.',
  retryable: true,
};

export interface PublicError {
  httpStatus: number;
  info: ErrorInfo;
  /** false : erreur inattendue, journalisée avec sa stack trace. */
  expected: boolean;
}

/** Traduit toute erreur en réponse publique ; seules les erreurs connues sont détaillées. */
export function toPublicError(error: unknown): PublicError {
  if (error instanceof AppError) {
    return { httpStatus: error.httpStatus, info: error.toInfo(), expected: true };
  }
  return fromBodyParserError(error) ?? { httpStatus: 500, info: INTERNAL_ERROR, expected: false };
}

/** Erreurs levées par express.json() : JSON invalide, corps trop gros… */
function fromBodyParserError(error: unknown): PublicError | null {
  if (typeof error !== 'object' || error === null) return null;
  const { type, status } = error as { type?: unknown; status?: unknown };
  if (typeof type !== 'string' || typeof status !== 'number') return null;

  const reject = (httpStatus: number, code: ErrorCode, message: string): PublicError => ({
    httpStatus,
    info: { code, stage: 'request', message, retryable: false },
    expected: true,
  });

  if (type === 'entity.too.large') return reject(413, 'PAYLOAD_TOO_LARGE', 'La requête est trop volumineuse.');
  if (type === 'entity.parse.failed') {
    return reject(400, 'BAD_REQUEST', "Le corps de la requête n'est pas un JSON valide.");
  }
  if (status >= 400 && status < 500) return reject(status, 'BAD_REQUEST', 'Requête invalide.');
  return null;
}

/** 404 structurée pour toute route inconnue. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(
    new AppError({
      code: 'NOT_FOUND',
      stage: 'request',
      httpStatus: 404,
      message: "Cette ressource n'existe pas.",
    }),
  );
};

/** Dernier middleware : réponse ApiErrorResponse ; le détail technique ne va que dans les logs. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const { httpStatus, info, expected } = toPublicError(error);
    const requestId = getRequestId(res);
    const context = { requestId, method: req.method, path: req.path, status: httpStatus, code: info.code };

    if (expected && httpStatus < 500) {
      logger.info('http.request_rejected', {
        ...context,
        details: error instanceof AppError ? error.details : undefined,
      });
    } else {
      logger.error('http.request_failed', { ...context, err: error });
    }

    const body: ApiErrorResponse = { error: info, requestId };
    res.status(httpStatus).json(body);
  };
}
