import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { AppConfig, RenderShortSide } from '../config/env.ts';
import {
  RENDER_JOB_RULES,
  SCHEMA_VERSION,
  STORAGE_LAYOUT,
  type BrollCandidate,
  type BrollItem,
  type RenderJobPayload,
  type RenderSegment,
  type RenderStatusResponse,
  type SourceVideo,
  type StartRenderResponse,
} from '../contract.ts';
import type { RenderJobRepository } from '../repositories/job.repository.ts';
import type { LocalStorage } from '../storage/local-storage.ts';
import { forEachLimited } from '../utils/concurrency.ts';
import { AppError } from '../utils/errors.ts';
import type { Logger } from '../utils/logger.ts';
import { parseBody } from '../utils/validation.ts';
import { brollFile, DOWNLOAD_CONCURRENCY, type BrollMediaStore, type MediaInfo } from './broll-media.service.ts';
import { outputFormat } from './output-format.ts';
import type { ProjectService } from './project.service.ts';
import { toRenderState } from './render-state.ts';
import { buildTimeline } from './timeline.service.ts';

const DOWNLOAD_FAILED_MESSAGE =
  "Une vidéo B-roll n'a pas pu être récupérée. Relancez l'export, ou choisissez une autre proposition pour ce plan.";

const startRenderSchema = z.strictObject({ revision: z.number().int().min(0) });

export interface RenderService {
  /** POST /render : vérifie, crée le job en « preparing » et lance la récupération des B-rolls. */
  start(projectId: string, body: unknown): StartRenderResponse;
  status(projectId: string): RenderStatusResponse;
  /** MP4 du dernier export terminé ; sinon DOWNLOAD_NOT_READY. */
  resolveDownload(projectId: string): { readonly file: string; readonly fileName: string };
  /** Préparations interrompues par un arrêt du serveur : échec RENDER_INTERRUPTED. Renvoie leur nombre. */
  recoverInterrupted(): number;
  /** Se résout quand plus aucune préparation n'est en cours. */
  whenIdle(): Promise<void>;
}

export interface RenderServiceDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly storage: LocalStorage;
  readonly projects: ProjectService;
  readonly renderJobs: RenderJobRepository;
  readonly media: BrollMediaStore;
  readonly now?: () => number;
}

export function createRenderService(deps: RenderServiceDeps): RenderService {
  const { config, logger, storage, projects, renderJobs, media, now = Date.now } = deps;
  let queue: Promise<void> = Promise.resolve();

  function start(projectId: string, body: unknown): StartRenderResponse {
    const { revision } = parseBody(startRenderSchema, body, 'render');
    const record = projects.requireRecord(projectId);
    const { source, analysis, brollItems } = record.document;

    if (source === null || analysis.status !== 'completed') {
      throw renderError('RENDER_NOT_READY', 409, "Terminez l'analyse de la vidéo avant de lancer l'export.");
    }
    if (revision !== record.revision) {
      throw new AppError({
        code: 'REVISION_CONFLICT',
        stage: 'render',
        httpStatus: 409,
        retryable: true,
        message: "Le montage a changé depuis votre dernière sauvegarde : rechargez le projet avant d'exporter.",
      });
    }
    const { segments } = buildTimeline(brollItems);
    if (segments.length === 0) {
      throw renderError('RENDER_NO_SEGMENTS', 422, "Aucun B-roll n'est retenu : gardez au moins un plan de coupe avant d'exporter.");
    }

    const jobId = randomUUID();
    const { payload, candidates } = planRender(source, brollItems, segments, jobId, config.limits.renderMaxShortSide);
    const created = renderJobs.insertPreparing({
      id: jobId,
      projectId: record.id,
      projectRevision: record.revision,
      payload: JSON.stringify(payload),
      maxAttempts: RENDER_JOB_RULES.maxAttempts,
      nowMs: now(),
    });
    if (!created) {
      throw new AppError({
        code: 'RENDER_ALREADY_ACTIVE',
        stage: 'render',
        httpStatus: 409,
        retryable: true,
        message: "Un export est déjà en cours pour ce projet : attendez qu'il se termine.",
      });
    }

    queue = queue
      .then(() => prepare(jobId, record.id, payload, candidates))
      .catch((error: unknown) => logger.error('render.queue_failed', { jobId, err: error }));
    logger.info('render.created', { jobId, projectId: record.id, revision: record.revision, segments: segments.length });
    return { render: toRenderState(renderJobs.findById(jobId)) };
  }

  /**
   * Rend chaque B-roll disponible sur le disque (souvent déjà préchargé après l'analyse),
   * mesure sa durée réelle, puis met le job en file pour le worker.
   */
  async function prepare(jobId: string, projectId: string, payload: RenderJobPayload, candidates: readonly BrollCandidate[]): Promise<void> {
    try {
      const measured = new Map<string, MediaInfo>();
      const unique = [...new Map(candidates.map((candidate) => [candidate.id, candidate])).values()];
      await forEachLimited(unique, DOWNLOAD_CONCURRENCY, async (candidate) => {
        measured.set(brollFile(candidate), await media.ensure(projectId, candidate));
      });
      const segments: RenderSegment[] = payload.segments.map((segment) => {
        const info = measured.get(segment.media.file);
        if (info === undefined) throw new Error(`B-roll non préparé : ${segment.media.file}`);
        // Durée Pixabay arrondie à la seconde : le segment est borné à la durée réelle du fichier.
        const endSeconds = Math.min(segment.endSeconds, Math.floor((segment.startSeconds + info.durationSeconds) * 1000) / 1000);
        return { ...segment, endSeconds, media: { file: segment.media.file, ...info } };
      });
      if (!renderJobs.markQueued(jobId, JSON.stringify({ ...payload, segments }), now())) {
        logger.warn('render.queue_skipped', { jobId, reason: "le job n'est plus en préparation" });
        return;
      }
      logger.info('render.queued', { jobId, projectId, segments: segments.length });
    } catch (error) {
      const failure =
        error instanceof AppError ? error : renderError('RENDER_MEDIA_DOWNLOAD_FAILED', 502, DOWNLOAD_FAILED_MESSAGE, error);
      logger.warn('render.preparation_failed', { jobId, projectId, code: failure.code, err: error });
      renderJobs.markPreparationFailed(jobId, failure.code, failure.message, now());
    }
  }

  function status(projectId: string): RenderStatusResponse {
    const record = projects.requireRecord(projectId);
    return { projectId: record.id, projectRevision: record.revision, render: toRenderState(renderJobs.latestForProject(record.id)) };
  }

  function resolveDownload(projectId: string): { file: string; fileName: string } {
    const record = projects.requireRecord(projectId);
    const job = renderJobs.latestForProject(record.id);
    if (job === null || job.status !== 'completed') {
      throw new AppError({
        code: 'DOWNLOAD_NOT_READY',
        stage: 'download',
        httpStatus: 409,
        retryable: true,
        message: "Aucun export terminé n'est disponible : lancez l'export et attendez sa fin.",
      });
    }
    const payload = JSON.parse(job.payload) as RenderJobPayload;
    const file = storage.resolveProjectFile(record.id, payload.output.file);
    if (!existsSync(file)) {
      logger.error('render.output_missing', { jobId: job.id, projectId: record.id });
      throw new AppError({
        code: 'DOWNLOAD_NOT_READY',
        stage: 'download',
        httpStatus: 409,
        retryable: true,
        message: "Le fichier exporté est introuvable : relancez l'export.",
      });
    }
    return { file, fileName: downloadFileName(record.document.source?.originalName ?? null) };
  }

  function recoverInterrupted(): number {
    return renderJobs.failInterruptedPreparations("L'export a été interrompu par un redémarrage du serveur. Relancez-le.", now());
  }

  return { start, status, resolveDownload, recoverInterrupted, whenIdle: () => queue };
}

/** Nom proposé au téléchargement : celui de la vidéo importée, suffixé. */
export function downloadFileName(originalName: string | null): string {
  const base = (originalName ?? '')
    .replace(/\.[^.]*$/, '')
    .replace(/[^\p{L}\p{N} _-]+/gu, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .slice(0, 80);
  return `${base === '' ? 'video' : base}-alt-broll.mp4`;
}

function planRender(
  source: SourceVideo,
  items: readonly BrollItem[],
  segments: ReturnType<typeof buildTimeline>['segments'],
  jobId: string,
  maxShortSide: RenderShortSide,
): { payload: RenderJobPayload; candidates: BrollCandidate[] } {
  const candidates: BrollCandidate[] = [];
  const renderSegments: RenderSegment[] = segments.map((segment) => {
    const candidate = items
      .find((item) => item.id === segment.brollItemId)
      ?.candidates.find((entry) => entry.id === segment.candidateId);
    if (candidate === undefined) throw new Error(`Candidat ${segment.candidateId} introuvable.`);
    candidates.push(candidate);
    return {
      ...segment,
      media: { file: brollFile(candidate), durationSeconds: candidate.durationSeconds, width: candidate.width, height: candidate.height },
    };
  });
  return {
    payload: {
      schemaVersion: SCHEMA_VERSION,
      source: {
        file: `${STORAGE_LAYOUT.sourceDir}/${source.storedFileName}`,
        durationSeconds: source.durationSeconds,
        width: source.width,
        height: source.height,
        frameRate: source.frameRate,
        audioPresent: source.audioPresent,
      },
      output: { file: `${STORAGE_LAYOUT.outputDir}/${jobId}.mp4`, ...outputFormat(source, maxShortSide) },
      segments: renderSegments,
    },
    candidates,
  };
}

function renderError(code: 'RENDER_NOT_READY' | 'RENDER_NO_SEGMENTS' | 'RENDER_MEDIA_DOWNLOAD_FAILED', httpStatus: number, message: string, cause?: unknown): AppError {
  return new AppError({
    code,
    stage: 'render',
    httpStatus,
    retryable: code === 'RENDER_MEDIA_DOWNLOAD_FAILED',
    message,
    ...(cause === undefined ? {} : { cause, details: { reason: cause instanceof Error ? cause.message : String(cause) } }),
  });
}
