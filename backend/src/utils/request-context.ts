import { randomUUID } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import type { Logger } from './logger.ts';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Identifiant de la requête en cours, posé par requestContext. */
export function getRequestId(res: Response): string {
  const value: unknown = res.locals.requestId;
  return typeof value === 'string' ? value : 'unknown';
}

/**
 * Attribue un identifiant à chaque requête (en-tête X-Request-Id) et journalise
 * sa fin, sans query string ni corps. Les lectures réussies (GET 2xx/3xx, dont
 * le polling de statut) sont en debug ; le reste en info.
 */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const { method, path } = req;

    res.locals.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    res.on('finish', () => {
      const fields = {
        requestId,
        method,
        path,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      };
      if (method === 'GET' && res.statusCode < 400) logger.debug('http.request', fields);
      else logger.info('http.request', fields);
    });

    next();
  };
}
