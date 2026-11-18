import {
  BROLL_FITS,
  ID_PATTERN,
  SCHEMA_VERSION,
  TIMELINE_RULES,
  UPLOAD_RULES,
  type HealthResponse,
} from '../../../shared/contract.ts';
import {
  checkSerializedNoLeak,
  isObject,
  Problems,
  readBoolean,
  readIsoDate,
  readNumber,
  readOneOf,
  readString,
  requireArray,
  requireKeys,
  requireObject,
  type JsonObject,
} from './core.ts';
import { validateApiErrorResponse, validateErrorInfo } from './errors.ts';
import {
  validateBrollItemsAndTimeline,
  validateProject,
  validateRenderState,
} from './project.ts';

function validateProjectEnvelope(value: unknown): string[] {
  const problems = new Problems();
  const response = requireObject(value, 'response', problems);
  if (response === null) return problems.list;
  requireKeys(response, 'response', ['project'], [], problems);
  for (const problem of validateProject(response.project)) problems.list.push(problem);
  return problems.list;
}

/** Réponse 201 de POST /api/projects. */
export function validateCreateProjectResponse(value: unknown): string[] {
  return validateProjectEnvelope(value);
}

/** Réponse 200 de POST /api/projects/:id/upload. */
export function validateUploadSourceResponse(value: unknown): string[] {
  return validateProjectEnvelope(value);
}

/** Réponse 200 de GET /api/projects/:id. */
export function validateGetProjectResponse(value: unknown): string[] {
  return validateProjectEnvelope(value);
}

/** Réponse 200 de PATCH /api/projects/:id/timeline. */
export function validateUpdateTimelineResponse(value: unknown): string[] {
  return validateProjectEnvelope(value);
}

/** GET /api/health. */
export function validateHealthResponse(value: unknown): string[] {
  const problems = new Problems();
  const health = requireObject(value, 'health', problems);
  if (health === null) return problems.list;

  requireKeys(health, 'health', ['status', 'service', 'schemaVersion', 'time', 'uptimeSeconds', 'checks', 'providers'], [], problems);
  readOneOf(health, 'status', 'health', problems, ['ok', 'degraded'] as const);
  readString(health, 'service', 'health', problems, { pattern: /^alt-broll-backend$/ });
  const schemaVersion = readNumber(health, 'schemaVersion', 'health', problems, { integer: true });
  if (schemaVersion !== null && schemaVersion !== SCHEMA_VERSION) {
    problems.add('health.schemaVersion', `attendu ${SCHEMA_VERSION}`);
  }
  readIsoDate(health, 'time', 'health', problems);
  readNumber(health, 'uptimeSeconds', 'health', problems, { min: 0 });

  const checks = checksObject(health.checks, 'health.checks', problems);
  if (checks !== null) {
    const database = readOneOf(checks, 'database', 'health.checks', problems, ['ok', 'error'] as const);
    const ffmpeg = readOneOf(checks, 'ffmpeg', 'health.checks', problems, ['ok', 'missing'] as const);
    const ffprobe = readOneOf(checks, 'ffprobe', 'health.checks', problems, ['ok', 'missing'] as const);
    const status = health.status;
    if (status === 'ok' && (database !== 'ok' || ffmpeg !== 'ok' || ffprobe !== 'ok')) {
      problems.add('health.status', 'ok exige toutes les vérifications à ok');
    }
    if (status === 'degraded' && database === 'ok' && ffmpeg === 'ok' && ffprobe === 'ok') {
      problems.add('health.status', 'degraded incohérent avec des vérifications toutes ok');
    }
  }

  const providers = providersObject(health.providers, 'health.providers', problems);
  if (providers !== null) {
    readBoolean(providers, 'groq', 'health.providers', problems);
    readBoolean(providers, 'openrouter', 'health.providers', problems);
    readBoolean(providers, 'pixabay', 'health.providers', problems);
  }

  checkSerializedNoLeak(JSON.stringify(health), 'health', problems);
  return problems.list;
}

/** GET /api/config. */
export function validatePublicConfigResponse(value: unknown): string[] {
  const problems = new Problems();
  const config = requireObject(value, 'config', problems);
  if (config === null) return problems.list;

  requireKeys(config, 'config', ['schemaVersion', 'upload', 'timeline', 'fits'], [], problems);
  const schemaVersion = readNumber(config, 'schemaVersion', 'config', problems, { integer: true });
  if (schemaVersion !== null && schemaVersion !== SCHEMA_VERSION) {
    problems.add('config.schemaVersion', `attendu ${SCHEMA_VERSION}`);
  }

  const upload = requireObject(config.upload, 'config.upload', problems);
  if (upload !== null) {
    requireKeys(
      upload,
      'config.upload',
      ['fieldName', 'maxBytes', 'minDurationSeconds', 'maxDurationSeconds', 'acceptedMimeTypes', 'acceptedExtensions'],
      [],
      problems,
    );
    readString(upload, 'fieldName', 'config.upload', problems, { pattern: new RegExp(`^${UPLOAD_RULES.fieldName}$`) });
    const maxBytes = readNumber(upload, 'maxBytes', 'config.upload', problems, { integer: true, min: 1 });
    const minDuration = readNumber(upload, 'minDurationSeconds', 'config.upload', problems, { min: 1 });
    const maxDuration = readNumber(upload, 'maxDurationSeconds', 'config.upload', problems, { min: 1 });
    if (maxBytes !== null && maxBytes % (1024 * 1024) !== 0) {
      problems.add('config.upload.maxBytes', 'doit être un nombre entier de Mio');
    }
    if (minDuration !== null && maxDuration !== null && minDuration >= maxDuration) {
      problems.add('config.upload', 'minDurationSeconds doit être inférieure à maxDurationSeconds');
    }
    const mimeTypes = requireArray(upload.acceptedMimeTypes, 'config.upload.acceptedMimeTypes', problems);
    if (mimeTypes !== null) {
      if (!mimeTypes.includes('video/mp4')) problems.add('config.upload.acceptedMimeTypes', 'video/mp4 doit être accepté');
      for (const mime of mimeTypes) {
        if (typeof mime !== 'string') problems.add('config.upload.acceptedMimeTypes', 'chaînes attendues');
      }
    }
    const extensions = requireArray(upload.acceptedExtensions, 'config.upload.acceptedExtensions', problems);
    if (extensions !== null && !extensions.includes('.mp4')) {
      problems.add('config.upload.acceptedExtensions', '.mp4 doit être accepté');
    }
  }

  const timeline = requireObject(config.timeline, 'config.timeline', problems);
  if (timeline !== null) {
    for (const [key, expected] of Object.entries(TIMELINE_RULES)) {
      const actual = readNumber(timeline, key, 'config.timeline', problems, { min: 0 });
      if (actual !== null && actual !== expected) {
        problems.add(`config.timeline.${key}`, `doit être ${expected} (reçu ${actual})`);
      }
    }
  }

  const fits = requireArray(config.fits, 'config.fits', problems);
  if (fits !== null) {
    if (fits.length !== BROLL_FITS.length || fits.some((fit, index) => fit !== BROLL_FITS[index])) {
      problems.add('config.fits', `attendu [${BROLL_FITS.join(', ')}]`);
    }
  }

  return problems.list;
}

/** GET /api/projects/:id/status et réponse 202 de POST …/analyze. */
export function validateProjectStatusResponse(value: unknown): string[] {
  const problems = new Problems();
  const response = requireObject(value, 'status', problems);
  if (response === null) return problems.list;

  requireKeys(response, 'status', ['projectId', 'revision', 'sourceUploaded', 'analysis', 'render'], [], problems);
  readString(response, 'projectId', 'status', problems, { pattern: ID_PATTERN, maxLength: 64 });
  readNumber(response, 'revision', 'status', problems, { integer: true, min: 0 });
  readBoolean(response, 'sourceUploaded', 'status', problems);

  const analysis = requireObject(response.analysis, 'status.analysis', problems);
  if (analysis !== null) {
    requireKeys(analysis, 'status.analysis', ['status', 'stage', 'error'], [], problems);
    const status = readOneOf(analysis, 'status', 'status.analysis', problems, ['idle', 'queued', 'processing', 'completed', 'failed'] as const);
    if ('stage' in analysis && analysis.stage !== null) {
      readOneOf(analysis, 'stage', 'status.analysis', problems, ['extracting_audio', 'transcribing', 'extracting_keyframes', 'analyzing_content', 'searching_broll'] as const);
      if (status !== 'processing') problems.add('status.analysis.stage', 'doit être null hors processing');
    } else if (status === 'processing') {
      problems.add('status.analysis.stage', 'doit être renseigné quand status = processing');
    }
    if ('error' in analysis && analysis.error !== null) {
      for (const problem of validateErrorInfo(analysis.error, 'status.analysis.error')) problems.list.push(problem);
      if (status !== 'failed') problems.add('status.analysis.error', 'doit être null hors failed');
    } else if (status === 'failed') {
      problems.add('status.analysis.error', 'doit être renseigné quand status = failed');
    }
  }

  const render = requireObject(response.render, 'status.render', problems);
  if (render !== null) {
    requireKeys(render, 'status.render', ['status', 'progress', 'error'], [], problems);
    readOneOf(render, 'status', 'status.render', problems, ['idle', 'preparing', 'queued', 'rendering', 'completed', 'failed'] as const);
    readNumber(render, 'progress', 'status.render', problems, { min: 0, max: 1 });
    if ('error' in render && render.error !== null) {
      for (const problem of validateErrorInfo(render.error, 'status.render.error')) problems.list.push(problem);
    }
  }

  return problems.list;
}

/** GET /api/projects/:id/suggestions. */
export function validateSuggestionsResponse(value: unknown): string[] {
  const problems = new Problems();
  const response = requireObject(value, 'suggestions', problems);
  if (response === null) return problems.list;

  requireKeys(response, 'suggestions', ['projectId', 'revision', 'visualAnalysisAvailable', 'brollItems', 'timeline'], [], problems);
  readString(response, 'projectId', 'suggestions', problems, { pattern: ID_PATTERN, maxLength: 64 });
  readNumber(response, 'revision', 'suggestions', problems, { integer: true, min: 0 });
  readBoolean(response, 'visualAnalysisAvailable', 'suggestions', problems);
  for (const problem of validateBrollItemsAndTimeline(response.brollItems, response.timeline)) {
    problems.list.push(problem);
  }
  return problems.list;
}

/** POST /api/projects/:id/render (202). */
export function validateStartRenderResponse(value: unknown): string[] {
  const problems = new Problems();
  const response = requireObject(value, 'renderResponse', problems);
  if (response === null) return problems.list;
  requireKeys(response, 'renderResponse', ['render'], [], problems);
  for (const problem of validateRenderState(response.render)) problems.list.push(problem);
  return problems.list;
}

/** GET /api/projects/:id/render/status. */
export function validateRenderStatusResponse(value: unknown): string[] {
  const problems = new Problems();
  const response = requireObject(value, 'renderStatus', problems);
  if (response === null) return problems.list;

  requireKeys(response, 'renderStatus', ['projectId', 'projectRevision', 'render'], [], problems);
  readString(response, 'projectId', 'renderStatus', problems, { pattern: ID_PATTERN, maxLength: 64 });
  const projectRevision = readNumber(response, 'projectRevision', 'renderStatus', problems, { integer: true, min: 0 });
  for (const problem of validateRenderState(response.render)) problems.list.push(problem);

  const render = isObject(response.render) ? response.render : null;
  if (render !== null && projectRevision !== null && typeof render.revision === 'number' && render.revision > projectRevision) {
    problems.add('renderStatus.render.revision', 'postérieure à projectRevision');
  }
  return problems.list;
}

/** Réponse d'erreur, exposée pour les tests d'intégration. */
export { validateApiErrorResponse };

function checksObject(value: unknown, path: string, problems: Problems): JsonObject | null {
  const checks = requireObject(value, path, problems);
  if (checks === null) return null;
  requireKeys(checks, path, ['database', 'ffmpeg', 'ffprobe'], [], problems);
  return checks;
}

function providersObject(value: unknown, path: string, problems: Problems): JsonObject | null {
  const providers = requireObject(value, path, problems);
  if (providers === null) return null;
  requireKeys(providers, path, ['groq', 'openrouter', 'pixabay'], [], problems);
  return providers;
}

/** Type attendu par validateHealthResponse (documentation exécutable). */
export type ValidatedHealth = HealthResponse;
