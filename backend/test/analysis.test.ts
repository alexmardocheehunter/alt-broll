import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type {
  ApiErrorResponse,
  CreateProjectResponse,
  GetProjectResponse,
  Project,
  ProjectStatusResponse,
} from '../src/contract.ts';
import { openDatabase } from '../src/db/database.ts';
import type {
  AnalysisProviders,
  BrollCandidateDraft,
  ContentAnalysisRequest,
  TranscriptionResult,
} from '../src/providers/types.ts';
import { AppError } from '../src/utils/errors.ts';
import { isFfmpegAvailable, makeVideo } from './fixtures.ts';
import { startTestApp, type TestApp } from './helpers.ts';

const ffmpegReady = await isFfmpegAvailable();

/** Doublures des trois services : aucun appel réseau. */
interface FakeOptions {
  transcription?: (durationSeconds: number) => Promise<TranscriptionResult>;
  analyze?: (request: ContentAnalysisRequest) => Promise<{ visual: boolean }>;
  search?: () => Promise<BrollCandidateDraft[]>;
}

function fakeProviders(options: FakeOptions = {}): AnalysisProviders & { readonly analyzeCalls: ContentAnalysisRequest[] } {
  const analyzeCalls: ContentAnalysisRequest[] = [];
  return {
    analyzeCalls,
    transcription: {
      transcribe: async ({ durationSeconds }) =>
        options.transcription?.(durationSeconds) ?? {
          provider: 'groq',
          model: 'doublure-whisper',
          language: 'fr',
          text: 'Je vends des mangues au marché. Le soir je vais à la plage.',
          segments: [
            { startSeconds: 0, endSeconds: durationSeconds / 2, text: 'Je vends des mangues au marché.' },
            { startSeconds: durationSeconds / 2, endSeconds: durationSeconds, text: 'Le soir je vais à la plage.' },
          ],
          words: [],
        },
    },
    analysis: {
      analyze: async (request) => {
        analyzeCalls.push(request);
        const outcome = (await options.analyze?.(request)) ?? { visual: request.contactSheet !== null };
        return {
          model: 'doublure/vision',
          visualAnalysisUsed: outcome.visual,
          summary: 'Une vendeuse parle de son marché.',
          suggestions: [
            { startSeconds: 1, endSeconds: 3.5, reason: 'Elle parle du marché.', searchQuery: 'Busy Market!' },
            { startSeconds: 5, endSeconds: 7, reason: 'Elle évoque la plage.', searchQuery: 'beach sunset' },
          ],
        };
      },
    },
    brollSearch: {
      search: async () =>
        options.search?.() ??
        [1, 2].map((n) => ({
          provider: 'pixabay' as const,
          providerMediaId: String(1000 + n),
          title: `clip ${n}`,
          previewUrl: `https://cdn.pixabay.com/video/${n}-tiny.mp4`,
          downloadUrl: `https://cdn.pixabay.com/video/${n}-large.mp4`,
          sourcePageUrl: `https://pixabay.com/videos/id-${n}/`,
          thumbnailUrl: null,
          durationSeconds: 12,
          width: 1920,
          height: 1080,
          attribution: 'Vidéo de test sur Pixabay',
        })),
    },
  };
}

describe('analyse de la vidéo', { skip: ffmpegReady ? false : 'FFmpeg ou ffprobe introuvable' }, () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'alt-broll-analysis-'));
  let videoBytes: Uint8Array<ArrayBuffer>;
  const apps: TestApp[] = [];

  before(async () => {
    const video = await makeVideo(workDir, 'parole.mp4', { seconds: 8 });
    videoBytes = new Uint8Array(await readFile(video));
  });

  after(async () => {
    await Promise.all(apps.map((app) => app.close()));
    rmSync(workDir, { recursive: true, force: true });
  });

  async function startApp(providers: AnalysisProviders | null | undefined, env: Record<string, string> = {}) {
    const storageRoot = mkdtempSync(path.join(workDir, 'storage-'));
    const app = await startTestApp(
      { STORAGE_ROOT: storageRoot, MIN_VIDEO_DURATION_SECONDS: '3', RATE_LIMIT_WRITES_PER_HOUR: '1000', ...env },
      providers === undefined ? {} : { providers },
    );
    apps.push(app);
    return { app, storageRoot };
  }

  async function projectWithVideo(app: TestApp): Promise<string> {
    const created = (await (await fetch(`${app.baseUrl}/api/projects`, { method: 'POST' })).json()) as CreateProjectResponse;
    const form = new FormData();
    form.append('video', new Blob([videoBytes], { type: 'video/mp4' }), 'parole.mp4');
    const uploaded = await fetch(`${app.baseUrl}/api/projects/${created.project.id}/upload`, { method: 'POST', body: form });
    assert.equal(uploaded.status, 200, await uploaded.clone().text());
    return created.project.id;
  }

  function startAnalysis(app: TestApp, id: string): Promise<Response> {
    return fetch(`${app.baseUrl}/api/projects/${id}/analyze`, { method: 'POST' });
  }

  async function waitForEnd(app: TestApp, id: string): Promise<Project> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = (await (await fetch(`${app.baseUrl}/api/projects/${id}/status`)).json()) as ProjectStatusResponse;
      if (status.analysis.status === 'completed' || status.analysis.status === 'failed') {
        return ((await (await fetch(`${app.baseUrl}/api/projects/${id}`)).json()) as GetProjectResponse).project;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("L'analyse ne s'est pas terminée à temps.");
  }

  it('enchaîne transcription, planche contact, analyse et recherche, puis remplit le projet', async () => {
    const providers = fakeProviders();
    const { app, storageRoot } = await startApp(providers);
    const id = await projectWithVideo(app);

    const started = await startAnalysis(app, id);
    const accepted = (await started.json()) as ProjectStatusResponse;
    const project = await waitForEnd(app, id);

    assert.equal(started.status, 202);
    assert.equal(accepted.analysis.status, 'queued');
    assert.equal(project.analysis.status, 'completed', JSON.stringify(project.analysis.error));
    assert.equal(project.analysis.model, 'doublure/vision');
    assert.equal(project.analysis.visualAnalysisAvailable, true);
    assert.equal(project.analysis.keyframes.length, 12);
    assert.equal(project.analysis.summary, 'Une vendeuse parle de son marché.');
    assert.ok(project.analysis.startedAt !== null && project.analysis.completedAt !== null);
    assert.equal(project.transcript?.segments.length, 2);

    assert.equal(project.brollItems.length, 2);
    const [first] = project.brollItems;
    assert.ok(first);
    assert.equal(first.searchQuery, 'busy market');
    assert.equal(first.candidates.length, 2);
    assert.equal(first.selectedCandidateId, first.candidates[0]?.id);
    assert.deepEqual([first.status, first.fit, first.enabled], ['suggested', 'cover', true]);
    assert.equal(project.timeline.segments.length, 2);

    const request = providers.analyzeCalls[0];
    assert.ok(request?.contactSheet && request.contactSheet.length > 0, 'planche contact envoyée');
    assert.match(request.prompt.user, /\[0\.0-4\.0\] Je vends des mangues au marché\./);
    const projectWork = path.join(storageRoot, 'projects', id, 'work');
    assert.deepEqual(existsSync(projectWork) ? readdirSync(projectWork) : [], [], 'fichiers de travail supprimés');
  });

  it("refuse de lancer l'analyse d'un projet sans vidéo", async () => {
    const { app } = await startApp(fakeProviders());
    const created = (await (await fetch(`${app.baseUrl}/api/projects`, { method: 'POST' })).json()) as CreateProjectResponse;

    const res = await startAnalysis(app, created.project.id);
    const body = (await res.json()) as ApiErrorResponse;

    assert.equal(res.status, 409);
    assert.equal(body.error.code, 'ANALYSIS_NOT_READY');
  });

  it("refuse une deuxième analyse tant que la première n'est pas finie", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = fakeProviders();
    const providers: AnalysisProviders = {
      ...base,
      transcription: {
        transcribe: async (request) => {
          await gate;
          return base.transcription.transcribe(request);
        },
      },
    };
    const { app } = await startApp(providers);
    const id = await projectWithVideo(app);

    assert.equal((await startAnalysis(app, id)).status, 202);
    const second = await startAnalysis(app, id);
    const body = (await second.json()) as ApiErrorResponse;
    release();
    await waitForEnd(app, id);

    assert.equal(second.status, 409);
    assert.equal(body.error.code, 'ANALYSIS_ALREADY_RUNNING');
  });

  it("échoue proprement si aucune parole n'est détectée (TRANSCRIPTION_EMPTY)", async () => {
    const providers = fakeProviders({
      transcription: async () => ({ provider: 'groq', model: 'doublure', language: 'fr', text: '  ', segments: [], words: [] }),
    });
    const { app } = await startApp(providers);
    const id = await projectWithVideo(app);

    await startAnalysis(app, id);
    const project = await waitForEnd(app, id);

    assert.equal(project.analysis.status, 'failed');
    assert.equal(project.analysis.error?.code, 'TRANSCRIPTION_EMPTY');
    assert.equal(project.analysis.error?.stage, 'transcription');
    assert.equal(project.transcript, null);
    assert.equal(providers.analyzeCalls.length, 0);
  });

  it('transmet le code et le caractère « réessayable » d’une panne de fournisseur', async () => {
    const quota = new AppError({ code: 'PROVIDER_RATE_LIMITED', stage: 'analysis', httpStatus: 502, retryable: true, message: 'Trop de demandes.' });
    const { app } = await startApp(fakeProviders({ analyze: async () => Promise.reject(quota) }));
    const id = await projectWithVideo(app);

    await startAnalysis(app, id);
    const project = await waitForEnd(app, id);

    assert.equal(project.analysis.status, 'failed');
    assert.deepEqual(
      { code: project.analysis.error?.code, stage: project.analysis.error?.stage, retryable: project.analysis.error?.retryable },
      { code: 'PROVIDER_RATE_LIMITED', stage: 'analysis', retryable: true },
    );
  });

  it("se replie sur le texte seul si l'analyse avec image échoue, sans prétendre avoir vu les images", async () => {
    const rejected = new AppError({ code: 'PROVIDER_INVALID_RESPONSE', stage: 'analysis', httpStatus: 502, message: 'Image refusée.' });
    const providers = fakeProviders({
      analyze: async (request) => (request.contactSheet === null ? { visual: false } : Promise.reject(rejected)),
    });
    const { app } = await startApp(providers);
    const id = await projectWithVideo(app);

    await startAnalysis(app, id);
    const project = await waitForEnd(app, id);

    assert.equal(project.analysis.status, 'completed');
    assert.equal(project.analysis.visualAnalysisAvailable, false);
    assert.deepEqual(project.analysis.keyframes, []);
    assert.equal(providers.analyzeCalls.length, 2);
    assert.match(providers.analyzeCalls[1]?.prompt.user ?? '', /No image is available/);
  });

  it('échoue si la recherche de B-rolls est impossible pour toutes les suggestions', async () => {
    const outage = new AppError({ code: 'PROVIDER_UNAVAILABLE', stage: 'broll_search', httpStatus: 502, retryable: true, message: 'Pixabay en panne.' });
    const { app } = await startApp(fakeProviders({ search: async () => Promise.reject(outage) }));
    const id = await projectWithVideo(app);

    await startAnalysis(app, id);
    const project = await waitForEnd(app, id);

    assert.equal(project.analysis.status, 'failed');
    assert.equal(project.analysis.error?.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(project.analysis.error?.stage, 'broll_search');
  });

  it('répond 503 PROVIDER_NOT_CONFIGURED quand les fournisseurs ne sont pas configurés', async () => {
    const { app } = await startApp(null);
    const id = await projectWithVideo(app);

    const res = await startAnalysis(app, id);
    const body = (await res.json()) as ApiErrorResponse;

    assert.equal(res.status, 503);
    assert.equal(body.error.code, 'PROVIDER_NOT_CONFIGURED');
  });

  it("plafonne le nombre d'analyses sur 24 h (MAX_ANALYSES_PER_DAY)", async () => {
    const { app } = await startApp(fakeProviders(), { MAX_ANALYSES_PER_DAY: '1' });
    const id = await projectWithVideo(app);

    await startAnalysis(app, id);
    await waitForEnd(app, id);
    const res = await startAnalysis(app, id);
    const body = (await res.json()) as ApiErrorResponse;

    assert.equal(res.status, 429);
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.equal(body.error.retryable, true);
  });

  it("marque « interrompue » une analyse laissée en cours par un arrêt du serveur", async () => {
    const db = openDatabase(':memory:');
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const base = fakeProviders();
      const stalled: AnalysisProviders = {
        ...base,
        transcription: {
          transcribe: async (request) => {
            await gate;
            return base.transcription.transcribe(request);
          },
        },
      };
      const storageRoot = mkdtempSync(path.join(workDir, 'storage-'));
      const env = { STORAGE_ROOT: storageRoot, MIN_VIDEO_DURATION_SECONDS: '3' };
      const first = await startTestApp(env, { db, providers: stalled });
      const id = await projectWithVideo(first);
      await startAnalysis(first, id);
      await first.close();

      // Redémarrage : une nouvelle application sur la même base.
      const second = await startTestApp(env, { db, providers: fakeProviders() });
      const project = ((await (await fetch(`${second.baseUrl}/api/projects/${id}`)).json()) as GetProjectResponse).project;
      await second.close();
      release();

      assert.equal(project.analysis.status, 'failed');
      assert.equal(project.analysis.error?.code, 'ANALYSIS_INTERRUPTED');
      assert.equal(project.analysis.error?.retryable, true);
    } finally {
      db.close();
    }
  });

  it('en PROVIDER_MODE=mock, réalise tout le parcours hors ligne et signale la simulation partout', async () => {
    const { app } = await startApp(undefined, { PROVIDER_MODE: 'mock' });
    const id = await projectWithVideo(app);

    await startAnalysis(app, id);
    const project = await waitForEnd(app, id);

    assert.equal(project.analysis.status, 'completed', JSON.stringify(project.analysis.error));
    assert.equal(project.transcript?.provider, 'simulation');
    assert.equal(project.analysis.model, 'simulation-hors-ligne');
    assert.equal(project.analysis.visualAnalysisAvailable, false);
    assert.ok(project.brollItems.length > 0);
    for (const item of project.brollItems) {
      assert.match(item.reason, /^\[Simulation\]/);
      assert.ok(item.candidates.every((candidate) => candidate.provider === 'simulation'));
    }
  });
});
