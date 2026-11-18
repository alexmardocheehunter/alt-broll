import { Router } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { AppDependencies } from '../app.ts';
import { configuredProviders } from '../config/env.ts';
import {
  BROLL_FITS,
  SCHEMA_VERSION,
  TIMELINE_RULES,
  UPLOAD_RULES,
  type HealthResponse,
  type PublicConfigResponse,
} from '../contract.ts';

/** Routes techniques : santé du serveur et règles publiques pour l'interface. */
export function createSystemRouter(deps: AppDependencies): Router {
  const { config, db, binaries } = deps;
  const startedAtMs = Date.now();
  const router = Router();

  router.get('/health', (_req, res) => {
    const database = isDatabaseHealthy(db) ? 'ok' : 'error';
    const healthy = database === 'ok' && binaries.ffmpeg.available && binaries.ffprobe.available;
    const body: HealthResponse = {
      status: healthy ? 'ok' : 'degraded',
      service: 'alt-broll-backend',
      schemaVersion: SCHEMA_VERSION,
      time: new Date().toISOString(),
      uptimeSeconds: Math.round((Date.now() - startedAtMs) / 1000),
      checks: {
        database,
        ffmpeg: binaries.ffmpeg.available ? 'ok' : 'missing',
        ffprobe: binaries.ffprobe.available ? 'ok' : 'missing',
      },
      providers: configuredProviders(config),
    };
    res.status(healthy ? 200 : 503).json(body);
  });

  router.get('/config', (_req, res) => {
    const body: PublicConfigResponse = {
      schemaVersion: SCHEMA_VERSION,
      upload: {
        fieldName: UPLOAD_RULES.fieldName,
        maxBytes: config.limits.maxUploadBytes,
        minDurationSeconds: config.limits.minVideoDurationSeconds,
        maxDurationSeconds: config.limits.maxVideoDurationSeconds,
        acceptedMimeTypes: UPLOAD_RULES.acceptedMimeTypes,
        acceptedExtensions: UPLOAD_RULES.acceptedExtensions,
      },
      timeline: TIMELINE_RULES,
      fits: BROLL_FITS,
    };
    res.json(body);
  });

  return router;
}

function isDatabaseHealthy(db: DatabaseSync): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}
