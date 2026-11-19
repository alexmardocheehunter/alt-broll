import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type {
  AnalysisStatus,
  ApiErrorResponse,
  BrollCandidate,
  BrollItem,
  ErrorCode,
  Project,
  RenderJobPayload,
  RenderJobRow,
  RenderStatusResponse,
  SourceVideo,
  StartRenderResponse,
} from '../src/contract.ts';
import { openDatabase } from '../src/db/database.ts';
import type { FetchLike } from '../src/providers/types.ts';
import { createProjectRepository } from '../src/repositories/project.repository.ts';
import { initialAnalysis } from '../src/services/project.service.ts';
import { outputFormat, outputLongSide } from '../src/services/output-format.ts';
import { downloadFileName } from '../src/services/render.service.ts';
import { isFfmpegAvailable, makeVideo } from './fixtures.ts';
import { startTestApp, type TestApp } from './helpers.ts';

const ffmpegReady = await isFfmpegAvailable();

const SOURCE: SourceVideo = {
  originalName: 'Présentation Awa.mp4',
  storedFileName: 'source-test.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 1_000,
  durationSeconds: 60,
  width: 1920,
  height: 1080,
  frameRate: 30,
  videoCodec: 'h264',
  audioPresent: true,
  audioCodec: 'aac',
};

const PIXABAY = 'https://cdn.pixabay.com/video';

function candidate(id: string, downloadUrl: string, provider: BrollCandidate['provider'] = 'pixabay'): BrollCandidate {
  return {
    id,
    provider,
    providerMediaId: id,
    title: id,
    previewUrl: downloadUrl,
    downloadUrl,
    sourcePageUrl: 'https://pixabay.com/videos/test/',
    thumbnailUrl: null,
    durationSeconds: 12,
    width: 640,
    height: 360,
    attribution: 'Vidéo de test sur Pixabay',
  };
}

function item(id: string, startSeconds: number, endSeconds: number, candidates: BrollCandidate[], extra: Partial<BrollItem> = {}): BrollItem {
  return {
    id,
    startSeconds,
    endSeconds,
    reason: 'raison',
    searchQuery: 'query',
    candidates,
    selectedCandidateId: candidates[0]?.id ?? null,
    status: 'suggested',
    fit: 'cover',
    enabled: true,
    ...extra,
  };
}

describe('export (POST /render, statut, téléchargement)', { skip: ffmpegReady ? false : 'FFmpeg ou ffprobe introuvable' }, () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'alt-broll-render-'));
  const storageRoot = path.join(workDir, 'storage');
  const served = new Map<string, Uint8Array<ArrayBuffer>>();
  const fetchCalls: string[] = [];
  let app: TestApp;
  let clip12s: Uint8Array<ArrayBuffer>;
  let clip3s: Uint8Array<ArrayBuffer>;

  /** Réseau simulé : seules les URL enregistrées répondent. */
  const fakeFetch: FetchLike = async (url) => {
    fetchCalls.push(url);
    const bytes = served.get(url);
    if (bytes === undefined) return new Response('introuvable', { status: 404 });
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) } });
  };

  before(async () => {
    const fixtures = path.join(workDir, 'fixtures');
    mkdirSync(fixtures, { recursive: true });
    clip12s = new Uint8Array(await readFile(await makeVideo(fixtures, 'clip12.mp4', { seconds: 12, width: 640, height: 360, audio: false })));
    clip3s = new Uint8Array(await readFile(await makeVideo(fixtures, 'clip3.mp4', { seconds: 3, width: 640, height: 360, audio: false })));
    app = await startTestApp({ STORAGE_ROOT: storageRoot, RATE_LIMIT_WRITES_PER_HOUR: '1000' }, { fetch: fakeFetch });
  });

  after(async () => {
    await app.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  /** Projet analysé ; par défaut A (5–8 s) et B (20–24 s) montés, C (40–43 s) refusé. */
  function seedProject(options: { items?: BrollItem[]; analysis?: AnalysisStatus } = {}): string {
    const id = randomUUID();
    const tag = id.slice(0, 8);
    createProjectRepository(app.db).insert(
      id,
      {
        source: SOURCE,
        transcript: null,
        analysis: { ...initialAnalysis(), status: options.analysis ?? 'completed' },
        brollItems: options.items ?? [
          item('broll_a', 5, 8, [candidate(`cand_a_${tag}`, `${PIXABAY}/a-${tag}.mp4`)]),
          item('broll_b', 20, 24, [candidate(`cand_b_${tag}`, `${PIXABAY}/b-${tag}.mp4`)]),
          item('broll_c', 40, 43, [candidate(`cand_c_${tag}`, `${PIXABAY}/c-${tag}.mp4`)], { status: 'rejected' }),
        ],
      },
      Date.now(),
    );
    for (const letter of ['a', 'b', 'c']) served.set(`${PIXABAY}/${letter}-${tag}.mp4`, clip12s);
    return id;
  }

  function startRender(id: string, body: unknown = { revision: 0 }): Promise<Response> {
    return fetch(`${app.baseUrl}/api/projects/${id}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function waitWhilePreparing(id: string): Promise<RenderStatusResponse> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const status = (await (await fetch(`${app.baseUrl}/api/projects/${id}/render/status`)).json()) as RenderStatusResponse;
      if (status.render.status !== 'preparing') return status;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('La préparation ne se termine pas.');
  }

  function jobRow(jobId: string): RenderJobRow {
    const row = app.db.prepare('SELECT * FROM render_jobs WHERE id = ?').get(jobId) as RenderJobRow | undefined;
    assert.ok(row, `job ${jobId} introuvable`);
    return row;
  }

  /** Ce que ferait le worker : écrire le MP4 final et terminer le job. */
  function completeLikeWorker(projectId: string, jobId: string): Uint8Array {
    const payload = JSON.parse(jobRow(jobId).payload) as RenderJobPayload;
    const output = path.join(storageRoot, 'projects', projectId, payload.output.file);
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, clip12s);
    app.db
      .prepare(
        `UPDATE render_jobs SET status = 'completed', progress = 1, output_size_bytes = ?, output_duration_seconds = 60,
                completed_at_ms = ?, updated_at_ms = ? WHERE id = ?`,
      )
      .run(clip12s.length, Date.now(), Date.now(), jobId);
    return clip12s;
  }

  async function expectRejected(res: Response, status: number, code: ErrorCode): Promise<ApiErrorResponse> {
    const body = (await res.json()) as ApiErrorResponse;
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(body.error.code, code);
    return body;
  }

  it('crée le job, télécharge les seuls B-rolls retenus et met le job en file pour le worker', async () => {
    const id = seedProject();
    const tag = id.slice(0, 8);
    const callsBefore = fetchCalls.length;

    const res = await startRender(id);
    const { render } = (await res.json()) as StartRenderResponse;
    const status = await waitWhilePreparing(id);

    assert.equal(res.status, 202);
    assert.equal(render.status, 'preparing');
    assert.ok(render.jobId);
    assert.equal(status.render.status, 'queued', JSON.stringify(status.render.error));
    assert.deepEqual(fetchCalls.slice(callsBefore).sort(), [`${PIXABAY}/a-${tag}.mp4`, `${PIXABAY}/b-${tag}.mp4`]);

    const payload = JSON.parse(jobRow(render.jobId).payload) as RenderJobPayload;
    assert.equal(payload.source.file, 'source/source-test.mp4');
    assert.equal(payload.output.file, `output/${render.jobId}.mp4`);
    assert.deepEqual([payload.output.width, payload.output.height, payload.output.frameRate], [1920, 1080, 30]);
    assert.deepEqual(
      payload.segments.map((segment) => [segment.brollItemId, segment.startSeconds, segment.endSeconds, segment.media.file]),
      [
        ['broll_a', 5, 8, `broll/cand_a_${tag}.mp4`],
        ['broll_b', 20, 24, `broll/cand_b_${tag}.mp4`],
      ],
    );
    const media = payload.segments[0]?.media;
    assert.ok(media && Math.abs(media.durationSeconds - 12) < 0.1, 'durée mesurée sur le fichier');
    assert.deepEqual([media.width, media.height], [640, 360]);
    assert.deepEqual(readdirSync(path.join(storageRoot, 'projects', id, 'broll')).sort(), [`cand_a_${tag}.mp4`, `cand_b_${tag}.mp4`]);
  });

  it('réutilise les B-rolls déjà présents pour un nouvel export', async () => {
    const id = seedProject();
    const first = ((await (await startRender(id)).json()) as StartRenderResponse).render;
    await waitWhilePreparing(id);
    assert.ok(first.jobId);
    completeLikeWorker(id, first.jobId);
    const callsBefore = fetchCalls.length;

    const res = await startRender(id);
    const status = await waitWhilePreparing(id);

    assert.equal(res.status, 202);
    assert.equal(status.render.status, 'queued');
    assert.equal(fetchCalls.length, callsBefore, 'aucun nouveau téléchargement');
  });

  it('borne un segment à la durée réelle de la vidéo B-roll, plus courte que la durée annoncée', async () => {
    const tag = randomUUID().slice(0, 8);
    const shortUrl = `${PIXABAY}/court-${tag}.mp4`;
    served.set(shortUrl, clip3s);
    const id = seedProject({ items: [item('broll_b', 20, 24, [candidate(`cand_court_${tag}`, shortUrl)])] });

    const { render } = (await (await startRender(id)).json()) as StartRenderResponse;
    await waitWhilePreparing(id);
    assert.ok(render.jobId);
    const [segment] = (JSON.parse(jobRow(render.jobId).payload) as RenderJobPayload).segments;

    assert.ok(segment);
    assert.ok(Math.abs(segment.endSeconds - 23) < 0.05, `fin ramenée à 23 s, reçu ${segment.endSeconds}`);
    assert.ok(segment.endSeconds - segment.startSeconds <= segment.media.durationSeconds);
  });

  it("échoue proprement si une vidéo B-roll ne peut pas être téléchargée, sans laisser de fichier partiel", async () => {
    const tag = randomUUID().slice(0, 8);
    const id = seedProject({ items: [item('broll_a', 5, 8, [candidate(`cand_absent_${tag}`, `${PIXABAY}/absent-${tag}.mp4`)])] });

    await startRender(id);
    const { render } = await waitWhilePreparing(id);

    assert.equal(render.status, 'failed');
    assert.deepEqual([render.error?.code, render.error?.stage, render.error?.retryable], ['RENDER_MEDIA_DOWNLOAD_FAILED', 'render', true]);
    const brollDir = path.join(storageRoot, 'projects', id, 'broll');
    assert.deepEqual(existsSync(brollDir) ? readdirSync(brollDir) : [], []);
  });

  it("refuse de télécharger hors des domaines Pixabay, sans même appeler l'adresse", async () => {
    const evil = 'https://evil.example/piege.mp4';
    const id = seedProject({ items: [item('broll_a', 5, 8, [candidate('cand_piege', evil)])] });

    await startRender(id);
    const { render } = await waitWhilePreparing(id);

    assert.equal(render.status, 'failed');
    assert.equal(render.error?.code, 'RENDER_MEDIA_DOWNLOAD_FAILED');
    assert.ok(!fetchCalls.includes(evil));
  });

  it("refuse un fichier téléchargé qui n'est pas une vidéo", async () => {
    const tag = randomUUID().slice(0, 8);
    const url = `${PIXABAY}/texte-${tag}.mp4`;
    served.set(url, new Uint8Array(new TextEncoder().encode('ceci est une page HTML')));
    const id = seedProject({ items: [item('broll_a', 5, 8, [candidate(`cand_texte_${tag}`, url)])] });

    await startRender(id);
    const { render } = await waitWhilePreparing(id);

    assert.equal(render.status, 'failed');
    assert.equal(render.error?.code, 'RENDER_MEDIA_DOWNLOAD_FAILED');
    assert.deepEqual(readdirSync(path.join(storageRoot, 'projects', id, 'broll')), []);
  });

  it("vérifie les conditions avant de créer l'export", async () => {
    await expectRejected(await startRender(seedProject({ analysis: 'idle' })), 409, 'RENDER_NOT_READY');
    await expectRejected(await startRender(seedProject(), { revision: 5 }), 409, 'REVISION_CONFLICT');
    await expectRejected(await startRender(seedProject(), {}), 400, 'VALIDATION_FAILED');
    await expectRejected(await startRender(randomUUID()), 404, 'NOT_FOUND');

    const nothingKept = seedProject({ items: [item('broll_a', 5, 8, [candidate('cand_refuse', `${PIXABAY}/x.mp4`)], { status: 'rejected' })] });
    await expectRejected(await startRender(nothingKept), 422, 'RENDER_NO_SEGMENTS');

    const busy = seedProject();
    assert.equal((await startRender(busy)).status, 202);
    await expectRejected(await startRender(busy), 409, 'RENDER_ALREADY_ACTIVE');
    await waitWhilePreparing(busy);
  });

  it("ne sert le MP4 qu'une fois l'export terminé, en pièce jointe et par plages", async () => {
    const id = seedProject();
    await expectRejected(await fetch(`${app.baseUrl}/api/projects/${id}/download`), 409, 'DOWNLOAD_NOT_READY');
    const { render } = (await (await startRender(id)).json()) as StartRenderResponse;
    await waitWhilePreparing(id);
    assert.ok(render.jobId);
    await expectRejected(await fetch(`${app.baseUrl}/api/projects/${id}/download`), 409, 'DOWNLOAD_NOT_READY');

    const written = completeLikeWorker(id, render.jobId);
    const full = await fetch(`${app.baseUrl}/api/projects/${id}/download`);
    const partial = await fetch(`${app.baseUrl}/api/projects/${id}/download`, { headers: { Range: 'bytes=0-99' } });
    const project = ((await (await fetch(`${app.baseUrl}/api/projects/${id}`)).json()) as { project: Project }).project;

    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.match(full.headers.get('content-disposition') ?? '', /^attachment;.*Pr%C3%A9sentation%20Awa-alt-broll\.mp4/);
    assert.equal((await full.arrayBuffer()).byteLength, written.length);
    assert.equal(partial.status, 206);
    assert.equal(project.render.status, 'completed');
    assert.equal(project.urls.download, `http://localhost:3000/api/projects/${id}/download`);
  });

  it("en simulation, fabrique localement les B-rolls simulés sans accès réseau", async () => {
    const callsBefore = fetchCalls.length;
    const id = seedProject({
      items: [item('broll_a', 5, 8, [candidate('cand_simule', 'https://simulation.invalid/broll/x.mp4', 'simulation')])],
    });

    await startRender(id);
    const { render } = await waitWhilePreparing(id);

    assert.equal(render.status, 'queued', JSON.stringify(render.error));
    assert.equal(fetchCalls.length, callsBefore);
    assert.ok(existsSync(path.join(storageRoot, 'projects', id, 'broll', 'cand_simule.mp4')));
  });
});

describe("reprise d'un export interrompu", () => {
  it('marque « interrompu » un export resté en préparation lors d’un arrêt du serveur', async () => {
    const db = openDatabase(':memory:');
    try {
      const projectId = randomUUID();
      createProjectRepository(db).insert(projectId, { source: SOURCE, transcript: null, analysis: initialAnalysis(), brollItems: [] }, Date.now());
      db.prepare(
        `INSERT INTO render_jobs (id, project_id, project_revision, status, payload, created_at_ms, updated_at_ms)
         VALUES ('job-orphelin', ?, 0, 'preparing', '{}', 1, 1)`,
      ).run(projectId);

      const app = await startTestApp({}, { db });
      const status = (await (await fetch(`${app.baseUrl}/api/projects/${projectId}/render/status`)).json()) as RenderStatusResponse;
      await app.close();

      assert.equal(status.render.status, 'failed');
      assert.equal(status.render.error?.code, 'RENDER_INTERRUPTED');
      assert.equal(status.render.error?.retryable, true);
    } finally {
      db.close();
    }
  });
});

describe('format de sortie', () => {
  it('garde la source jusqu’au 1080p, réduit au-delà, respecte la verticale et arrondit au pair', () => {
    const at = (width: number, height: number, frameRate = 30, max: 720 | 1080 = 1080) => outputFormat({ width, height, frameRate }, max);

    assert.deepEqual(at(1920, 1080), { width: 1920, height: 1080, frameRate: 30 });
    assert.deepEqual(at(3840, 2160), { width: 1920, height: 1080, frameRate: 30 });
    assert.deepEqual(at(1080, 1920), { width: 1080, height: 1920, frameRate: 30 });
    assert.deepEqual(at(2000, 1500), { width: 1440, height: 1080, frameRate: 30 });
    assert.deepEqual(at(1920, 1080, 30, 720), { width: 1280, height: 720, frameRate: 30 });
    assert.deepEqual(at(853, 481, 29.97), { width: 852, height: 480, frameRate: 29.97 });
    assert.equal(at(1920, 1080, 120).frameRate, 60);
  });

  it("donne le grand côté de l'export, taille visée pour les B-rolls téléchargés", () => {
    assert.equal(outputLongSide({ width: 1280, height: 720, frameRate: 30 }, 1080), 1280);
    assert.equal(outputLongSide({ width: 3840, height: 2160, frameRate: 30 }, 1080), 1920);
    assert.equal(outputLongSide({ width: 1080, height: 1920, frameRate: 30 }, 720), 1280);
  });

  it('propose un nom de fichier lisible et sûr', () => {
    assert.equal(downloadFileName('Présentation Awa.mp4'), 'Présentation Awa-alt-broll.mp4');
    assert.equal(downloadFileName('../../etc/passwd.mp4'), 'etc-passwd-alt-broll.mp4');
    assert.equal(downloadFileName(null), 'video-alt-broll.mp4');
  });
});
