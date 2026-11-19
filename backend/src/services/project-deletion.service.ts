import { rm } from 'node:fs/promises';
import type { ProjectRepository } from '../repositories/project.repository.ts';
import type { LocalStorage } from '../storage/local-storage.ts';
import { AppError } from '../utils/errors.ts';
import type { Logger } from '../utils/logger.ts';
import type { BrollMediaStore } from './broll-media.service.ts';
import { projectNotFound, type ProjectService } from './project.service.ts';

export interface ProjectDeletionDeps {
  readonly logger: Logger;
  readonly storage: LocalStorage;
  readonly projects: ProjectService;
  readonly repository: ProjectRepository;
  readonly media: BrollMediaStore;
}

/**
 * DELETE /api/projects/:id : supprime le projet, ses exports et tous ses fichiers (vidéo
 * source, B-rolls, MP4 final). Refusé pendant une analyse ou un export.
 */
export function createProjectDeletion({ logger, storage, projects, repository, media }: ProjectDeletionDeps) {
  return async function deleteProject(projectId: string): Promise<void> {
    const record = projects.requireRecord(projectId);
    const { status } = record.document.analysis;
    if (status === 'queued' || status === 'processing') {
      throw conflict("Une analyse est en cours : attendez qu'elle se termine avant de supprimer le projet.");
    }
    // La base d'abord : dès cet instant, toute requête sur ce projet reçoit 404.
    const result = repository.remove(record.id);
    if (result === 'not_found') throw projectNotFound();
    if (result === 'render_active') {
      throw conflict("Un export est en cours : attendez qu'il se termine avant de supprimer le projet.");
    }

    await media.release(record.id);
    try {
      await rm(storage.projectDir(record.id), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      // Le projet n'existe plus pour l'API ; seuls des fichiers orphelins restent à nettoyer.
      logger.error('project.files_not_removed', { projectId: record.id, err: error });
    }
    logger.info('project.deleted', { projectId: record.id });
  };
}

function conflict(message: string): AppError {
  return new AppError({ code: 'CONFLICT', stage: 'request', httpStatus: 409, retryable: true, message });
}
