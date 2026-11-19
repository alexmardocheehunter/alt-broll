import { Router, type RequestHandler } from 'express';
import type { RenderStatusResponse, StartRenderResponse } from '../contract.ts';
import type { RenderService } from '../services/render.service.ts';
import { AppError } from '../utils/errors.ts';
import type { Logger } from '../utils/logger.ts';
import { idParam } from '../utils/route-params.ts';

export interface RenderRouterDeps {
  readonly render: RenderService;
  readonly logger: Logger;
  /** Limite les exports, opérations coûteuses. */
  readonly writeLimiter: RequestHandler;
}

/** Export : création du job, suivi, téléchargement du MP4 final (docs/API.md). */
export function createRenderRouter({ render, logger, writeLimiter }: RenderRouterDeps): Router {
  const router = Router();

  router.post('/projects/:id/render', writeLimiter, (req, res) => {
    const body: StartRenderResponse = render.start(idParam(req.params), req.body);
    res.status(202).json(body);
  });

  router.get('/projects/:id/render/status', (req, res) => {
    const body: RenderStatusResponse = render.status(idParam(req.params));
    res.json(body);
  });

  // Chemin calculé par le serveur à partir du job terminé ; requêtes Range acceptées.
  router.get('/projects/:id/download', (req, res, next) => {
    const { file, fileName } = render.resolveDownload(idParam(req.params));
    res.attachment(fileName);
    res.sendFile(
      file,
      { headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, no-cache' }, dotfiles: 'deny' },
      (error?: Error) => {
        if (error === undefined) return;
        const code = (error as { code?: unknown }).code;
        if (code === 'ECONNABORTED') return;
        if (res.headersSent) {
          logger.warn('download.stream_interrupted', { err: error });
          return;
        }
        next(
          code === 'ENOENT'
            ? new AppError({
                code: 'DOWNLOAD_NOT_READY',
                stage: 'download',
                httpStatus: 409,
                retryable: true,
                message: "Le fichier exporté est introuvable : relancez l'export.",
              })
            : error,
        );
      },
    );
  });

  return router;
}
