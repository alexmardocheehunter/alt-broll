import type { Request, RequestHandler, Response } from 'express';
import type { AppConfig } from '../config/env.ts';
import type { AuthUser } from '../contract.ts';
import { projectNotFound, type ProjectService } from '../services/project.service.ts';
import { AppError } from '../utils/errors.ts';
import type { Logger } from '../utils/logger.ts';
import { InvalidTokenError, SigningKeysUnavailableError, type TokenVerifier } from './firebase-token.ts';
import type { MediaUrlSigner, SignedResource } from './media-url.ts';

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

export interface AuthGuards {
  /** Compte du jeton présent, ou null (absent, invalide, ou connexion désactivée). */
  optionalUser(req: Request): Promise<AuthUser | null>;
  /** POST /api/projects : compte connecté exigé (mode firebase). */
  readonly requireUser: RequestHandler;
  /**
   * /api/projects/:id/… : compte propriétaire du projet (404 sinon, sans révéler son
   * existence), ou lien signé pour le lecteur vidéo et le téléchargement.
   */
  readonly requireProjectAccess: RequestHandler;
}

export interface AuthGuardsDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly projects: ProjectService;
  /** null quand AUTH_MODE=none. */
  readonly verifier: TokenVerifier | null;
  readonly signer: MediaUrlSigner | null;
}

/** Compte connecté de la requête en cours (posé par les gardes), ou null. */
export function currentUser(res: Response): AuthUser | null {
  const user: unknown = res.locals.user;
  return typeof user === 'object' && user !== null ? (user as AuthUser) : null;
}

export function createAuthGuards({ config, logger, projects, verifier, signer }: AuthGuardsDeps): AuthGuards {
  if (config.auth.mode === 'none' || verifier === null) {
    const pass: RequestHandler = (_req, _res, next) => next();
    return { optionalUser: async () => null, requireUser: pass, requireProjectAccess: pass };
  }
  const activeVerifier = verifier;

  /** Compte du jeton ; null si le jeton est refusé ; erreur 503 si les clés de Google sont injoignables. */
  async function verify(token: string): Promise<AuthUser | null> {
    try {
      return await activeVerifier.verify(token);
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        logger.debug('auth.token_rejected', { reason: error.message });
        return null;
      }
      if (error instanceof SigningKeysUnavailableError) {
        logger.error('auth.keys_unavailable', { err: error });
        throw new AppError({
          code: 'PROVIDER_UNAVAILABLE',
          stage: 'request',
          httpStatus: 503,
          retryable: true,
          message: 'La connexion est momentanément indisponible. Réessayez dans un instant.',
          cause: error,
        });
      }
      throw error;
    }
  }

  /** Compte du jeton, ou erreur 401 / 503. */
  async function authenticate(req: Request, res: Response): Promise<AuthUser> {
    const token = bearerToken(req);
    if (token === null) throw unauthorized(res, 'Connectez-vous avec votre compte Google pour continuer.');
    const user = await verify(token);
    if (user === null) throw unauthorized(res, 'Votre session a expiré : reconnectez-vous avec Google.');
    return user;
  }

  return {
    async optionalUser(req) {
      const token = bearerToken(req);
      return token === null ? null : verify(token);
    },

    requireUser: async (req, res, next) => {
      res.locals.user = await authenticate(req, res);
      next();
    },

    requireProjectAccess: async (req, res, next) => {
      const projectId = String(req.params.id ?? '');
      const resource = signedResourceOf(req);
      if (resource !== null && signer?.isValid(projectId, resource, req.query.exp, req.query.sig) === true) {
        next();
        return;
      }
      const user = await authenticate(req, res);
      if (projects.requireRecord(projectId).document.ownerId !== user.id) throw projectNotFound();
      res.locals.user = user;
      next();
    },
  };
}

function bearerToken(req: Request): string | null {
  const match = BEARER_PATTERN.exec(req.headers.authorization ?? '');
  return match?.[1] ?? null;
}

/** Seules la vidéo source et le MP4 final s'ouvrent par lien signé, en lecture. */
function signedResourceOf(req: Request): SignedResource | null {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  if (req.path === '/media/source') return 'source';
  if (req.path === '/download') return 'download';
  return null;
}

function unauthorized(res: Response, message: string): AppError {
  res.setHeader('WWW-Authenticate', 'Bearer');
  return new AppError({ code: 'UNAUTHORIZED', stage: 'request', httpStatus: 401, message });
}
