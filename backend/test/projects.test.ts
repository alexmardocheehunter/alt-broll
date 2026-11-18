import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type {
  ApiErrorResponse,
  CreateProjectResponse,
  GetProjectResponse,
  Project,
  ProjectStatusResponse,
  SuggestionsResponse,
} from '../src/contract.ts';
import { insertRenderJob, startTestApp, type TestApp } from './helpers.ts';

describe('projets', () => {
  let app: TestApp;

  before(async () => {
    app = await startTestApp();
  });

  after(async () => {
    await app.close();
  });

  async function createProject(): Promise<Project> {
    const res = await fetch(`${app.baseUrl}/api/projects`, { method: 'POST' });
    assert.equal(res.status, 201);
    return ((await res.json()) as CreateProjectResponse).project;
  }

  async function getProject(id: string): Promise<Project> {
    const res = await fetch(`${app.baseUrl}/api/projects/${id}`);
    assert.equal(res.status, 200);
    return ((await res.json()) as GetProjectResponse).project;
  }

  it('POST /api/projects crée un projet vide conforme au contrat', async () => {
    const project = await createProject();

    assert.match(project.id, /^[0-9a-f-]{36}$/);
    assert.equal(project.schemaVersion, 1);
    assert.equal(project.revision, 0);
    assert.equal(project.source, null);
    assert.equal(project.transcript, null);
    assert.deepEqual(project.analysis, {
      status: 'idle',
      stage: null,
      model: null,
      visualAnalysisAvailable: false,
      keyframes: [],
      summary: null,
      startedAt: null,
      completedAt: null,
      error: null,
    });
    assert.deepEqual(project.brollItems, []);
    assert.deepEqual(project.timeline, { segments: [] });
    assert.equal(project.render.status, 'idle');
    assert.deepEqual(project.urls, { source: null, download: null });
    assert.equal(project.createdAt, project.updatedAt);
    assert.ok(!Number.isNaN(Date.parse(project.createdAt)));
  });

  it('GET /api/projects/:id renvoie le projet créé', async () => {
    const created = await createProject();

    assert.deepEqual(await getProject(created.id), created);
  });

  it('GET …/status et …/suggestions décrivent un projet sans vidéo', async () => {
    const { id } = await createProject();

    const status = (await (await fetch(`${app.baseUrl}/api/projects/${id}/status`)).json()) as ProjectStatusResponse;
    const suggestions = (await (
      await fetch(`${app.baseUrl}/api/projects/${id}/suggestions`)
    ).json()) as SuggestionsResponse;

    assert.deepEqual(status, {
      projectId: id,
      revision: 0,
      sourceUploaded: false,
      analysis: { status: 'idle', stage: null, error: null },
      render: { status: 'idle', progress: 0, error: null },
    });
    assert.deepEqual(suggestions, {
      projectId: id,
      revision: 0,
      visualAnalysisAvailable: false,
      brollItems: [],
      timeline: { segments: [] },
    });
  });

  it('répond 404 à un projet inexistant ou à un identifiant invalide', async () => {
    for (const id of [randomUUID(), '..%2F..%2Fetc', 'x'.repeat(100), '%00']) {
      const res = await fetch(`${app.baseUrl}/api/projects/${id}`);
      const body = (await res.json()) as ApiErrorResponse;

      assert.equal(res.status, 404, id);
      assert.equal(body.error.code, 'NOT_FOUND');
    }
  });

  it("reflète l'état du dernier export enregistré par le worker", async () => {
    const { id } = await createProject();

    insertRenderJob(app.db, {
      id: 'job-reussi',
      projectId: id,
      status: 'completed',
      createdAtMs: 1_000,
      startedAtMs: 2_000,
      completedAtMs: 9_000,
      outputSizeBytes: 5_000_000,
      outputDurationSeconds: 30.03,
    });
    const completed = await getProject(id);

    assert.equal(completed.render.status, 'completed');
    assert.equal(completed.render.jobId, 'job-reussi');
    assert.equal(completed.render.revision, 0);
    assert.deepEqual(completed.render.outputFile, { sizeBytes: 5_000_000, durationSeconds: 30.03 });
    assert.equal(completed.render.completedAt, new Date(9_000).toISOString());
    assert.equal(completed.urls.download, `http://localhost:3000/api/projects/${id}/download`);

    insertRenderJob(app.db, {
      id: 'job-echoue',
      projectId: id,
      status: 'failed',
      createdAtMs: 10_000,
      errorCode: 'RENDER_FFMPEG_FAILED',
      errorMessage: "  L'export a échoué pendant le montage.  ",
    });
    const failed = await getProject(id);

    assert.equal(failed.render.status, 'failed');
    assert.deepEqual(failed.render.error, {
      code: 'RENDER_FFMPEG_FAILED',
      stage: 'render',
      message: "L'export a échoué pendant le montage.",
      retryable: true,
    });
    assert.equal(failed.urls.download, null);
  });

  it("remplace un code d'erreur inconnu du worker par INTERNAL_ERROR et borne son message", async () => {
    const { id } = await createProject();

    insertRenderJob(app.db, {
      id: 'job-inconnu',
      projectId: id,
      status: 'failed',
      createdAtMs: 1,
      errorCode: 'CODE_INVENTE',
      errorMessage: 'x'.repeat(1_000),
    });
    const project = await getProject(id);

    assert.equal(project.render.error?.code, 'INTERNAL_ERROR');
    assert.equal(project.render.error?.message.length, 300);
  });
});

describe('limitation du débit', () => {
  it('refuse les créations au-delà de la limite horaire (429 RATE_LIMITED)', async () => {
    const app = await startTestApp({ RATE_LIMIT_WRITES_PER_HOUR: '2' });
    try {
      const responses: Response[] = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        responses.push(await fetch(`${app.baseUrl}/api/projects`, { method: 'POST' }));
      }
      const rejected = responses[2];
      assert.ok(rejected);
      const body = (await rejected.json()) as ApiErrorResponse;

      assert.deepEqual(
        responses.map((res) => res.status),
        [201, 201, 429],
      );
      assert.equal(body.error.code, 'RATE_LIMITED');
      assert.equal(body.error.retryable, true);
      assert.ok(Number(rejected.headers.get('retry-after')) > 0);
    } finally {
      await app.close();
    }
  });

  async function createFrom(app: TestApp, clientIp: string): Promise<number> {
    const res = await fetch(`${app.baseUrl}/api/projects`, { method: 'POST', headers: { 'X-Forwarded-For': clientIp } });
    await res.arrayBuffer();
    return res.status;
  }

  it("derrière un tunnel local (TRUST_PROXY=loopback), compte chaque client séparément", async () => {
    const app = await startTestApp({ RATE_LIMIT_WRITES_PER_HOUR: '1', TRUST_PROXY: 'loopback' });
    try {
      assert.equal(await createFrom(app, '203.0.113.1'), 201);
      assert.equal(await createFrom(app, '203.0.113.1'), 429);
      assert.equal(await createFrom(app, '203.0.113.2'), 201);
    } finally {
      await app.close();
    }
  });

  it("sans TRUST_PROXY, ignore l'en-tête X-Forwarded-For, que le client peut falsifier", async () => {
    const app = await startTestApp({ RATE_LIMIT_WRITES_PER_HOUR: '1' });
    try {
      assert.equal(await createFrom(app, '203.0.113.1'), 201);
      assert.equal(await createFrom(app, '203.0.113.2'), 429);
    } finally {
      await app.close();
    }
  });
});
