import { mkdir, readFile, rm } from 'node:fs/promises';
import type { AppConfig } from '../config/env.ts';
import {
  STORAGE_LAYOUT,
  type AnalysisStage,
  type ErrorInfo,
  type ErrorStage,
  type ProjectStatusResponse,
} from '../contract.ts';
import type { AnalysisProviders } from '../providers/types.ts';
import type { ProjectDocument, ProjectRecord, ProjectRepository } from '../repositories/project.repository.ts';
import type { LocalStorage } from '../storage/local-storage.ts';
import { AppError } from '../utils/errors.ts';
import type { Logger } from '../utils/logger.ts';
import type { BrollMediaStore } from './broll-media.service.ts';
import { buildBrollItems } from './broll-search.service.ts';
import { extractKeyframes } from './keyframes.service.ts';
import { outputLongSide } from './output-format.ts';
import { initialAnalysis, type ProjectService } from './project.service.ts';
import { prepareAudio, transcribeAudio } from './transcription.service.ts';
import { analyzeContent, normalizeSuggestions } from './vision-analysis.service.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Étape d'erreur du contrat correspondant à chaque étape de l'analyse. */
const ERROR_STAGE_OF: Readonly<Record<AnalysisStage, ErrorStage>> = {
  extracting_audio: 'transcription',
  transcribing: 'transcription',
  extracting_keyframes: 'keyframes',
  analyzing_content: 'analysis',
  searching_broll: 'broll_search',
};

export interface AnalysisService {
  /** Vérifie les conditions puis met l'analyse en file : réponse 202 de POST /analyze. */
  start(projectId: string): ProjectStatusResponse;
  /** Marque comme interrompues les analyses laissées en cours par un arrêt du serveur ; renvoie leur nombre. */
  recoverInterrupted(): number;
  /** Se résout quand la file d'analyses est vide. */
  whenIdle(): Promise<void>;
}

export interface AnalysisServiceDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly storage: LocalStorage;
  readonly projects: ProjectService;
  readonly repository: ProjectRepository;
  /** null : fournisseurs non configurés, POST /analyze répond 503. */
  readonly providers: AnalysisProviders | null;
  /** Précharge les vidéos B-roll choisies dès la fin de l'analyse. */
  readonly media?: BrollMediaStore;
  readonly now?: () => number;
}

/** Analyses exécutées une à une dans le processus du backend (appels réseau et FFmpeg légers). */
export function createAnalysisService(deps: AnalysisServiceDeps): AnalysisService {
  const { config, logger, storage, projects, repository, providers, media, now = Date.now } = deps;
  const recentStarts: number[] = [];
  let queue: Promise<void> = Promise.resolve();

  const isoNow = (): string => new Date(now()).toISOString();

  function update(projectId: string, change: (document: ProjectDocument) => ProjectDocument): ProjectRecord {
    const current = projects.requireRecord(projectId);
    return projects.save(current, change(current.document));
  }

  /** Plafond sur 24 h glissantes, tous utilisateurs confondus : le coût reste borné. */
  function consumeDailyBudget(): boolean {
    const cutoff = now() - DAY_MS;
    while (recentStarts.length > 0 && (recentStarts[0] ?? 0) <= cutoff) recentStarts.shift();
    if (recentStarts.length >= config.limits.analysesPerDay) return false;
    recentStarts.push(now());
    return true;
  }

  function start(projectId: string): ProjectStatusResponse {
    const record = projects.requireRecord(projectId);
    const { source, analysis } = record.document;
    if (source === null) {
      throw new AppError({
        code: 'ANALYSIS_NOT_READY',
        stage: 'analysis',
        httpStatus: 409,
        message: "Importez d'abord une vidéo avant de lancer l'analyse.",
      });
    }
    if (analysis.status === 'queued' || analysis.status === 'processing') {
      throw new AppError({
        code: 'ANALYSIS_ALREADY_RUNNING',
        stage: 'analysis',
        httpStatus: 409,
        retryable: true,
        message: 'Une analyse est déjà en cours pour ce projet.',
      });
    }
    if (projects.hasActiveRender(record.id)) {
      throw new AppError({
        code: 'CONFLICT',
        stage: 'analysis',
        httpStatus: 409,
        retryable: true,
        message: "Un export est en cours : attendez qu'il se termine avant de relancer l'analyse.",
      });
    }
    if (providers === null) {
      throw new AppError({
        code: 'PROVIDER_NOT_CONFIGURED',
        stage: 'analysis',
        httpStatus: 503,
        message: "L'analyse n'est pas disponible : les services de transcription, d'analyse et de recherche ne sont pas configurés sur le serveur.",
      });
    }
    if (!consumeDailyBudget()) {
      throw new AppError({
        code: 'RATE_LIMITED',
        stage: 'analysis',
        httpStatus: 429,
        retryable: true,
        message: "La limite quotidienne d'analyses de la bêta est atteinte. Réessayez demain.",
      });
    }

    // Une nouvelle analyse remplace la précédente : transcription et B-rolls repartent de zéro.
    const queued = projects.save(record, {
      ...record.document,
      transcript: null,
      brollItems: [],
      analysis: { ...initialAnalysis(), status: 'queued' },
    });
    queue = queue
      .then(() => run(queued.id, providers))
      .catch((error: unknown) => logger.error('analysis.queue_failed', { projectId: queued.id, err: error }));
    logger.info('analysis.queued', { projectId: queued.id });
    return projects.status(queued);
  }

  async function run(projectId: string, active: AnalysisProviders): Promise<void> {
    const workDir = storage.projectWorkDir(projectId, `analysis-${now()}`);
    let stage: AnalysisStage = 'extracting_audio';
    const enter = (next: AnalysisStage): void => {
      stage = next;
      update(projectId, (document) => ({
        ...document,
        analysis: { ...document.analysis, status: 'processing', stage: next, startedAt: document.analysis.startedAt ?? isoNow() },
      }));
    };

    try {
      enter('extracting_audio');
      await mkdir(workDir, { recursive: true });
      const source = projects.requireRecord(projectId).document.source;
      if (source === null) throw new Error('Vidéo source absente au lancement de l’analyse.');
      const sourceFile = storage.resolveProjectFile(projectId, `${STORAGE_LAYOUT.sourceDir}/${source.storedFileName}`);

      const audioFile = await prepareAudio(config.binaries.ffmpeg, sourceFile, workDir);

      enter('transcribing');
      const transcript = await transcribeAudio({
        audioFile,
        durationSeconds: source.durationSeconds,
        language: config.providers.groq.language,
        provider: active.transcription,
      });
      update(projectId, (document) => ({ ...document, transcript }));

      enter('extracting_keyframes');
      const visual = await extractKeyframes({
        ffmpegPath: config.binaries.ffmpeg,
        fontFile: config.binaries.fontFile,
        sourceFile,
        durationSeconds: source.durationSeconds,
        width: source.width,
        height: source.height,
        workDir,
        logger,
      });

      enter('analyzing_content');
      const result = await analyzeContent({
        provider: active.analysis,
        transcript,
        durationSeconds: source.durationSeconds,
        keyframes: visual?.keyframes ?? [],
        contactSheet: visual === null ? null : await readFile(visual.contactSheetFile),
        logger,
      });
      const suggestions = normalizeSuggestions(result.suggestions, source.durationSeconds);

      enter('searching_broll');
      const targetLongSide = outputLongSide(source, config.limits.renderMaxShortSide);
      const brollItems = await buildBrollItems(suggestions, source, active.brollSearch, logger, targetLongSide);

      update(projectId, (document) => ({
        ...document,
        brollItems,
        analysis: {
          status: 'completed',
          stage: null,
          model: result.model,
          visualAnalysisAvailable: result.visualAnalysisUsed,
          // Images conservées seulement si un modèle vision les a réellement traitées.
          keyframes: result.visualAnalysisUsed && visual !== null ? visual.keyframes : [],
          summary: result.summary === '' ? null : result.summary,
          startedAt: document.analysis.startedAt,
          completedAt: isoNow(),
          error: null,
        },
      }));
      logger.info('analysis.completed', {
        projectId,
        model: result.model,
        visualAnalysisAvailable: result.visualAnalysisUsed,
        suggestions: brollItems.length,
        withCandidates: brollItems.filter((item) => item.candidates.length > 0).length,
      });
      media?.prefetch(projectId, brollItems);
    } catch (error) {
      const info = toErrorInfo(error, stage);
      if (error instanceof AppError) logger.warn('analysis.failed', { projectId, stage, code: info.code, err: error });
      else logger.error('analysis.failed', { projectId, stage, code: info.code, err: error });
      try {
        update(projectId, (document) => ({
          ...document,
          analysis: { ...document.analysis, status: 'failed', stage: null, completedAt: isoNow(), error: info },
        }));
      } catch (saveError) {
        logger.error('analysis.failure_not_saved', { projectId, err: saveError });
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  function recoverInterrupted(): number {
    const ids = repository.listIdsByAnalysisStatus(['queued', 'processing']);
    for (const id of ids) {
      update(id, (document) => ({
        ...document,
        analysis: {
          ...document.analysis,
          status: 'failed',
          stage: null,
          completedAt: isoNow(),
          error: {
            code: 'ANALYSIS_INTERRUPTED',
            stage: 'analysis',
            message: "L'analyse a été interrompue par un redémarrage du serveur. Relancez-la.",
            retryable: true,
          },
        },
      }));
    }
    return ids.length;
  }

  return { start, recoverInterrupted, whenIdle: () => queue };
}

function toErrorInfo(error: unknown, stage: AnalysisStage): ErrorInfo {
  if (error instanceof AppError) {
    const info = error.toInfo();
    return info.stage === 'internal' || info.stage === 'request' ? { ...info, stage: ERROR_STAGE_OF[stage] } : info;
  }
  return {
    code: 'INTERNAL_ERROR',
    stage: ERROR_STAGE_OF[stage],
    message: "L'analyse a échoué à cause d'une erreur interne. Relancez-la ; si le problème persiste, signalez-le.",
    retryable: true,
  };
}
