import type { RequestHandler } from 'express';
import { AppError } from './errors.ts';

export interface RateLimiterOptions {
  readonly windowMs: number;
  readonly max: number;
  readonly now?: () => number;
}

/** Au-delà, les fenêtres expirées sont purgées pour borner la mémoire. */
const MAX_TRACKED_KEYS = 10_000;

/**
 * Limiteur en mémoire, fenêtre fixe par adresse IP : suffisant pour un seul
 * serveur de bêta. Derrière un tunnel ou un proxy, configurer `trust proxy`
 * (décision D-10), sinon tous les clients partagent la même limite.
 */
export function createRateLimiter({ windowMs, max, now = Date.now }: RateLimiterOptions): RequestHandler {
  const windows = new Map<string, { count: number; resetAtMs: number }>();

  return (req, res, next) => {
    const currentMs = now();
    if (windows.size > MAX_TRACKED_KEYS) {
      for (const [key, entry] of windows) if (entry.resetAtMs <= currentMs) windows.delete(key);
    }

    const key = req.ip ?? 'inconnu';
    let entry = windows.get(key);
    if (entry === undefined || entry.resetAtMs <= currentMs) {
      entry = { count: 0, resetAtMs: currentMs + windowMs };
      windows.set(key, entry);
    }
    entry.count += 1;

    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAtMs - currentMs) / 1000)));
      next(
        new AppError({
          code: 'RATE_LIMITED',
          stage: 'request',
          httpStatus: 429,
          retryable: true,
          message: 'Trop de demandes en peu de temps. Réessayez un peu plus tard.',
        }),
      );
      return;
    }
    next();
  };
}
