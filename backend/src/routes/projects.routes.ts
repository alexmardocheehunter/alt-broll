import { Router, type RequestHandler } from 'express';
import type {
  CreateProjectResponse,
  GetProjectResponse,
  ProjectStatusResponse,
  SuggestionsResponse,
  UpdateTimelineResponse,
  UploadSourceResponse,
} from '../contract.ts';
import { currentUser } from '../auth/auth.middleware.ts';
import type { AnalysisService } from '../services/analysis.service.ts';
import type { BrollMediaStore } from '../services/broll-media.service.ts';
import type { ProjectService } from '../services/project.service.ts';
import { updateTimeline } from '../services/timeline.service.ts';
import type { UploadService } from '../services/upload.service.ts';
import { idParam } from '../utils/route-params.ts';

export interface ProjectsRouterDeps {
  readonly projects: ProjectService;
  readonly uploads: UploadService;
  readonly analysis: AnalysisService;
  readonly media: BrollMediaStore;
  readonly deleteProject: (projectId: string) => Promise<void>;
  /** Limite les opérations coûteuses (création, import, analyse). */
  readonly writeLimiter: RequestHandler;
}

/** Création, lecture, import de la vidéo source, analyse, montage et suppression (docs/API.md). */
export function createProjectsRouter({ projects, uploads, analysis, media, deleteProject, writeLimiter }: ProjectsRouterDeps): Router {
  const router = Router();

  router.post('/projects', writeLimiter, (_req, res) => {
    const body: CreateProjectResponse = { project: projects.create(currentUser(res)?.id ?? null) };
    res.status(201).json(body);
  });

  router.get('/projects/:id', (req, res) => {
    const body: GetProjectResponse = { project: projects.toProject(projects.requireRecord(idParam(req.params))) };
    res.json(body);
  });

  router.delete('/projects/:id', async (req, res) => {
    await deleteProject(idParam(req.params));
    res.status(204).end();
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

  router.post('/projects/:id/analyze', writeLimiter, (req, res) => {
    const body: ProjectStatusResponse = analysis.start(idParam(req.params));
    res.status(202).json(body);
  });

  // Sauvegarde automatique de l'éditeur : appels fréquents et peu coûteux, sans limite horaire.
  // Une autre proposition choisie est préchargée aussitôt pour l'export.
  router.patch('/projects/:id/timeline', (req, res) => {
    const project = updateTimeline(projects, idParam(req.params), req.body);
    media.prefetch(project.id, project.brollItems);
    const body: UpdateTimelineResponse = { project };
    res.json(body);
  });

  return router;
}
