import { Router, type RequestHandler } from 'express';
import type {
  CreateProjectResponse,
  GetProjectResponse,
  ProjectStatusResponse,
  SuggestionsResponse,
  UploadSourceResponse,
} from '../contract.ts';
import type { ProjectService } from '../services/project.service.ts';
import type { UploadService } from '../services/upload.service.ts';

export interface ProjectsRouterDeps {
  readonly projects: ProjectService;
  readonly uploads: UploadService;
  /** Limite les opérations coûteuses (création, import). */
  readonly writeLimiter: RequestHandler;
}

/** Création, lecture et import de la vidéo source (docs/API.md). */
export function createProjectsRouter({ projects, uploads, writeLimiter }: ProjectsRouterDeps): Router {
  const router = Router();

  router.post('/projects', writeLimiter, (_req, res) => {
    const body: CreateProjectResponse = { project: projects.create() };
    res.status(201).json(body);
  });

  router.get('/projects/:id', (req, res) => {
    const body: GetProjectResponse = { project: projects.toProject(projects.requireRecord(idParam(req.params))) };
    res.json(body);
  });

  router.get('/projects/:id/status', (req, res) => {
    const body: ProjectStatusResponse = projects.status(projects.requireRecord(idParam(req.params)));
    res.json(body);
  });

  router.get('/projects/:id/suggestions', (req, res) => {
    const body: SuggestionsResponse = projects.suggestions(projects.requireRecord(idParam(req.params)));
    res.json(body);
  });

  router.post('/projects/:id/upload', writeLimiter, async (req, res) => {
    const body: UploadSourceResponse = { project: await uploads.uploadSource(idParam(req.params), req, res) };
    res.json(body);
  });

  return router;
}

/** Identifiant de projet de l'URL ; '' s'il est absent ou multiple (le projet sera alors introuvable). */
function idParam(params: Readonly<Record<string, unknown>>): string {
  const { id } = params;
  return typeof id === 'string' ? id : '';
}
