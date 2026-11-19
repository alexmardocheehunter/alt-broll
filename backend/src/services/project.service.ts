import { randomUUID } from 'node:crypto';
import type { MediaUrlSigner, SignedResource } from '../auth/media-url.ts';
import type { AppConfig } from '../config/env.ts';
import {
  ID_PATTERN,
  type Analysis,
  type Project,
  type ProjectStatusResponse,
  type SuggestionsResponse,
} from '../contract.ts';
import type { RenderJobRepository } from '../repositories/job.repository.ts';
import type { ProjectDocument, ProjectRecord, ProjectRepository } from '../repositories/project.repository.ts';
import { AppError } from '../utils/errors.ts';
import { toRenderState } from './render-state.ts';
import { buildTimeline } from './timeline.service.ts';

export interface ProjectService {
  /** Nouveau projet vide ; `ownerId` : compte connecté (AUTH_MODE=firebase), null sinon. */
  create(ownerId?: string | null): Project;
  /** Projet existant, sinon 404 (y compris pour un identifiant mal formé). */
  requireRecord(id: string): ProjectRecord;
  /** Enregistre un nouveau document si personne n'a modifié le projet depuis `record` ; sinon 409. */
  save(record: ProjectRecord, document: ProjectDocument): ProjectRecord;
  toProject(record: ProjectRecord): Project;
  status(record: ProjectRecord): ProjectStatusResponse;
  suggestions(record: ProjectRecord): SuggestionsResponse;
  hasActiveRender(projectId: string): boolean;
}

export interface ProjectServiceDeps {
  readonly config: AppConfig;
  readonly projects: ProjectRepository;
  readonly renderJobs: RenderJobRepository;
  readonly now?: () => number;
  /** Connexion activée : urls.source et urls.download deviennent des liens signés. */
  readonly mediaUrls?: MediaUrlSigner | null;
}

export function initialAnalysis(): Analysis {
  return {
    status: 'idle',
    stage: null,
    model: null,
    visualAnalysisAvailable: false,
    keyframes: [],
    summary: null,
    startedAt: null,
    completedAt: null,
    error: null,
  };
}

export function projectNotFound(): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    stage: 'request',
    httpStatus: 404,
    message: "Ce projet n'existe pas ou a été supprimé.",
  });
}

export function createProjectService({ config, projects, renderJobs, now = Date.now, mediaUrls = null }: ProjectServiceDeps): ProjectService {
  function requireRecord(id: string): ProjectRecord {
    const record = ID_PATTERN.test(id) ? projects.findById(id) : null;
    if (record === null) throw projectNotFound();
    return record;
  }

  function toProject(record: ProjectRecord): Project {
    const { document } = record;
    const render = toRenderState(renderJobs.latestForProject(record.id));
    const baseUrl = `${config.appBaseUrl}/api/projects/${record.id}`;
    const signed = (resource: SignedResource): string => (mediaUrls === null ? '' : `?${mediaUrls.query(record.id, resource)}`);
    return {
      id: record.id,
      schemaVersion: record.schemaVersion,
      revision: record.revision,
      createdAt: new Date(record.createdAtMs).toISOString(),
      updatedAt: new Date(record.updatedAtMs).toISOString(),
      source: document.source,
      transcript: document.transcript,
      analysis: document.analysis,
      brollItems: document.brollItems,
      timeline: buildTimeline(document.brollItems),
      render,
      urls: {
        source: document.source === null ? null : `${baseUrl}/media/source${signed('source')}`,
        download: render.status === 'completed' ? `${baseUrl}/download${signed('download')}` : null,
      },
    };
  }

  return {
    create(ownerId = null) {
      const document: ProjectDocument = {
        source: null,
        transcript: null,
        analysis: initialAnalysis(),
        brollItems: [],
        ...(ownerId === null ? {} : { ownerId }),
      };
      return toProject(projects.insert(randomUUID(), document, now()));
    },

    requireRecord,

    save(record, document) {
      // Le propriétaire ne change jamais, quel que soit le document fourni.
      const { ownerId } = record.document;
      const kept = ownerId === undefined ? document : { ...document, ownerId };
      const saved = projects.update(record.id, record.revision, kept, now());
      if (saved !== null) return saved;
      if (projects.findById(record.id) === null) throw projectNotFound();
      throw new AppError({
        code: 'REVISION_CONFLICT',
        stage: 'request',
        httpStatus: 409,
        retryable: true,
        message: 'Le projet a été modifié entre-temps. Rechargez-le puis réessayez.',
      });
    },

    toProject,

    status(record) {
      const { analysis, source } = record.document;
      const render = toRenderState(renderJobs.latestForProject(record.id));
      return {
        projectId: record.id,
        revision: record.revision,
        sourceUploaded: source !== null,
        analysis: { status: analysis.status, stage: analysis.stage, error: analysis.error },
        render: { status: render.status, progress: render.progress, error: render.error },
      };
    },

    suggestions(record) {
      const { analysis, brollItems } = record.document;
      return {
        projectId: record.id,
        revision: record.revision,
        visualAnalysisAvailable: analysis.visualAnalysisAvailable,
        brollItems,
        timeline: buildTimeline(brollItems),
      };
    },

    hasActiveRender: (projectId) => renderJobs.hasActiveJob(projectId),
  };
}
