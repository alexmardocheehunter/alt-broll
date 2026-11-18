import { Router } from 'express';
import { STORAGE_LAYOUT } from '../contract.ts';
import type { ProjectService } from '../services/project.service.ts';
import type { LocalStorage } from '../storage/local-storage.ts';
import { AppError } from '../utils/errors.ts';
import type { Logger } from '../utils/logger.ts';

export interface MediaRouterDeps {
  readonly projects: ProjectService;
  readonly storage: LocalStorage;
  readonly logger: Logger;
}

/** Fichiers servis au navigateur. Le chemin est toujours calculé par le serveur, jamais fourni par le client. */
export function createMediaRouter({ projects, storage, logger }: MediaRouterDeps): Router {
  const router = Router();

  // Vidéo source pour le lecteur HTML5 ; les requêtes Range (déplacement dans la vidéo) sont prises en charge.
  // URL stable : « no-cache » + ETag font revalider le navigateur (304 si inchangé), qui reçoit
  // donc la nouvelle vidéo dès qu'elle est remplacée.
  router.get('/projects/:id/media/source', (req, res, next) => {
    const record = projects.requireRecord(req.params.id);
    const { source } = record.document;
    if (source === null) throw mediaNotFound("Aucune vidéo n'a encore été importée pour ce projet.");

    const file = storage.resolveProjectFile(record.id, `${STORAGE_LAYOUT.sourceDir}/${source.storedFileName}`);
    res.sendFile(
      file,
      { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, no-cache' }, dotfiles: 'deny' },
      (error?: Error) => {
        if (error === undefined) return;
        // Le lecteur annule souvent une requête quand l'utilisateur se déplace dans la vidéo.
        if (errorCode(error) === 'ECONNABORTED') return;
        if (res.headersSent) {
          logger.warn('media.stream_interrupted', { projectId: record.id, err: error });
          return;
        }
        if (errorCode(error) === 'ENOENT') {
          logger.error('media.source_missing', { projectId: record.id });
          next(mediaNotFound('Le fichier vidéo de ce projet est introuvable.'));
          return;
        }
        next(error);
      },
    );
  });

  return router;
}

function mediaNotFound(message: string): AppError {
  return new AppError({ code: 'NOT_FOUND', stage: 'request', httpStatus: 404, message });
}

function errorCode(error: Error): unknown {
  return (error as { code?: unknown }).code;
}
