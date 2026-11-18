import {
  BROLL_FITS,
  ID_PATTERN,
  PROJECT_RELATIVE_FILE_PATTERN,
  RENDER_JOB_RULES,
  SCHEMA_VERSION,
  TIMELINE_RULES,
} from '../../../shared/contract.ts';
import {
  nearlyEqual,
  Problems,
  readBoolean,
  readNumber,
  readOneOf,
  readString,
  requireArray,
  requireKeys,
  requireObject,
} from './core.ts';

const PAYLOAD_KEYS = ['schemaVersion', 'source', 'output', 'segments'] as const;
const SOURCE_KEYS = ['file', 'durationSeconds', 'width', 'height', 'frameRate', 'audioPresent'] as const;
const OUTPUT_KEYS = ['file', 'width', 'height', 'frameRate'] as const;
const SEGMENT_KEYS = ['brollItemId', 'candidateId', 'startSeconds', 'endSeconds', 'fit', 'media'] as const;
const MEDIA_KEYS = ['file', 'durationSeconds', 'width', 'height'] as const;

const MAX_OUTPUT_SHORT_SIDE = 1080;
const MAX_ASPECT_RATIO = 16 / 9;

/**
 * Valide le contenu de render_jobs.payload (RenderJobPayload) : instantané
 * immuable produit par le backend et consommé par le worker.
 *
 * Contrôles : chemins relatifs confinés, dimensions de sortie exploitables par
 * H.264/yuv420p, segments triés sans chevauchement, médias assez longs.
 */
export function validateRenderJobPayload(value: unknown): string[] {
  const problems = new Problems();
  const payload = requireObject(value, 'payload', problems);
  if (payload === null) return problems.list;

  requireKeys(payload, 'payload', PAYLOAD_KEYS, [], problems);
  const schemaVersion = readNumber(payload, 'schemaVersion', 'payload', problems, { integer: true });
  if (schemaVersion !== null && schemaVersion !== SCHEMA_VERSION) {
    problems.add('payload.schemaVersion', `attendu ${SCHEMA_VERSION}, reçu ${schemaVersion}`);
  }

  const source = validateSource(payload.source, 'payload.source', problems);
  validateOutput(payload.output, 'payload.output', problems, source);

  const segments = requireArray(payload.segments, 'payload.segments', problems);
  if (segments !== null) {
    if (segments.length === 0) problems.add('payload.segments', 'au moins un segment est requis (RENDER_NO_SEGMENTS)');
    if (segments.length > TIMELINE_RULES.maxBrollItems) {
      problems.add('payload.segments', `au plus ${TIMELINE_RULES.maxBrollItems} segments (reçu ${segments.length})`);
    }

    const sourceDuration = source?.durationSeconds ?? null;
    let previousEnd = -1;
    segments.forEach((segment, index) => {
      const path = `payload.segments[${index}]`;
      const object = requireObject(segment, path, problems);
      if (object === null) return;

      requireKeys(object, path, SEGMENT_KEYS, [], problems);
      readString(object, 'brollItemId', path, problems, { pattern: ID_PATTERN, maxLength: 64 });
      readString(object, 'candidateId', path, problems, { pattern: ID_PATTERN, maxLength: 64 });
      const start = readNumber(object, 'startSeconds', path, problems, { min: 0, msPrecision: true });
      const end = readNumber(object, 'endSeconds', path, problems, { min: 0, msPrecision: true });
      readOneOf(object, 'fit', path, problems, BROLL_FITS);

      const media = validateMedia(object.media, `${path}.media`, problems);
      if (start !== null && end !== null) {
        const duration = end - start;
        if (start >= end) {
          problems.add(path, `intervalle invalide (${start} ≥ ${end})`);
        } else {
          if (duration < TIMELINE_RULES.minSegmentSeconds - 1e-9) {
            problems.add(path, `durée ${duration} s < minimum ${TIMELINE_RULES.minSegmentSeconds} s`);
          }
          if (duration > TIMELINE_RULES.maxSegmentSeconds + 1e-9) {
            problems.add(path, `durée ${duration} s > maximum ${TIMELINE_RULES.maxSegmentSeconds} s`);
          }
          if (sourceDuration !== null && end > sourceDuration + 1e-9) {
            problems.add(`${path}.endSeconds`, `dépasse la durée de la source (${sourceDuration} s)`);
          }
          if (previousEnd >= 0 && start < previousEnd - 1e-9) {
            problems.add(`${path}.startSeconds`, 'segments non triés ou chevauchants');
          }
          if (media !== null && duration > media.durationSeconds + 0.05) {
            problems.add(path, `durée ${duration} s > durée du média (${media.durationSeconds} s)`);
          }
        }
        previousEnd = Math.max(previousEnd, end);
      }
    });
  }

  return problems.list;
}

interface SourceSummary {
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
}

function validateSource(value: unknown, path: string, problems: Problems): SourceSummary | null {
  const before = problems.count;
  const source = requireObject(value, path, problems);
  if (source === null) return null;

  requireKeys(source, path, SOURCE_KEYS, [], problems);
  const file = readString(source, 'file', path, problems, { pattern: PROJECT_RELATIVE_FILE_PATTERN, maxLength: 128 });
  if (file !== null && !file.startsWith('source/')) {
    problems.add(`${path}.file`, 'doit se trouver dans le dossier source/');
  }
  const duration = readNumber(source, 'durationSeconds', path, problems, { min: 0.001 });
  const width = readNumber(source, 'width', path, problems, { integer: true, min: 2 });
  const height = readNumber(source, 'height', path, problems, { integer: true, min: 2 });
  const frameRate = readNumber(source, 'frameRate', path, problems, { min: 1, max: 120 });
  readBoolean(source, 'audioPresent', path, problems);

  if (problems.count !== before || duration === null || width === null || height === null || frameRate === null) return null;
  return { durationSeconds: duration, width, height, frameRate };
}

interface OutputSummary {
  width: number;
  height: number;
  frameRate: number;
}

function validateOutput(
  value: unknown,
  path: string,
  problems: Problems,
  source: SourceSummary | null,
): OutputSummary | null {
  const before = problems.count;
  const output = requireObject(value, path, problems);
  if (output === null) return null;

  requireKeys(output, path, OUTPUT_KEYS, [], problems);
  const file = readString(output, 'file', path, problems, { pattern: PROJECT_RELATIVE_FILE_PATTERN, maxLength: 128 });
  if (file !== null && !file.startsWith('output/')) {
    problems.add(`${path}.file`, 'doit se trouver dans le dossier output/');
  }
  const width = readNumber(output, 'width', path, problems, { integer: true, min: 2 });
  const height = readNumber(output, 'height', path, problems, { integer: true, min: 2 });
  const frameRate = readNumber(output, 'frameRate', path, problems, { min: 1, max: 60 });

  if (width !== null && height !== null) {
    if (width % 2 !== 0 || height % 2 !== 0) {
      problems.add(path, `dimensions paires attendues pour H.264/yuv420p (reçu ${width} × ${height})`);
    }
    const shortSide = Math.min(width, height);
    const longSide = Math.max(width, height);
    if (shortSide > MAX_OUTPUT_SHORT_SIDE) {
      problems.add(path, `petit côté ${shortSide} > ${MAX_OUTPUT_SHORT_SIDE}`);
    }
    if (longSide / shortSide > MAX_ASPECT_RATIO + 0.01) {
      problems.add(path, `ratio ${(longSide / shortSide).toFixed(2)} > 16/9`);
    }
    if (source !== null) {
      const sourceRatio = source.width / source.height;
      if (Math.abs(width / height - sourceRatio) > sourceRatio * 0.01 + 0.001) {
        problems.add(path, `ratio ${width}×${height} différent de celui de la source ${source.width}×${source.height}`);
      }
      if (width > source.width + 2 || height > source.height + 2) {
        problems.add(path, 'dimensions supérieures à la source (suréchantillonnage interdit)');
      }
    }
  }

  if (frameRate !== null && source !== null) {
    const expected = Math.min(source.frameRate, 60);
    if (!nearlyEqual(frameRate, expected, 0.001)) {
      problems.add(`${path}.frameRate`, `attendu ${expected} (source plafonnée à 60), reçu ${frameRate}`);
    }
  }

  if (problems.count !== before || width === null || height === null || frameRate === null) return null;
  return { width, height, frameRate };
}

interface MediaSummary {
  durationSeconds: number;
  width: number;
  height: number;
}

function validateMedia(value: unknown, path: string, problems: Problems): MediaSummary | null {
  const before = problems.count;
  const media = requireObject(value, path, problems);
  if (media === null) return null;

  requireKeys(media, path, MEDIA_KEYS, [], problems);
  const file = readString(media, 'file', path, problems, { pattern: PROJECT_RELATIVE_FILE_PATTERN, maxLength: 128 });
  if (file !== null && !file.startsWith('broll/')) {
    problems.add(`${path}.file`, 'doit se trouver dans le dossier broll/');
  }
  const duration = readNumber(media, 'durationSeconds', path, problems, { min: 0.001 });
  const width = readNumber(media, 'width', path, problems, { integer: true, min: 2 });
  const height = readNumber(media, 'height', path, problems, { integer: true, min: 2 });

  if (problems.count !== before || duration === null || width === null || height === null) return null;
  return { durationSeconds: duration, width, height };
}

/**
 * Règles du cycle de vie d'un job (partagées backend/worker) : un job qui
 * dépasse maxAttempts ne doit jamais être repris, un bail expiré est repris
 * par recoverStale. Ces valeurs sont vérifiées par les tests de protocole.
 */
export const EXPECTED_JOB_RULES = {
  maxAttempts: RENDER_JOB_RULES.maxAttempts,
  leaseMs: RENDER_JOB_RULES.leaseMs,
  heartbeatMs: RENDER_JOB_RULES.heartbeatMs,
} as const;
