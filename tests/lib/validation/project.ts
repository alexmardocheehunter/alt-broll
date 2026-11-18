import {
  ANALYSIS_STAGES,
  ANALYSIS_STATUSES,
  BROLL_FITS,
  BROLL_ITEM_STATUSES,
  BROLL_PROVIDERS,
  ID_PATTERN,
  RENDER_STATUSES,
  SCHEMA_VERSION,
  TIMELINE_RULES,
  type AnalysisStage,
  type BrollFit,
  type BrollItemStatus,
} from '../../../shared/contract.ts';
import {
  checkNoLeak,
  isMillisecondPrecise,
  nearlyEqual,
  Problems,
  readBoolean,
  readIsoDate,
  readNumber,
  readOneOf,
  readString,
  readUrl,
  requireArray,
  requireKeys,
  requireObject,
  type JsonObject,
} from './core.ts';
import { validateErrorInfo } from './errors.ts';

const SOURCE_KEYS = [
  'originalName',
  'storedFileName',
  'mimeType',
  'sizeBytes',
  'durationSeconds',
  'width',
  'height',
  'frameRate',
  'videoCodec',
  'audioPresent',
  'audioCodec',
] as const;

const TRANSCRIPT_KEYS = ['provider', 'model', 'language', 'text', 'segments', 'words'] as const;
const ANALYSIS_KEYS = [
  'status',
  'stage',
  'model',
  'visualAnalysisAvailable',
  'keyframes',
  'summary',
  'startedAt',
  'completedAt',
  'error',
] as const;
const CANDIDATE_KEYS = [
  'id',
  'provider',
  'providerMediaId',
  'title',
  'previewUrl',
  'downloadUrl',
  'sourcePageUrl',
  'thumbnailUrl',
  'durationSeconds',
  'width',
  'height',
  'attribution',
] as const;
const ITEM_KEYS = [
  'id',
  'startSeconds',
  'endSeconds',
  'reason',
  'searchQuery',
  'candidates',
  'selectedCandidateId',
  'status',
  'fit',
  'enabled',
] as const;
const SEGMENT_KEYS = ['brollItemId', 'candidateId', 'startSeconds', 'endSeconds', 'fit'] as const;
const RENDER_KEYS = [
  'status',
  'jobId',
  'revision',
  'progress',
  'outputFile',
  'startedAt',
  'completedAt',
  'error',
] as const;

export interface SourceSummary {
  durationSeconds: number;
  frameRate: number;
}

export interface ItemSummary {
  id: string;
  startSeconds: number;
  endSeconds: number;
  fit: BrollFit;
  status: BrollItemStatus;
  enabled: boolean;
  selectedCandidateId: string | null;
  candidateIds: readonly string[];
}

export interface SegmentSummary {
  brollItemId: string;
  candidateId: string;
  startSeconds: number;
  endSeconds: number;
  fit: BrollFit;
}

/**
 * Valide une réponse Project complète (GET /api/projects/:id, upload, PATCH…).
 * Renvoie [] si l'objet respecte shared/contract.ts et ses règles sémantiques.
 */
export function validateProject(value: unknown): string[] {
  const problems = new Problems();
  const project = requireObject(value, 'project', problems);
  if (project === null) return problems.list;

  requireKeys(
    project,
    'project',
    ['id', 'schemaVersion', 'revision', 'createdAt', 'updatedAt', 'source', 'transcript', 'analysis', 'brollItems', 'timeline', 'render', 'urls'],
    [],
    problems,
  );

  readString(project, 'id', 'project', problems, { pattern: ID_PATTERN, maxLength: 64 });
  const schemaVersion = readNumber(project, 'schemaVersion', 'project', problems, { integer: true });
  if (schemaVersion !== null && schemaVersion !== SCHEMA_VERSION) {
    problems.add('project.schemaVersion', `attendu ${SCHEMA_VERSION}, reçu ${schemaVersion}`);
  }
  const revision = readNumber(project, 'revision', 'project', problems, { integer: true, min: 0 });
  const createdAt = readIsoDate(project, 'createdAt', 'project', problems);
  const updatedAt = readIsoDate(project, 'updatedAt', 'project', problems);
  if (createdAt !== null && updatedAt !== null && Date.parse(updatedAt) < Date.parse(createdAt)) {
    problems.add('project.updatedAt', 'antérieure à createdAt');
  }

  const sourceAbsent = project.source === null;
  const source = sourceAbsent ? null : validateSource(project.source, 'project.source', problems);
  const sourceDuration = source?.durationSeconds ?? null;

  if (project.transcript !== null && sourceAbsent) {
    problems.add('project.transcript', 'doit être null tant que la source n’est pas importée');
  }
  if (project.transcript !== null) {
    validateTranscript(project.transcript, 'project.transcript', sourceDuration, problems);
  }

  validateAnalysis(project.analysis, 'project.analysis', sourceDuration, problems);

  const itemsBefore = problems.count;
  const items = validateBrollItems(project.brollItems, 'project.brollItems', sourceDuration, sourceAbsent, problems);
  const itemsClean = problems.count === itemsBefore;

  const timelineBefore = problems.count;
  const segments = validateTimeline(project.timeline, 'project.timeline', sourceDuration, problems);
  const timelineClean = problems.count === timelineBefore;

  if (itemsClean && timelineClean && items !== null && segments !== null) {
    compareTimeline(items, segments, problems);
  }

  const renderBefore = problems.count;
  const renderStatus = validateRender(project.render, 'project.render', source, revision, problems);
  const renderClean = problems.count === renderBefore;

  validateUrls(project.urls, 'project.urls', !sourceAbsent, renderClean ? renderStatus : null, problems);

  if (sourceAbsent) {
    const analysis = project.analysis;
    if (typeof analysis === 'object' && analysis !== null && (analysis as JsonObject).status !== 'idle') {
      problems.add('project.analysis.status', 'doit être idle sans vidéo source');
    }
    if (typeof project.render === 'object' && project.render !== null && (project.render as JsonObject).status !== 'idle') {
      problems.add('project.render.status', 'doit être idle sans vidéo source');
    }
  }

  return problems.list;
}

function validateSource(value: unknown, path: string, problems: Problems): SourceSummary | null {
  const before = problems.count;
  const source = requireObject(value, path, problems);
  if (source === null) return null;

  requireKeys(source, path, SOURCE_KEYS, [], problems);
  readString(source, 'originalName', path, problems, { maxLength: 255 });
  readString(source, 'storedFileName', path, problems, {
    pattern: /^[A-Za-z0-9_-]{1,64}\.mp4$/,
    maxLength: 69,
  });
  readString(source, 'mimeType', path, problems, { pattern: /^video\/mp4$/ });
  readNumber(source, 'sizeBytes', path, problems, { integer: true, min: 1 });
  const duration = readNumber(source, 'durationSeconds', path, problems, { min: 0.001 });
  readNumber(source, 'width', path, problems, { integer: true, min: 2 });
  readNumber(source, 'height', path, problems, { integer: true, min: 2 });
  const frameRate = readNumber(source, 'frameRate', path, problems, { min: 1, max: 120 });
  readString(source, 'videoCodec', path, problems, { maxLength: 32 });
  const audioPresent = readBoolean(source, 'audioPresent', path, problems);
  const audioCodec = source.audioCodec === null ? null : readString(source, 'audioCodec', path, problems, { maxLength: 32 });

  if (audioPresent === true && audioCodec === null) {
    problems.add(`${path}.audioCodec`, 'doit être renseigné quand audioPresent = true');
  }
  if (audioPresent === false && audioCodec !== null) {
    problems.add(`${path}.audioCodec`, 'doit être null quand audioPresent = false');
  }

  if (problems.count !== before || duration === null || frameRate === null) return null;
  return { durationSeconds: duration, frameRate };
}

function validateTranscript(value: unknown, path: string, sourceDuration: number | null, problems: Problems): void {
  const transcript = requireObject(value, path, problems);
  if (transcript === null) return;

  requireKeys(transcript, path, TRANSCRIPT_KEYS, [], problems);
  readString(transcript, 'provider', path, problems, { pattern: /^groq$/ });
  readString(transcript, 'model', path, problems, { maxLength: 64 });
  readString(transcript, 'language', path, problems, { pattern: /^[a-z]{2}(?:-[A-Z]{2})?$/ });
  readString(transcript, 'text', path, problems);

  const segments = requireArray(transcript.segments, `${path}.segments`, problems);
  if (segments !== null) {
    let previousEnd = 0;
    segments.forEach((segment, index) => {
      const segmentPath = `${path}.segments[${index}]`;
      const object = requireObject(segment, segmentPath, problems);
      if (object === null) return;
      requireKeys(object, segmentPath, ['startSeconds', 'endSeconds', 'text'], [], problems);
      const start = readNumber(object, 'startSeconds', segmentPath, problems, { min: 0, msPrecision: true });
      const end = readNumber(object, 'endSeconds', segmentPath, problems, { min: 0, msPrecision: true });
      readString(object, 'text', segmentPath, problems);
      if (start !== null && end !== null) {
        if (start >= end) problems.add(segmentPath, `intervalle invalide (${start} ≥ ${end})`);
        if (sourceDuration !== null && end > sourceDuration + 0.5) {
          problems.add(`${segmentPath}.endSeconds`, `dépasse la durée de la source (${sourceDuration} s)`);
        }
        if (index > 0 && start < previousEnd - 0.05) {
          problems.add(`${segmentPath}.startSeconds`, 'chevauche le segment précédent');
        }
        previousEnd = Math.max(previousEnd, end);
      }
    });
  }

  const words = requireArray(transcript.words, `${path}.words`, problems);
  if (words !== null) {
    let previousEnd = 0;
    words.forEach((word, index) => {
      const wordPath = `${path}.words[${index}]`;
      const object = requireObject(word, wordPath, problems);
      if (object === null) return;
      requireKeys(object, wordPath, ['startSeconds', 'endSeconds', 'word'], [], problems);
      const start = readNumber(object, 'startSeconds', wordPath, problems, { min: 0 });
      const end = readNumber(object, 'endSeconds', wordPath, problems, { min: 0 });
      readString(object, 'word', wordPath, problems);
      if (start !== null && end !== null) {
        if (start > end) problems.add(wordPath, `intervalle invalide (${start} > ${end})`);
        if (sourceDuration !== null && end > sourceDuration + 0.5) {
          problems.add(`${wordPath}.endSeconds`, 'dépasse la durée de la source');
        }
        if (index > 0 && start < previousEnd - 0.05) {
          problems.add(`${wordPath}.startSeconds`, 'chevauche le mot précédent');
        }
        previousEnd = Math.max(previousEnd, end);
      }
    });
  }
}

function validateAnalysis(value: unknown, path: string, sourceDuration: number | null, problems: Problems): void {
  const analysis = requireObject(value, path, problems);
  if (analysis === null) return;

  requireKeys(analysis, path, ANALYSIS_KEYS, [], problems);
  const status = readOneOf(analysis, 'status', path, problems, ANALYSIS_STATUSES);
  const stage: AnalysisStage | null = analysis.stage === null
    ? null
    : readOneOf(analysis, 'stage', path, problems, ANALYSIS_STAGES);
  if (status === 'processing' && stage === null) {
    problems.add(`${path}.stage`, 'doit être renseigné quand status = processing');
  }
  if (status !== 'processing' && 'stage' in analysis && analysis.stage !== null) {
    problems.add(`${path}.stage`, 'doit être null hors processing');
  }
  const model = analysis.model === null ? null : readString(analysis, 'model', path, problems, { maxLength: 128 });
  const visual = readBoolean(analysis, 'visualAnalysisAvailable', path, problems);
  const keyframes = requireArray(analysis.keyframes, `${path}.keyframes`, problems);
  let keyframeCount = 0;
  if (keyframes !== null) {
    keyframeCount = keyframes.length;
    if (keyframes.length > 12) problems.add(`${path}.keyframes`, `au plus 12 images (reçu ${keyframes.length})`);
    const seen = new Set<number>();
    keyframes.forEach((keyframe, index) => {
      const keyframePath = `${path}.keyframes[${index}]`;
      const object = requireObject(keyframe, keyframePath, problems);
      if (object === null) return;
      requireKeys(object, keyframePath, ['index', 'timeSeconds'], [], problems);
      const keyframeIndex = readNumber(object, 'index', keyframePath, problems, { integer: true, min: 0, max: 11 });
      const time = readNumber(object, 'timeSeconds', keyframePath, problems, { min: 0 });
      if (keyframeIndex !== null) {
        if (seen.has(keyframeIndex)) problems.add(`${keyframePath}.index`, `index ${keyframeIndex} en double`);
        seen.add(keyframeIndex);
      }
      if (time !== null && sourceDuration !== null && time > sourceDuration + 0.001) {
        problems.add(`${keyframePath}.timeSeconds`, `dépasse la durée de la source (${sourceDuration} s)`);
      }
    });
  }
  const summary = analysis.summary === null ? null : readString(analysis, 'summary', path, problems, { maxLength: 1000 });
  const startedAt = analysis.startedAt === null ? null : readIsoDate(analysis, 'startedAt', path, problems);
  const completedAt = analysis.completedAt === null ? null : readIsoDate(analysis, 'completedAt', path, problems);
  const hasError = 'error' in analysis && analysis.error !== null;
  if (hasError) {
    for (const problem of validateErrorInfo(analysis.error, `${path}.error`)) problems.list.push(problem);
  }

  if (status === 'completed') {
    if (model === null) problems.add(`${path}.model`, 'doit être renseigné quand status = completed');
    if (summary === null) problems.add(`${path}.summary`, 'doit être renseigné quand status = completed');
    if (completedAt === null) problems.add(`${path}.completedAt`, 'doit être renseigné quand status = completed');
    if (visual === true && keyframeCount === 0) {
      problems.add(`${path}.visualAnalysisAvailable`, 'true exige au moins une image effectivement analysée');
    }
    if (hasError) problems.add(`${path}.error`, 'doit être null quand status = completed');
  }
  if (status === 'failed' && !hasError) {
    problems.add(`${path}.error`, 'doit être renseigné quand status = failed');
  }
  if (status !== 'failed' && hasError) {
    problems.add(`${path}.error`, 'doit être null hors status = failed');
  }
  if (status === 'completed' && startedAt !== null && completedAt !== null && Date.parse(completedAt) < Date.parse(startedAt)) {
    problems.add(`${path}.completedAt`, 'antérieure à startedAt');
  }
}

interface CandidateSummary {
  id: string;
  durationSeconds: number;
}

function validateCandidate(value: unknown, path: string, problems: Problems): CandidateSummary | null {
  const before = problems.count;
  const candidate = requireObject(value, path, problems);
  if (candidate === null) return null;

  requireKeys(candidate, path, CANDIDATE_KEYS, [], problems);
  const id = readString(candidate, 'id', path, problems, { pattern: ID_PATTERN, maxLength: 64 });
  readOneOf(candidate, 'provider', path, problems, BROLL_PROVIDERS);
  readString(candidate, 'providerMediaId', path, problems, { maxLength: 64 });
  readString(candidate, 'title', path, problems, { maxLength: 200 });
  readUrl(candidate, 'previewUrl', path, problems);
  readUrl(candidate, 'downloadUrl', path, problems);
  readUrl(candidate, 'sourcePageUrl', path, problems);
  readUrl(candidate, 'thumbnailUrl', path, problems, { nullable: true });
  const duration = readNumber(candidate, 'durationSeconds', path, problems, { min: 0.001 });
  readNumber(candidate, 'width', path, problems, { integer: true, min: 2 });
  readNumber(candidate, 'height', path, problems, { integer: true, min: 2 });
  const attribution = readString(candidate, 'attribution', path, problems, { maxLength: 200 });
  if (attribution !== null) checkNoLeak(attribution, `${path}.attribution`, problems);

  if (problems.count !== before || id === null || duration === null) return null;
  return { id, durationSeconds: duration };
}

function validateBrollItems(
  value: unknown,
  path: string,
  sourceDuration: number | null,
  sourceAbsent: boolean,
  problems: Problems,
): ItemSummary[] | null {
  const items = requireArray(value, path, problems);
  if (items === null) return null;

  if (sourceAbsent && items.length > 0) {
    problems.add(path, 'doit être vide tant que la source n’est pas importée');
  }
  if (items.length > TIMELINE_RULES.maxBrollItems) {
    problems.add(path, `au plus ${TIMELINE_RULES.maxBrollItems} B-rolls (reçu ${items.length})`);
  }

  const summaries: ItemSummary[] = [];
  const seenItemIds = new Set<string>();

  items.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const object = requireObject(item, itemPath, problems);
    if (object === null) return;

    requireKeys(object, itemPath, ITEM_KEYS, [], problems);
    const id = readString(object, 'id', itemPath, problems, { pattern: ID_PATTERN, maxLength: 64 });
    if (id !== null) {
      if (seenItemIds.has(id)) problems.add(`${itemPath}.id`, `identifiant « ${id} » en double`);
      seenItemIds.add(id);
    }
    const start = readNumber(object, 'startSeconds', itemPath, problems, { min: 0, msPrecision: true });
    const end = readNumber(object, 'endSeconds', itemPath, problems, { min: 0, msPrecision: true });
    readString(object, 'reason', itemPath, problems, { maxLength: 500 });

    const candidates = requireArray(object.candidates, `${itemPath}.candidates`, problems);
    const candidateSummaries: CandidateSummary[] = [];
    const candidateIds = new Set<string>();
    if (candidates !== null) {
      if (candidates.length > TIMELINE_RULES.maxCandidatesPerItem) {
        problems.add(`${itemPath}.candidates`, `au plus ${TIMELINE_RULES.maxCandidatesPerItem} candidats (reçu ${candidates.length})`);
      }
      candidates.forEach((candidate, candidateIndex) => {
        const summary = validateCandidate(candidate, `${itemPath}.candidates[${candidateIndex}]`, problems);
        if (summary === null) return;
        if (candidateIds.has(summary.id)) {
          problems.add(`${itemPath}.candidates[${candidateIndex}].id`, `identifiant « ${summary.id} » en double`);
        }
        candidateIds.add(summary.id);
        candidateSummaries.push(summary);
      });
    }

    const selectedCandidateId = object.selectedCandidateId === null
      ? null
      : readString(object, 'selectedCandidateId', itemPath, problems, { pattern: ID_PATTERN, maxLength: 64 });
    if (selectedCandidateId === null) {
      if (candidateSummaries.length > 0) {
        problems.add(`${itemPath}.selectedCandidateId`, 'doit désigner un candidat quand candidates n’est pas vide');
      }
    } else if (!candidateIds.has(selectedCandidateId)) {
      problems.add(`${itemPath}.selectedCandidateId`, `candidat « ${selectedCandidateId} » absent de candidates`);
    }

    const status = readOneOf(object, 'status', itemPath, problems, BROLL_ITEM_STATUSES);
    const fit = readOneOf(object, 'fit', itemPath, problems, BROLL_FITS);
    const enabled = readBoolean(object, 'enabled', itemPath, problems);

    if (start !== null && end !== null) {
      if (start >= end) {
        problems.add(itemPath, `intervalle invalide (${start} ≥ ${end})`);
      } else {
        const duration = roundMs(end - start);
        if (duration < TIMELINE_RULES.minSegmentSeconds - 1e-9) {
          problems.add(itemPath, `durée ${duration} s < minimum ${TIMELINE_RULES.minSegmentSeconds} s`);
        }
        if (duration > TIMELINE_RULES.maxSegmentSeconds + 1e-9) {
          problems.add(itemPath, `durée ${duration} s > maximum ${TIMELINE_RULES.maxSegmentSeconds} s`);
        }
        if (sourceDuration !== null && end > sourceDuration + 1e-9) {
          problems.add(`${itemPath}.endSeconds`, `dépasse la durée de la source (${sourceDuration} s)`);
        }
        const selected = candidateSummaries.find((candidate) => candidate.id === selectedCandidateId);
        if (selected !== undefined && duration > selected.durationSeconds + 0.001) {
          problems.add(itemPath, `durée ${duration} s > durée du candidat choisi (${selected.durationSeconds} s)`);
        }
      }
    }

    if (id !== null && start !== null && end !== null && fit !== null && status !== null && enabled !== null) {
      summaries.push({
        id,
        startSeconds: start,
        endSeconds: end,
        fit,
        status,
        enabled,
        selectedCandidateId,
        candidateIds: [...candidateIds],
      });
    }
  });

  return summaries;
}

function validateTimeline(
  value: unknown,
  path: string,
  sourceDuration: number | null,
  problems: Problems,
): SegmentSummary[] | null {
  const timeline = requireObject(value, path, problems);
  if (timeline === null) return null;

  requireKeys(timeline, path, ['segments'], [], problems);
  const rawSegments = requireArray(timeline.segments, `${path}.segments`, problems);
  if (rawSegments === null) return null;
  if (rawSegments.length > TIMELINE_RULES.maxBrollItems) {
    problems.add(`${path}.segments`, `au plus ${TIMELINE_RULES.maxBrollItems} segments (reçu ${rawSegments.length})`);
  }

  const segments: SegmentSummary[] = [];
  let previousEnd = -1;

  rawSegments.forEach((segment, index) => {
    const segmentPath = `${path}.segments[${index}]`;
    const object = requireObject(segment, segmentPath, problems);
    if (object === null) return;

    requireKeys(object, segmentPath, SEGMENT_KEYS, [], problems);
    const brollItemId = readString(object, 'brollItemId', segmentPath, problems, { pattern: ID_PATTERN, maxLength: 64 });
    const candidateId = readString(object, 'candidateId', segmentPath, problems, { pattern: ID_PATTERN, maxLength: 64 });
    const start = readNumber(object, 'startSeconds', segmentPath, problems, { min: 0, msPrecision: true });
    const end = readNumber(object, 'endSeconds', segmentPath, problems, { min: 0, msPrecision: true });
    const fit = readOneOf(object, 'fit', segmentPath, problems, BROLL_FITS);

    if (start !== null && end !== null) {
      if (start >= end) problems.add(segmentPath, `intervalle invalide (${start} ≥ ${end})`);
      if (sourceDuration !== null && end > sourceDuration + 1e-9) {
        problems.add(`${segmentPath}.endSeconds`, `dépasse la durée de la source (${sourceDuration} s)`);
      }
      if (previousEnd >= 0 && start < previousEnd - 1e-9) {
        problems.add(`${segmentPath}.startSeconds`, 'segments non triés ou chevauchants');
      }
      const duration = end - start;
      if (duration < TIMELINE_RULES.minSegmentSeconds - 1e-9 || duration > TIMELINE_RULES.maxSegmentSeconds + 1e-9) {
        problems.add(segmentPath, `durée hors [${TIMELINE_RULES.minSegmentSeconds}, ${TIMELINE_RULES.maxSegmentSeconds}] s`);
      }
      previousEnd = Math.max(previousEnd, end);
    }

    if (brollItemId !== null && candidateId !== null && start !== null && end !== null && fit !== null) {
      segments.push({ brollItemId, candidateId, startSeconds: start, endSeconds: end, fit });
    }
  });

  return segments;
}

/** Règle d'inclusion D-06 : preview et export utilisent exactement project.timeline.segments. */
function compareTimeline(items: readonly ItemSummary[], segments: readonly SegmentSummary[], problems: Problems): void {
  const mounted = items
    .filter((item) => item.enabled && item.status !== 'rejected' && item.selectedCandidateId !== null)
    .sort((a, b) => a.startSeconds - b.startSeconds);

  if (mounted.length !== segments.length) {
    problems.add(
      'project.timeline.segments',
      `${segments.length} segment(s) pour ${mounted.length} B-roll(s) monté(s) selon la règle d’inclusion`,
    );
  }

  const count = Math.min(mounted.length, segments.length);
  for (let index = 0; index < count; index += 1) {
    const item = mounted[index];
    const segment = segments[index];
    const segmentPath = `project.timeline.segments[${index}]`;
    if (item === undefined || segment === undefined) continue;
    if (segment.brollItemId !== item.id) problems.add(`${segmentPath}.brollItemId`, `attendu « ${item.id} », reçu « ${segment.brollItemId} »`);
    if (segment.candidateId !== item.selectedCandidateId) {
      problems.add(`${segmentPath}.candidateId`, `attendu « ${String(item.selectedCandidateId)} », reçu « ${segment.candidateId} »`);
    }
    if (!nearlyEqual(segment.startSeconds, item.startSeconds)) {
      problems.add(`${segmentPath}.startSeconds`, `attendu ${item.startSeconds}, reçu ${segment.startSeconds}`);
    }
    if (!nearlyEqual(segment.endSeconds, item.endSeconds)) {
      problems.add(`${segmentPath}.endSeconds`, `attendu ${item.endSeconds}, reçu ${segment.endSeconds}`);
    }
    if (segment.fit !== item.fit) problems.add(`${segmentPath}.fit`, `attendu « ${item.fit} », reçu « ${segment.fit} »`);
  }

  for (let index = 1; index < mounted.length; index += 1) {
    const previous = mounted[index - 1];
    const current = mounted[index];
    if (previous === undefined || current === undefined) continue;
    if (current.startSeconds < previous.endSeconds - 1e-9) {
      problems.add(
        `project.brollItems (${previous.id} / ${current.id})`,
        `B-rolls montés chevauchants : ${previous.endSeconds} s > ${current.startSeconds} s`,
      );
    }
  }

  for (const segment of segments) {
    const item = items.find((candidate) => candidate.id === segment.brollItemId);
    if (item === undefined) {
      problems.add('project.timeline.segments', `segment orphelin : B-roll « ${segment.brollItemId} » inconnu`);
    } else if (!item.candidateIds.includes(segment.candidateId)) {
      problems.add(
        'project.timeline.segments',
        `segment ${segment.brollItemId} : candidat « ${segment.candidateId} » absent de l’élément`,
      );
    }
  }
}

function validateRender(
  value: unknown,
  path: string,
  source: SourceSummary | null,
  projectRevision: number | null,
  problems: Problems,
): string | null {
  const render = requireObject(value, path, problems);
  if (render === null) return null;

  requireKeys(render, path, RENDER_KEYS, [], problems);
  const status = readOneOf(render, 'status', path, problems, RENDER_STATUSES);
  const jobId = render.jobId === null ? null : readString(render, 'jobId', path, problems, { pattern: ID_PATTERN, maxLength: 64 });
  const revision = render.revision === null ? null : readNumber(render, 'revision', path, problems, { integer: true, min: 0 });
  const progress = readNumber(render, 'progress', path, problems, { min: 0, max: 1 });
  const outputFile = render.outputFile === null ? null : validateOutputFile(render.outputFile, `${path}.outputFile`, problems);
  const startedAt = render.startedAt === null ? null : readIsoDate(render, 'startedAt', path, problems);
  const completedAt = render.completedAt === null ? null : readIsoDate(render, 'completedAt', path, problems);
  const hasError = 'error' in render && render.error !== null;
  if (hasError) {
    for (const problem of validateErrorInfo(render.error, `${path}.error`)) problems.list.push(problem);
  }

  if (revision !== null && projectRevision !== null && revision > projectRevision) {
    problems.add(`${path}.revision`, `postérieure à la révision du projet (${projectRevision})`);
  }

  if (status === 'idle') {
    if (jobId !== null) problems.add(`${path}.jobId`, 'doit être null quand status = idle');
    if (revision !== null) problems.add(`${path}.revision`, 'doit être null quand status = idle');
    if (progress !== null && progress !== 0) problems.add(`${path}.progress`, 'doit valoir 0 quand status = idle');
    if (outputFile !== null) problems.add(`${path}.outputFile`, 'doit être null quand status = idle');
    if (startedAt !== null) problems.add(`${path}.startedAt`, 'doit être null quand status = idle');
    if (completedAt !== null) problems.add(`${path}.completedAt`, 'doit être null quand status = idle');
  } else {
    if (jobId === null) problems.add(`${path}.jobId`, 'doit être renseigné dès qu’un job existe');
    if (startedAt === null) problems.add(`${path}.startedAt`, 'doit être renseigné dès qu’un job existe');
  }

  if (status === 'completed') {
    if (revision === null) problems.add(`${path}.revision`, 'doit être renseignée quand status = completed');
    if (progress !== null && !nearlyEqual(progress, 1)) problems.add(`${path}.progress`, 'doit valoir 1 quand status = completed');
    if (outputFile === null) problems.add(`${path}.outputFile`, 'doit être renseigné quand status = completed');
    if (completedAt === null) problems.add(`${path}.completedAt`, 'doit être renseigné quand status = completed');
    if (hasError) problems.add(`${path}.error`, 'doit être null quand status = completed');
    if (outputFile !== null && source !== null) {
      const tolerance = Math.max(0.5, 2 / source.frameRate);
      if (Math.abs(outputFile.durationSeconds - source.durationSeconds) > tolerance) {
        problems.add(
          `${path}.outputFile.durationSeconds`,
          `écart de durée excessif avec la source (${outputFile.durationSeconds} s vs ${source.durationSeconds} s)`,
        );
      }
    }
  }

  if (status === 'failed') {
    if (!hasError) problems.add(`${path}.error`, 'doit être renseigné quand status = failed');
    if (outputFile !== null) problems.add(`${path}.outputFile`, 'doit être null quand status = failed');
  }
  if (status !== 'failed' && hasError) problems.add(`${path}.error`, 'doit être null hors status = failed');

  return status;
}

interface OutputFileSummary {
  sizeBytes: number;
  durationSeconds: number;
}

function validateOutputFile(value: unknown, path: string, problems: Problems): OutputFileSummary | null {
  const before = problems.count;
  const output = requireObject(value, path, problems);
  if (output === null) return null;

  requireKeys(output, path, ['sizeBytes', 'durationSeconds'], [], problems);
  const sizeBytes = readNumber(output, 'sizeBytes', path, problems, { integer: true, min: 1 });
  const durationSeconds = readNumber(output, 'durationSeconds', path, problems, { min: 0.001 });
  if (problems.count !== before || sizeBytes === null || durationSeconds === null) return null;
  return { sizeBytes, durationSeconds };
}

function validateUrls(value: unknown, path: string, hasSource: boolean, renderStatus: string | null, problems: Problems): void {
  const urls = requireObject(value, path, problems);
  if (urls === null) return;

  requireKeys(urls, path, ['source', 'download'], [], problems);
  const source = readUrl(urls, 'source', path, problems, { nullable: true });
  const download = readUrl(urls, 'download', path, problems, { nullable: true });

  if (hasSource && source === null) problems.add(`${path}.source`, 'doit être renseignée quand la vidéo source existe');
  if (!hasSource && 'source' in urls && urls.source !== null) problems.add(`${path}.source`, 'doit être null sans vidéo source');
  if (renderStatus === 'completed' && download === null) {
    problems.add(`${path}.download`, 'doit être renseignée quand le rendu est completed');
  }
  if (renderStatus !== 'completed' && 'download' in urls && urls.download !== null) {
    problems.add(`${path}.download`, 'doit être null tant que le rendu n’est pas completed');
  }
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Vérifie qu'un temps respecte la précision du contrat (exporté pour les tests). */
export function assertMsPrecision(value: number): boolean {
  return isMillisecondPrecise(value);
}

/** Valide brollItems + timeline d'une réponse SuggestionsResponse (sans durée de source connue). */
export function validateBrollItemsAndTimeline(brollItems: unknown, timeline: unknown): string[] {
  const problems = new Problems();
  const items = validateBrollItems(brollItems, 'brollItems', null, false, problems);
  const before = problems.count;
  const segments = validateTimeline(timeline, 'timeline', null, problems);
  if (problems.count === before && items !== null && segments !== null) {
    compareTimeline(items, segments, problems);
  }
  return problems.list;
}

/** Valide un RenderState isolé (réponses render, statut de rendu). */
export function validateRenderState(value: unknown): string[] {
  const problems = new Problems();
  validateRender(value, 'render', null, null, problems);
  return problems.list;
}
