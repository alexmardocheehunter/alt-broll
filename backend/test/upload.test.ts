import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import type {
  ApiErrorResponse,
  CreateProjectResponse,
  ErrorCode,
  GetProjectResponse,
  Project,
  UploadSourceResponse,
} from '../src/contract.ts';
import { describeDuration, sanitizeOriginalName } from '../src/services/upload.service.ts';
import { isFfmpegAvailable, makeVideo, withRotation } from './fixtures.ts';
import { startTestApp, type TestApp } from './helpers.ts';

const ffmpegReady = await isFfmpegAvailable();
const MB = 1024 * 1024;

interface Fixtures {
  valid: string;
  short: string;
  long: string;
  silent: string;
  hevc: string;
  rotated: string;
  corrupted: string;
}

describe('import de la vidéo source', { skip: ffmpegReady ? false : 'FFmpeg ou ffprobe introuvable' }, () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'alt-broll-upload-'));
  const storageRoot = path.join(workDir, 'storage');
  const uploadTmpDir = path.join(storageRoot, 'tmp', 'uploads');
  let files: Fixtures;
  let app: TestApp;

  before(async () => {
    const dir = path.join(workDir, 'fixtures');
    mkdirSync(dir, { recursive: true });
    const [valid, short, long, silent, hevc] = await Promise.all([
      makeVideo(dir, 'valide.mp4', { seconds: 5 }),
      makeVideo(dir, 'courte.mp4', { seconds: 2 }),
      makeVideo(dir, 'longue.mp4', { seconds: 9 }),
      makeVideo(dir, 'muette.mp4', { seconds: 5, audio: false }),
      makeVideo(dir, 'hevc.mp4', { seconds: 4, codec: 'libx265' }),
    ]);
    const rotated = await withRotation(valid, path.join(dir, 'pivotee.mp4'), 90);
    const corrupted = path.join(dir, 'abimee.mp4');
    await writeFile(corrupted, Buffer.concat([(await readFile(valid)).subarray(0, 64), Buffer.alloc(8192, 0x5a)]));
    files = { valid, short, long, silent, hevc, rotated, corrupted };

    app = await startTestApp({
      STORAGE_ROOT: storageRoot,
      MIN_VIDEO_DURATION_SECONDS: '3',
      MAX_VIDEO_DURATION_SECONDS: '8',
      MAX_UPLOAD_MB: '2',
      RATE_LIMIT_WRITES_PER_HOUR: '1000',
    });
  });

  after(async () => {
    await app.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  afterEach(() => {
    // Aucun envoi, accepté ou refusé, ne doit laisser de fichier temporaire.
    assert.deepEqual(existsSync(uploadTmpDir) ? readdirSync(uploadTmpDir) : [], []);
  });

  async function createProject(): Promise<string> {
    const res = await fetch(`${app.baseUrl}/api/projects`, { method: 'POST' });
    return ((await res.json()) as CreateProjectResponse).project.id;
  }

  async function getProject(id: string): Promise<Project> {
    return ((await (await fetch(`${app.baseUrl}/api/projects/${id}`)).json()) as GetProjectResponse).project;
  }

  function upload(
    projectId: string,
    content: Uint8Array<ArrayBuffer>,
    fileName: string,
    options: { field?: string; type?: string } = {},
  ): Promise<Response> {
    const form = new FormData();
    form.append(options.field ?? 'video', new Blob([content], { type: options.type ?? 'video/mp4' }), fileName);
    return fetch(`${app.baseUrl}/api/projects/${projectId}/upload`, { method: 'POST', body: form });
  }

  async function uploadFile(
    projectId: string,
    file: string,
    fileName: string = path.basename(file),
    options: { field?: string; type?: string } = {},
  ): Promise<Response> {
    return upload(projectId, new Uint8Array(await readFile(file)), fileName, options);
  }

  async function expectAccepted(res: Response): Promise<Project> {
    const body: unknown = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    return (body as UploadSourceResponse).project;
  }

  async function expectRejected(res: Response, status: number, code: ErrorCode): Promise<ApiErrorResponse> {
    const body = (await res.json()) as ApiErrorResponse;
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(body.error.code, code);
    return body;
  }

  it('accepte une vidéo MP4 valide, en extrait les métadonnées et la range dans le projet', async () => {
    const projectId = await createProject();

    const project = await expectAccepted(await uploadFile(projectId, files.valid, 'présentation d’Awa.mp4'));

    const { source } = project;
    assert.ok(source);
    assert.equal(source.originalName, 'présentation d’Awa.mp4');
    assert.equal(source.mimeType, 'video/mp4');
    assert.equal(source.sizeBytes, statSync(files.valid).size);
    assert.ok(Math.abs(source.durationSeconds - 5) < 0.1, String(source.durationSeconds));
    assert.deepEqual([source.width, source.height, source.frameRate], [320, 240, 30]);
    assert.deepEqual([source.videoCodec, source.audioPresent, source.audioCodec], ['h264', true, 'aac']);
    assert.match(source.storedFileName, /^[0-9a-f-]{36}\.mp4$/);
    assert.equal(project.revision, 1);
    assert.equal(project.analysis.status, 'idle');
    assert.equal(project.urls.source, `http://localhost:3000/api/projects/${projectId}/media/source`);
    const stored = path.join(storageRoot, 'projects', projectId, 'source', source.storedFileName);
    assert.equal(statSync(stored).size, source.sizeBytes);
  });

  it('sert la vidéo importée au lecteur, y compris par plages (Range)', async () => {
    const projectId = await createProject();
    const project = await expectAccepted(await uploadFile(projectId, files.valid));
    const size = project.source?.sizeBytes ?? 0;
    const mediaUrl = `${app.baseUrl}/api/projects/${projectId}/media/source`;

    const full = await fetch(mediaUrl);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal((await full.arrayBuffer()).byteLength, size);

    const partial = await fetch(mediaUrl, { headers: { Range: 'bytes=0-99' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 0-99/${size}`);
    assert.equal((await partial.arrayBuffer()).byteLength, 100);
  });

  it("répond 404 à la vidéo d'un projet qui n'en a pas encore", async () => {
    const projectId = await createProject();

    await expectRejected(await fetch(`${app.baseUrl}/api/projects/${projectId}/media/source`), 404, 'NOT_FOUND');
  });

  it("remplace la vidéo précédente, supprime son fichier et réinitialise l'analyse", async () => {
    const projectId = await createProject();

    const first = await expectAccepted(await uploadFile(projectId, files.valid));
    const second = await expectAccepted(await uploadFile(projectId, files.rotated));

    assert.equal(second.revision, first.revision + 1);
    assert.notEqual(second.source?.storedFileName, first.source?.storedFileName);
    assert.deepEqual(readdirSync(path.join(storageRoot, 'projects', projectId, 'source')), [
      second.source?.storedFileName,
    ]);

    // Même URL, mais le navigateur doit revalider : il reçoit la nouvelle vidéo, pas celle de son cache.
    const media = await fetch(`${app.baseUrl}/api/projects/${projectId}/media/source`);
    assert.match(media.headers.get('cache-control') ?? '', /no-cache/);
    assert.ok(media.headers.get('etag'));
    assert.equal((await media.arrayBuffer()).byteLength, second.source?.sizeBytes);
  });

  it("applique la rotation d'une vidéo filmée à la verticale", async () => {
    const projectId = await createProject();

    const project = await expectAccepted(await uploadFile(projectId, files.rotated));

    assert.deepEqual([project.source?.width, project.source?.height], [240, 320]);
  });

  it('neutralise un nom de fichier malveillant', async () => {
    const projectId = await createProject();

    const project = await expectAccepted(await uploadFile(projectId, files.valid, '../../evil.mp4'));

    assert.equal(project.source?.originalName, 'evil.mp4');
    assert.equal(existsSync(path.join(workDir, 'evil.mp4')), false);
    assert.equal(existsSync(path.join(storageRoot, 'evil.mp4')), false);
  });

  it('refuse une requête sans fichier', async () => {
    const projectId = await createProject();
    const form = new FormData();
    form.append('titre', 'sans vidéo');
    const url = `${app.baseUrl}/api/projects/${projectId}/upload`;

    await expectRejected(await fetch(url, { method: 'POST', body: form }), 400, 'UPLOAD_MISSING_FILE');
    await expectRejected(await fetch(url, { method: 'POST' }), 400, 'UPLOAD_MISSING_FILE');
  });

  it('refuse un fichier envoyé dans un autre champ que « video »', async () => {
    const projectId = await createProject();

    await expectRejected(
      await uploadFile(projectId, files.valid, 'clip.mp4', { field: 'fichier' }),
      400,
      'UPLOAD_MISSING_FILE',
    );
  });

  it('refuse une autre extension que .mp4 et un type déclaré incohérent', async () => {
    const projectId = await createProject();

    await expectRejected(await uploadFile(projectId, files.valid, 'interview.mov'), 415, 'UPLOAD_UNSUPPORTED_TYPE');
    await expectRejected(
      await uploadFile(projectId, files.valid, 'clip.mp4', { type: 'text/plain' }),
      415,
      'UPLOAD_UNSUPPORTED_TYPE',
    );
  });

  it("refuse un fichier qui n'est pas une vidéo malgré son extension .mp4", async () => {
    const projectId = await createProject();
    const text = new TextEncoder().encode("Ceci n'est pas une vidéo.");

    await expectRejected(await upload(projectId, text, 'faux.mp4'), 415, 'UPLOAD_UNSUPPORTED_TYPE');
    assert.equal((await getProject(projectId)).source, null);
  });

  it('refuse un fichier trop volumineux, reçu ou seulement annoncé', async () => {
    const projectId = await createProject();

    const received = await expectRejected(
      await upload(projectId, new Uint8Array(2.5 * MB), 'lourde.mp4'),
      413,
      'UPLOAD_TOO_LARGE',
    );
    assert.match(received.error.message, /2 Mo/);
    await expectRejected(await upload(projectId, new Uint8Array(4 * MB), 'enorme.mp4'), 413, 'UPLOAD_TOO_LARGE');
  });

  it('refuse une vidéo trop courte ou trop longue en indiquant les durées', async () => {
    const projectId = await createProject();

    const tooShort = await expectRejected(await uploadFile(projectId, files.short), 422, 'VIDEO_TOO_SHORT');
    const tooLong = await expectRejected(await uploadFile(projectId, files.long), 422, 'VIDEO_TOO_LONG');

    assert.match(tooShort.error.message, /2 s.*3 s/);
    assert.match(tooLong.error.message, /9 s.*8 s/);
    assert.equal((await getProject(projectId)).source, null);
  });

  it('refuse une vidéo sans piste audio', async () => {
    const projectId = await createProject();

    await expectRejected(await uploadFile(projectId, files.silent), 422, 'VIDEO_NO_AUDIO');
  });

  it('refuse une vidéo HEVC tant que la décision D-08 est en attente', async () => {
    const projectId = await createProject();

    const body = await expectRejected(await uploadFile(projectId, files.hevc), 422, 'VIDEO_UNSUPPORTED_CODEC');

    assert.match(body.error.message, /hevc/);
  });

  it('refuse un fichier MP4 endommagé', async () => {
    const projectId = await createProject();

    await expectRejected(await uploadFile(projectId, files.corrupted), 422, 'VIDEO_UNREADABLE');
  });

  it('répond 404 pour un projet inexistant', async () => {
    await expectRejected(await uploadFile(randomUUID(), files.valid), 404, 'NOT_FOUND');
  });
});

describe("règles d'affichage de l'import", () => {
  it('nettoie le nom de fichier affiché', () => {
    assert.equal(sanitizeOriginalName('C:\\Users\\alex\\Vidéos\\clip.mp4'), 'clip.mp4');
    assert.equal(sanitizeOriginalName('../../evil.mp4'), 'evil.mp4');
    assert.equal(sanitizeOriginalName('a\u0000b\nc.mp4'), 'abc.mp4');
    assert.equal(sanitizeOriginalName('   '), 'video.mp4');
    assert.equal(sanitizeOriginalName(`${'x'.repeat(300)}.mp4`).length, 200);
  });

  it('formate les durées en minutes et secondes, avec une décimale si nécessaire', () => {
    assert.equal(describeDuration(252, 180), '4 min 12 s');
    assert.equal(describeDuration(180, 252), '3 min');
    assert.equal(describeDuration(45, 180), '45 s');
    assert.equal(describeDuration(180.4, 180), '180,4 s');
  });
});
