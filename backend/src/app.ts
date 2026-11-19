import cors, { type CorsOptions } from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { createAuthGuards } from './auth/auth.middleware.ts';
import { createFirebaseTokenVerifier, type TokenVerifier } from './auth/firebase-token.ts';
import { createMediaUrlSigner } from './auth/media-url.ts';
import type { AppConfig } from './config/env.ts';
import { createAnalysisProviders } from './providers/index.ts';
import type { AnalysisProviders, FetchLike } from './providers/types.ts';
import { createRenderJobRepository } from './repositories/job.repository.ts';
import { createProjectRepository } from './repositories/project.repository.ts';
import { createAuthRouter } from './routes/auth.routes.ts';
import { createMediaRouter } from './routes/media.routes.ts';
import { createProjectsRouter } from './routes/projects.routes.ts';
import { createRenderRouter } from './routes/render.routes.ts';
import { createSystemRouter } from './routes/system.routes.ts';
import { createAnalysisService } from './services/analysis.service.ts';
import { createBrollMediaStore } from './services/broll-media.service.ts';
import { createProjectDeletion } from './services/project-deletion.service.ts';
import { createProjectService } from './services/project.service.ts';
import { createRenderService } from './services/render.service.ts';
import { createUploadService } from './services/upload.service.ts';
import { createLocalStorage } from './storage/local-storage.ts';
import type { BinaryStatus } from './utils/binaries.ts';
import { errorHandler, notFoundHandler } from './utils/errors.ts';
import type { Logger } from './utils/logger.ts';
import { createRateLimiter } from './utils/rate-limit.ts';
import { REQUEST_ID_HEADER, requestContext } from './utils/request-context.ts';

/** Taille maximale d'un corps JSON : les modifications de timeline sont petites. */
const JSON_BODY_LIMIT = '1mb';
const ONE_HOUR_MS = 60 * 60 * 1000;

export interface AppDependencies {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly db: DatabaseSync;
  readonly binaries: { readonly ffmpeg: BinaryStatus; readonly ffprobe: BinaryStatus };
  /**
   * Fournisseurs de l'analyse ; injectés par les tests. Par défaut : selon la configuration
   * (réels, simulés en PROVIDER_MODE=mock, ou null s'ils ne sont pas configurés).
   */
  readonly providers?: AnalysisProviders | null;
  /** Accès réseau du serveur (vidéos B-roll, clés publiques de Google) ; remplacé dans les tests. */
  readonly fetch?: FetchLike;
  /** Vérification des jetons de connexion ; par défaut Firebase Authentication si AUTH_MODE=firebase. */
  readonly tokenVerifier?: TokenVerifier;
}

/**
 * Application Express, sans écoute réseau : testable telle quelle. Au démarrage, une
 * analyse ou une préparation d'export laissée en cours par un arrêt est marquée « interrompue ».
 */
export function createApp(deps: AppDependencies): Express {
  const { config, logger, db } = deps;
  const network = deps.fetch === undefined ? {} : { fetch: deps.fetch };
  const storage = createLocalStorage(config.paths.storageRoot);
  const repository = createProjectRepository(db);
  const renderJobs = createRenderJobRepository(db);
  const firebase = config.auth.mode === 'firebase' ? config.auth : null;
  const mediaUrls = firebase === null ? null : createMediaUrlSigner(firebase.mediaUrlSecret);
  const verifier =
    firebase === null ? null : (deps.tokenVerifier ?? createFirebaseTokenVerifier({ projectId: firebase.firebaseProjectId, ...network }));
  const projects = createProjectService({ config, projects: repository, renderJobs, mediaUrls });
  const media = createBrollMediaStore({ config, logger, storage, ...network });
  const uploads = createUploadService({ config, logger, storage, projects });
  const providers = deps.providers !== undefined ? deps.providers : createAnalysisProviders(config, logger);
  const analysis = createAnalysisService({ config, logger, storage, projects, repository, providers, media });
  const render = createRenderService({ config, logger, storage, projects, renderJobs, media });
  const deleteProject = createProjectDeletion({ logger, storage, projects, repository, media });
  const guards = createAuthGuards({ config, logger, projects, verifier, signer: mediaUrls });
  const interruptedAnalyses = analysis.recoverInterrupted();
  const interruptedRenders = render.recoverInterrupted();
  if (interruptedAnalyses + interruptedRenders > 0) {
    logger.warn('startup.work_interrupted', { analyses: interruptedAnalyses, renders: interruptedRenders });
  }
  const writeLimiter = createRateLimiter({ windowMs: ONE_HOUR_MS, max: config.limits.writesPerHour });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(requestContext(logger));
  app.use(noSniff);
  app.use(cors(buildCorsOptions(config.frontendOrigins)));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use('/api', createSystemRouter(deps));
  app.use('/api', createAuthRouter({ config, guards }));
  // Connexion (AUTH_MODE=firebase) : vérifiée avant toute route de projet ; sans effet sinon.
  app.post('/api/projects', guards.requireUser);
  app.use('/api/projects/:id', guards.requireProjectAccess);
  app.use('/api', createProjectsRouter({ projects, uploads, analysis, media, deleteProject, writeLimiter }));
  app.use('/api', createRenderRouter({ render, logger, writeLimiter }));
  app.use('/api', createMediaRouter({ projects, storage, logger }));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}

/** Interdit au navigateur de deviner un autre type que celui annoncé. */
const noSniff: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
};

function buildCorsOptions(allowedOrigins: readonly string[]): CorsOptions {
  const allowed = new Set(allowedOrigins);
  return {
    // Sans en-tête Origin (curl, tests), la requête passe : CORS ne remplace pas le contrôle d'accès.
    origin: (origin, callback) => {
      callback(null, origin === undefined || allowed.has(origin));
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: [REQUEST_ID_HEADER, 'Content-Disposition'],
    maxAge: 600,
  };
}
