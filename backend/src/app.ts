import cors, { type CorsOptions } from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from './config/env.ts';
import { createRenderJobRepository } from './repositories/job.repository.ts';
import { createProjectRepository } from './repositories/project.repository.ts';
import { createMediaRouter } from './routes/media.routes.ts';
import { createProjectsRouter } from './routes/projects.routes.ts';
import { createSystemRouter } from './routes/system.routes.ts';
import { createProjectService } from './services/project.service.ts';
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
}

/** Application Express sans effet de bord (aucune écoute réseau) : testable telle quelle. */
export function createApp(deps: AppDependencies): Express {
  const { config, logger, db } = deps;
  const storage = createLocalStorage(config.paths.storageRoot);
  const projects = createProjectService({
    config,
    projects: createProjectRepository(db),
    renderJobs: createRenderJobRepository(db),
  });
  const uploads = createUploadService({ config, logger, storage, projects });
  const writeLimiter = createRateLimiter({ windowMs: ONE_HOUR_MS, max: config.limits.writesPerHour });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(requestContext(logger));
  app.use(noSniff);
  app.use(cors(buildCorsOptions(config.frontendOrigins)));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use('/api', createSystemRouter(deps));
  app.use('/api', createProjectsRouter({ projects, uploads, writeLimiter }));
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
