import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type {
  ApiErrorResponse,
  BrollCandidate,
  CreateProjectResponse,
  GetProjectResponse,
  Project,
  ProjectStatusResponse,
  RenderStatusResponse,
} from '../src/contract.ts';
import type { AnalysisProviders, FetchLike } from '../src/providers/types.ts';
import { createBrollMediaStore } from '../src/services/broll-media.service.ts';
import { createLocalStorage } from '../src/storage/local-storage.ts';
import { isFfmpegAvailable, makeVideo } from './fixtures.ts';
import { insertRenderJob, silentLogger, startTestApp, testConfig, type TestApp } from './helpers.ts';

const ffmpegReady = await isFfmpegAvailable();
const PIXABAY = 'https://cdn.pixabay.com/video';

/** Doublures de l'analyse : deux suggestions, deux candidats Pixabay chacune. */
function fakeProviders(): AnalysisProviders {
  return {
    transcription: {
      transcribe: async ({ durationSeconds }) => ({
        provider: 'groq',
        model: 'doublure-whisper',
        language: 'fr',
        text: 'Je vends des mangues au marché.',
        segments: [{ startSeconds: 0, endSeconds: durationSeconds, text: 'Je vends des mangues au marché.' }],
        words: [],
      }),
    },
    analysis: {
      analyze: async () => ({
        model: 'doublure/vision',
        visualAnalysisUsed: false,
        summary: 'Une vendeuse parle de son marché.',
        suggestions: [
          { startSeconds: 1, endSeconds: 3, reason: 'Le marché.', searchQuery: 'market' },
          { startSeconds: 5, endSeconds: 7, reason: 'La plage.', searchQuery: 'beach' },
        ],
      }),
    },
    brollSearch: {
      search: async ({ query }) =>
        [1, 2].map((n) => ({
          provider: 'pixabay' as const,
          providerMediaId: `${query}-${n}`,
          title: `${query} ${n}`,
          previewUrl: `${PIXABAY}/${query}-${n}-tiny.mp4`,
          downloadUrl: `${PIXABAY}/${query}-${n}.mp4`,
          sourcePageUrl: `https://pixabay.com/videos/${query}-${n}/`,
          thumbnailUrl: null,
          durationSeconds: 12,
          width: 640,
          height: 360,
          attribution: 'Vidéo de test sur Pixabay',
        })),
    },
  };
}

async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, what: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`Délai dépassé : ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('vidéos B-roll : préchargement et suppression de projet', { skip: ffmpegReady ? false : 'FFmpeg ou ffprobe introuvable' }, () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'alt-broll-media-'));
  const apps: TestApp[] = [];
  let sourceBytes: Uint8Array<ArrayBuffer>;
  let clipBytes: Uint8Array<ArrayBuffer>;

  before(async () => {
    const fixtures = path.join(workDir, 'fixtures');
    mkdirSync(fixtures, { recursive: true });
    sourceBytes = new Uint8Array(await readFile(await makeVideo(fixtures, 'source.mp4', { seconds: 8 })));
    clipBytes = new Uint8Array(await readFile(await makeVideo(fixtures, 'clip.mp4', { seconds: 12, width: 640, height: 360, audio: false })));
  });

  after(async () => {
    await Promise.all(apps.map((app) => app.close()));
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  /** Réseau simulé : sert la vidéo de test pour toute adresse Pixabay, et note chaque appel. */
  function servingFetch(): FetchLike & { calls: string[] } {
    const calls: string[] = [];
    const fetch = (async (url: string) => {
      calls.push(url);
      return new Response(clipBytes, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(clipBytes.length) } });
    }) as FetchLike & { calls: string[] };
    fetch.calls = calls;
    return fetch;
  }

  async function startApp(fetch: FetchLike, providers: AnalysisProviders | null = fakeProviders()) {
    const storageRoot = mkdtempSync(path.join(workDir, 'storage-'));
    const app = await startTestApp(
      { STORAGE_ROOT: storageRoot, MIN_VIDEO_DURATION_SECONDS: '3', RATE_LIMIT_WRITES_PER_HOUR: '1000' },
      { providers, fetch },
    );
    apps.push(app);
    return { app, projectDir: (id: string) => path.join(storageRoot, 'projects', id) };
  }

  async function analyzedProject(app: TestApp): Promise<Project> {
    const created = (await (await fetch(`${app.baseUrl}/api/projects`, { method: 'POST' })).json()) as CreateProjectResponse;
    const id = created.project.id;
    const form = new FormData();
    form.append('video', new Blob([sourceBytes], { type: 'video/mp4' }), 'source.mp4');
    assert.equal((await fetch(`${app.baseUrl}/api/projects/${id}/upload`, { method: 'POST', body: form })).status, 200);
    assert.equal((await fetch(`${app.baseUrl}/api/projects/${id}/analyze`, { method: 'POST' })).status, 202);
    await until(
      async () => ((await (await fetch(`${app.baseUrl}/api/projects/${id}/status`)).json()) as ProjectStatusResponse).analysis.status,
      (status) => status === 'completed' || status === 'failed',
      "fin de l'analyse",
    );
    return ((await (await fetch(`${app.baseUrl}/api/projects/${id}`)).json()) as GetProjectResponse).project;
  }

  const brollFiles = (dir: string): string[] => (existsSync(path.join(dir, 'broll')) ? readdirSync(path.join(dir, 'broll')).sort() : []);

  it("télécharge les vidéos choisies dès la fin de l'analyse, puis l'export n'attend plus le réseau", async () => {
    const network = servingFetch();
    const { app, projectDir } = await startApp(network);
    const project = await analyzedProject(app);
    const selected = project.brollItems.map((item) => `${item.selectedCandidateId}.mp4`).sort();

    await until(() => brollFiles(projectDir(project.id)), (files) => files.join() === selected.join(), 'préchargement');
    const downloads = network.calls.length;
    const res = await fetch(`${app.baseUrl}/api/projects/${project.id}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: project.revision }),
    });
    const status = await until(
      async () => ((await (await fetch(`${app.baseUrl}/api/projects/${project.id}/render/status`)).json()) as RenderStatusResponse).render.status,
      (value) => value !== 'preparing',
      "préparation de l'export",
    );

    assert.equal(project.analysis.status, 'completed');
    assert.equal(downloads, 2, 'un téléchargement par B-roll monté');
    assert.equal(res.status, 202);
    assert.equal(status, 'queued');
    assert.equal(network.calls.length, downloads, "l'export réutilise les fichiers préchargés");
  });

  it('précharge aussitôt une autre proposition choisie dans l’éditeur', async () => {
    const network = servingFetch();
    const { app, projectDir } = await startApp(network);
    const project = await analyzedProject(app);
    const [first] = project.brollItems;
    const other = first?.candidates[1];
    assert.ok(first && other);
    await until(() => brollFiles(projectDir(project.id)).length, (count) => count === 2, 'préchargement initial');

    const res = await fetch(`${app.baseUrl}/api/projects/${project.id}/timeline`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevision: project.revision, items: [{ id: first.id, selectedCandidateId: other.id }] }),
    });

    assert.equal(res.status, 200);
    await until(() => brollFiles(projectDir(project.id)), (files) => files.includes(`${other.id}.mp4`), 'préchargement du nouveau choix');
    assert.equal(network.calls.filter((url) => url === other.downloadUrl).length, 1);
  });

  it('supprime le projet, ses exports et tous ses fichiers', async () => {
    const { app, projectDir } = await startApp(servingFetch());
    const project = await analyzedProject(app);
    await until(() => brollFiles(projectDir(project.id)).length, (count) => count === 2, 'préchargement');
    insertRenderJob(app.db, { id: 'job-ancien', projectId: project.id, status: 'completed', createdAtMs: Date.now() });

    const res = await fetch(`${app.baseUrl}/api/projects/${project.id}`, { method: 'DELETE' });
    const after = await fetch(`${app.baseUrl}/api/projects/${project.id}`);
    const again = await fetch(`${app.baseUrl}/api/projects/${project.id}`, { method: 'DELETE' });

    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
    assert.equal(after.status, 404);
    assert.equal(again.status, 404);
    assert.equal(existsSync(projectDir(project.id)), false);
    assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM render_jobs WHERE project_id = ?').get(project.id)?.n, 0);
  });

  it('refuse la suppression pendant un export ou une analyse', async () => {
    let releaseTranscription = (): void => {};
    const gate = new Promise<void>((resolve) => {
      releaseTranscription = resolve;
    });
    const stalled = fakeProviders();
    const providers: AnalysisProviders = {
      ...stalled,
      transcription: {
        transcribe: async (request) => {
          await gate;
          return stalled.transcription.transcribe(request);
        },
      },
    };
    const { app, projectDir } = await startApp(servingFetch(), providers);
    const created = (await (await fetch(`${app.baseUrl}/api/projects`, { method: 'POST' })).json()) as CreateProjectResponse;
    const id = created.project.id;

    insertRenderJob(app.db, { id: 'job-actif', projectId: id, status: 'rendering', createdAtMs: Date.now() });
    const duringRender = await fetch(`${app.baseUrl}/api/projects/${id}`, { method: 'DELETE' });
    app.db.prepare("UPDATE render_jobs SET status = 'completed' WHERE id = 'job-actif'").run();

    const form = new FormData();
    form.append('video', new Blob([sourceBytes], { type: 'video/mp4' }), 'source.mp4');
    await fetch(`${app.baseUrl}/api/projects/${id}/upload`, { method: 'POST', body: form });
    await fetch(`${app.baseUrl}/api/projects/${id}/analyze`, { method: 'POST' });
    const duringAnalysis = await fetch(`${app.baseUrl}/api/projects/${id}`, { method: 'DELETE' });
    releaseTranscription();

    for (const res of [duringRender, duringAnalysis]) {
      const body = (await res.json()) as ApiErrorResponse;
      assert.equal(res.status, 409);
      assert.deepEqual([body.error.code, body.error.retryable], ['CONFLICT', true]);
    }
    assert.equal((await fetch(`${app.baseUrl}/api/projects/${id}`)).status, 200, 'projet conservé');
    // Fin du travail de fond avant le nettoyage du dossier de test.
    await until(() => brollFiles(projectDir(id)).length, (count) => count === 2, "fin de l'analyse et du préchargement");
  });

  it('annule un préchargement en cours quand le projet est supprimé', async () => {
    const started: string[] = [];
    let aborted = 0;
    const hanging: FetchLike = (url, init) => {
      started.push(url);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted += 1;
          reject(init.signal?.reason);
        });
      });
    };
    const { app, projectDir } = await startApp(hanging);
    const project = await analyzedProject(app);
    await until(() => started.length, (count) => count === 2, 'début du préchargement');

    const res = await fetch(`${app.baseUrl}/api/projects/${project.id}`, { method: 'DELETE' });

    assert.equal(res.status, 204);
    assert.equal(aborted, 2);
    assert.equal(existsSync(projectDir(project.id)), false);
  });
});

describe('BrollMediaStore', { skip: ffmpegReady ? false : 'FFmpeg ou ffprobe introuvable' }, () => {
  it('ne télécharge qu’une fois un même fichier demandé en parallèle', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'alt-broll-store-'));
    try {
      const clip = new Uint8Array(await readFile(await makeVideo(root, 'clip.mp4', { seconds: 3, width: 320, height: 240, audio: false })));
      let calls = 0;
      const store = createBrollMediaStore({
        config: testConfig(),
        logger: silentLogger,
        storage: createLocalStorage(path.join(root, 'storage')),
        fetch: async () => {
          calls += 1;
          return new Response(clip, { status: 200 });
        },
      });
      const candidate: BrollCandidate = {
        id: 'cand_parallele',
        provider: 'pixabay',
        providerMediaId: '1',
        title: 'clip',
        previewUrl: `${PIXABAY}/1-tiny.mp4`,
        downloadUrl: `${PIXABAY}/1.mp4`,
        sourcePageUrl: 'https://pixabay.com/videos/1/',
        thumbnailUrl: null,
        durationSeconds: 3,
        width: 320,
        height: 240,
        attribution: 'Vidéo de test sur Pixabay',
      };
      const projectId = '6f1c2a10-0000-4000-8000-000000000001';

      const [a, b] = await Promise.all([store.ensure(projectId, candidate), store.ensure(projectId, candidate)]);
      const again = await store.ensure(projectId, candidate);
      await store.release(projectId);

      assert.equal(calls, 1);
      assert.deepEqual(a, b);
      assert.deepEqual(again, a);
      assert.ok(Math.abs(a.durationSeconds - 3) < 0.1);
      await assert.rejects(store.ensure(projectId, candidate), /projet supprimé/);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
