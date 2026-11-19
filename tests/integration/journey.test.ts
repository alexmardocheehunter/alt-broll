import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it, type TestContext } from 'node:test';
import { http, sleep, startBackend, type HttpResult, type RunningBackend } from '../lib/backend-server.ts';
import { ID_PATTERN } from '../../shared/contract.ts';
import { PROJECT_ROOT, mediaPath } from '../lib/paths.ts';
import {
  audioStream,
  ffmpegAvailable,
  ffprobeAvailable,
  formatDuration,
  probeMedia,
  videoStream,
} from '../lib/media.ts';
import {
  validateApiErrorResponse,
  validateCreateProjectResponse,
  validateGetProjectResponse,
  validateProjectStatusResponse,
  validateRenderStatusResponse,
  validateStartRenderResponse,
  validateSuggestionsResponse,
  validateUpdateTimelineResponse,
  validateUploadSourceResponse,
} from '../lib/validation/api.ts';

/*
 * Parcours P0 : import → analyse → suggestions → édition → export → download.
 *
 * Le backend livre l'import, l'analyse (avec un mode fournisseur simulé
 * explicite, PROVIDER_MODE=mock) et l'édition de timeline. Les routes de rendu
 * et de téléchargement restent attendues : les tests qui en dépendent sont
 * marqués « skipped » avec la raison exacte.
 *
 * Aucun test ne contacte Groq, OpenRouter ou Pixabay : le parcours d'analyse
 * hors ligne utilise uniquement les fournisseurs simulés, qui se déclarent
 * comme tels (`provider: 'simulation'`, textes « [Simulation] », URL .invalid).
 */

const SKIP_REASON =
  'POST /api/projects n’est pas encore implémenté (404) : parcours P0 en attente de Claude Code.';

let backend: RunningBackend | undefined;
let projectApiAvailable = false;
let initialCreation: HttpResult | undefined;

before(async () => {
  backend = await startBackend();
  initialCreation = await http(backend.baseUrl, '/api/projects', { method: 'POST' });

  if (initialCreation.status === 404) {
    const body = initialCreation.json as { error?: { code?: string } } | undefined;
    projectApiAvailable = body?.error?.code !== 'NOT_FOUND';
    return;
  }

  projectApiAvailable = true;
  assert.equal(initialCreation.status, 201, `POST /api/projects doit créer un projet : ${initialCreation.text}`);
  assert.deepEqual(validateCreateProjectResponse(initialCreation.json), []);
});

after(async () => {
  await backend?.stop();
});

function server(): RunningBackend {
  assert.ok(backend, 'backend non démarré');
  return backend;
}

function requireProjectApi(t: TestContext): boolean {
  if (projectApiAvailable) return true;
  t.skip(SKIP_REASON);
  return false;
}

interface ProjectEnvelope {
  project: {
    id: string;
    revision: number;
    source: null | {
      originalName: string;
      storedFileName: string;
      mimeType: string;
      sizeBytes: number;
      durationSeconds: number;
      width: number;
      height: number;
      frameRate: number;
      audioPresent: boolean;
      audioCodec: string | null;
    };
    transcript: null | {
      provider: string;
      model: string;
      language: string;
      text: string;
      segments: Array<{ startSeconds: number; endSeconds: number; text: string }>;
      words: Array<{ startSeconds: number; endSeconds: number; word: string }>;
    };
    analysis: {
      status: string;
      stage: string | null;
      model: string | null;
      visualAnalysisAvailable: boolean;
      keyframes: Array<{ index: number; timeSeconds: number }>;
      summary: string | null;
      error: { code: string } | null;
    };
    brollItems: Array<{ id: string; enabled: boolean; selectedCandidateId: string | null }>;
    timeline: { segments: Array<{ brollItemId: string; candidateId: string; startSeconds: number; endSeconds: number; fit: string }> };
    render: { status: string };
    urls: { source: string | null; download: string | null };
  };
}

async function createProject(): Promise<ProjectEnvelope['project']> {
  const result = await http(server().baseUrl, '/api/projects', { method: 'POST' });
  assert.equal(result.status, 201, result.text);
  assert.deepEqual(validateCreateProjectResponse(result.json), []);
  const body = result.json as ProjectEnvelope;
  assert.match(body.project.id, ID_PATTERN);
  return body.project;
}

async function uploadSource(
  projectId: string,
  fixture: string,
  options: { filename?: string; mimeType?: string; field?: string } = {},
): Promise<HttpResult> {
  return uploadSourceTo(server().baseUrl, projectId, fixture, options);
}

async function uploadSourceTo(
  baseUrl: string,
  projectId: string,
  fixture: string,
  options: { filename?: string; mimeType?: string; field?: string } = {},
): Promise<HttpResult> {
  const form = new FormData();
  const bytes = readFileSync(mediaPath(fixture));
  form.set(
    options.field ?? 'video',
    new Blob([bytes], { type: options.mimeType ?? 'video/mp4' }),
    options.filename ?? fixture,
  );
  return http(baseUrl, `/api/projects/${projectId}/upload`, { method: 'POST', body: form });
}

function assertApiError(result: HttpResult, expectedStatus: number, expectedCodes: readonly string[]): void {
  assert.equal(result.status, expectedStatus, `statut ${expectedStatus} attendu (reçu ${result.status}) : ${result.text}`);
  assert.deepEqual(validateApiErrorResponse(result.json), []);
  const body = result.json as { error: { code: string } };
  assert.ok(expectedCodes.includes(body.error.code), `code ${expectedCodes.join(' | ')} attendu, reçu ${body.error.code}`);
}

/** Fichiers d'envoi encore présents après une requête : doit toujours être vide. */
function pendingUploads(): string[] {
  const dir = path.join(server().storageRoot, 'tmp', 'uploads');
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.upload'));
  } catch {
    return [];
  }
}

describe('parcours P0 : création et lecture', () => {
  it('POST /api/projects crée un projet vide conforme', async (t) => {
    if (!requireProjectApi(t)) return;
    assert.ok(initialCreation);
    const body = initialCreation.json as ProjectEnvelope;
    const project = body.project;

    assert.match(project.id, ID_PATTERN);
    assert.equal(project.revision, 0);
    assert.equal(project.source, null);
    assert.equal(project.analysis.status, 'idle');
    assert.equal(project.render.status, 'idle');
    assert.deepEqual(project.urls, { source: null, download: null });
  });

  it('GET /api/projects/:id relit le même projet', async (t) => {
    if (!requireProjectApi(t)) return;
    const created = await createProject();
    const result = await http(server().baseUrl, `/api/projects/${created.id}`);
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(validateGetProjectResponse(result.json), []);
    assert.equal((result.json as ProjectEnvelope).project.id, created.id);
  });

  it('un identifiant inconnu renvoie 404 NOT_FOUND (pas de fuite)', async () => {
    const result = await http(server().baseUrl, '/api/projects/projet_inexistant_qa');
    assert.equal(result.status, 404);
    assert.deepEqual(validateApiErrorResponse(result.json), []);
    assert.equal((result.json as { error: { code: string } }).error.code, 'NOT_FOUND');
  });
});

describe('parcours P0 : import de la vidéo source', () => {
  it('importe source-30s.mp4 et renvoie les métadonnées ffprobe', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();
    const result = await uploadSource(project.id, 'source-30s.mp4');
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(validateUploadSourceResponse(result.json), []);

    const uploaded = (result.json as ProjectEnvelope).project;
    const source = uploaded.source;
    assert.ok(source, 'source absente après un import valide');
    assert.equal(source.originalName, 'source-30s.mp4');
    assert.equal(source.mimeType, 'video/mp4');
    assert.match(source.storedFileName, /^[A-Za-z0-9_-]{1,64}\.mp4$/);
    assert.ok(Math.abs(source.durationSeconds - 30) < 0.1);
    assert.equal(source.width, 640);
    assert.equal(source.height, 360);
    assert.ok(Math.abs(source.frameRate - 30) < 0.01);
    assert.equal(source.audioPresent, true);
    assert.equal(source.audioCodec, 'aac');
    assert.ok(uploaded.revision >= 1, 'la révision doit augmenter après import');
    assert.ok(uploaded.urls.source, 'URL de lecture absente');
    const sourceUrl = new URL(uploaded.urls.source);
    assert.equal(sourceUrl.host, new URL(server().baseUrl).host);
    assert.equal(sourceUrl.pathname, `/api/projects/${project.id}/media/source`);
    assert.equal(uploaded.urls.download, null);
  });

  it('GET /api/projects/:id/media/source sert le MP4 importé, avec requêtes Range', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();
    const upload = await uploadSource(project.id, 'source-30s.mp4');
    assert.equal(upload.status, 200, upload.text);

    const full = await http(server().baseUrl, `/api/projects/${project.id}/media/source`, {
      headers: { Origin: 'http://localhost:5500' },
    });
    assert.equal(full.status, 200, full.text.slice(0, 300));
    assert.match(full.headers.get('content-type') ?? '', /^video\/mp4\b/);
    assert.equal(Number(full.headers.get('content-length')), readFileSync(mediaPath('source-30s.mp4')).byteLength);
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    assert.match(full.headers.get('cache-control') ?? '', /no-cache/i, 'le navigateur doit revalider après un remplacement');
    assert.ok(full.headers.get('etag'), 'ETag attendu pour permettre un 304');
    assert.equal(full.headers.get('access-control-allow-origin'), 'http://localhost:5500', 'le lecteur HTML5 doit pouvoir charger la vidéo');

    const range = await http(server().baseUrl, `/api/projects/${project.id}/media/source`, {
      headers: { Range: 'bytes=0-1023' },
    });
    assert.equal(range.status, 206, range.text.slice(0, 300));
    assert.match(range.headers.get('content-range') ?? '', /^bytes 0-1023\/\d+$/);
    assert.equal(Number(range.headers.get('content-length')), 1024);
  });

  it('un nouvel import remplace la source et supprime l’ancien fichier', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();
    const first = await uploadSource(project.id, 'source-30s.mp4');
    assert.equal(first.status, 200, first.text);
    const firstSource = (first.json as ProjectEnvelope).project.source;
    assert.ok(firstSource);

    const second = await uploadSource(project.id, 'source-30s.mp4');
    assert.equal(second.status, 200, second.text);
    const secondProject = (second.json as ProjectEnvelope).project;
    assert.ok(secondProject.source);
    assert.notEqual(secondProject.source.storedFileName, firstSource.storedFileName, 'la nouvelle vidéo doit avoir un nouveau nom');
    assert.equal(secondProject.source.originalName, 'source-30s.mp4');
    assert.ok(secondProject.revision > (first.json as ProjectEnvelope).project.revision, 'la révision doit augmenter');

    const sourceDir = path.join(server().storageRoot, 'projects', project.id, 'source');
    assert.deepEqual(readdirSync(sourceDir), [secondProject.source.storedFileName], 'l’ancienne vidéo doit être supprimée');
  });

  it('refuse un import pendant un export actif (409 CONFLICT)', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();
    const upload = await uploadSource(project.id, 'source-30s.mp4');
    assert.equal(upload.status, 200, upload.text);

    const db = new DatabaseSync(server().databasePath);
    try {
      const now = Date.now();
      db.prepare(
        `INSERT INTO render_jobs
           (id, project_id, project_revision, status, payload, attempts, max_attempts, created_at_ms, updated_at_ms)
         VALUES ('job_import_guard', ?, 1, 'queued', '{}', 0, 2, ?, ?)`,
      ).run(project.id, now, now);

      const blocked = await uploadSource(project.id, 'source-30s.mp4');
      assert.equal(blocked.status, 409, blocked.text);
      assert.deepEqual(validateApiErrorResponse(blocked.json), []);
      assert.equal((blocked.json as { error: { code: string } }).error.code, 'CONFLICT');
    } finally {
      db.prepare("DELETE FROM render_jobs WHERE id = 'job_import_guard'").run();
      db.close();
    }
  });

  it('refuse un import pendant une analyse (409 CONFLICT)', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();
    const upload = await uploadSource(project.id, 'source-30s.mp4');
    assert.equal(upload.status, 200, upload.text);

    const db = new DatabaseSync(server().databasePath);
    try {
      const row = db.prepare('SELECT document FROM projects WHERE id = ?').get(project.id) as { document: string };
      const document = JSON.parse(row.document) as { analysis: { status: string } };
      document.analysis.status = 'queued';
      db.prepare('UPDATE projects SET document = ? WHERE id = ?').run(JSON.stringify(document), project.id);

      const blocked = await uploadSource(project.id, 'source-30s.mp4');
      assert.equal(blocked.status, 409, blocked.text);
      assert.deepEqual(validateApiErrorResponse(blocked.json), []);
      assert.equal((blocked.json as { error: { code: string } }).error.code, 'CONFLICT');
    } finally {
      db.close();
    }
  });

  it('GET /api/projects/:id/status expose une réponse de polling conforme', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();
    const upload = await uploadSource(project.id, 'source-30s.mp4');
    assert.equal(upload.status, 200, upload.text);

    const result = await http(server().baseUrl, `/api/projects/${project.id}/status`);
    assert.equal(result.status, 200, result.text);
    assert.deepEqual(validateProjectStatusResponse(result.json), []);
    const status = result.json as { projectId: string; sourceUploaded: boolean };
    assert.equal(status.projectId, project.id);
    assert.equal(status.sourceUploaded, true);
  });

  it('refuse une vidéo trop longue (181 s > 180 s)', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();
    assertApiError(await uploadSource(project.id, 'too-long-181s.mp4'), 422, ['VIDEO_TOO_LONG']);
  });

  it('refuse une vidéo trop courte (3 s < 5 s)', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();
    assertApiError(await uploadSource(project.id, 'too-short-3s.mp4'), 422, ['VIDEO_TOO_SHORT']);
  });

  it('refuse une vidéo sans piste audio', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();
    assertApiError(await uploadSource(project.id, 'no-audio-10s.mp4'), 422, ['VIDEO_NO_AUDIO']);
  });

  it('refuse un fichier audio sans piste vidéo', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();
    assertApiError(await uploadSource(project.id, 'audio-only-10s.mp4'), 422, ['VIDEO_NO_VIDEO_STREAM']);
  });

  it('refuse un MP4 tronqué', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();
    assertApiError(await uploadSource(project.id, 'truncated.mp4'), 422, ['VIDEO_UNREADABLE']);
    assert.deepEqual(pendingUploads(), [], 'le fichier temporaire doit être supprimé après un refus');
  });

  it('refuse un fichier texte renommé en .mp4', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();
    const result = await uploadSource(project.id, 'not-a-video.mp4');
    assert.ok([415, 422].includes(result.status), `statut 415 ou 422 attendu, reçu ${result.status} : ${result.text}`);
    assertApiError(result, result.status, ['UPLOAD_UNSUPPORTED_TYPE', 'VIDEO_UNREADABLE']);
  });

  it('refuse une extension trompeuse (.mov) même avec un contenu MP4', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();
    const result = await uploadSource(project.id, 'source-30s.mp4', {
      filename: 'video-renommee.mov',
      mimeType: 'video/quicktime',
    });
    assertApiError(result, 415, ['UPLOAD_UNSUPPORTED_TYPE']);
  });

  it('refuse un formulaire sans fichier ou avec le mauvais champ', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();

    const empty = await http(server().baseUrl, `/api/projects/${project.id}/upload`, { method: 'POST', body: new FormData() });
    assertApiError(empty, 400, ['UPLOAD_MISSING_FILE']);

    const wrongField = await uploadSource(project.id, 'source-30s.mp4', { field: 'video_autre' });
    assertApiError(wrongField, 400, ['UPLOAD_MISSING_FILE']);
  });

  it('refuse un fichier dépassant MAX_UPLOAD_MB (serveur configuré à 1 Mio)', async (t) => {
    if (!requireProjectApi(t)) return;
    const smallBackend = await startBackend({ env: { MAX_UPLOAD_MB: '1' } });
    try {
      const creation = await http(smallBackend.baseUrl, '/api/projects', { method: 'POST' });
      assert.equal(creation.status, 201, creation.text);
      const projectId = (creation.json as ProjectEnvelope).project.id;

      const form = new FormData();
      const bytes = readFileSync(mediaPath('source-30s.mp4'));
      assert.ok(bytes.byteLength > 1024 * 1024, 'la fixture source-30s doit dépasser 1 Mio');
      form.set('video', new Blob([bytes], { type: 'video/mp4' }), 'source-30s.mp4');
      const result = await http(smallBackend.baseUrl, `/api/projects/${projectId}/upload`, {
        method: 'POST',
        body: form,
      });
      assertApiError(result, 413, ['UPLOAD_TOO_LARGE']);

      const pendingDir = path.join(smallBackend.storageRoot, 'tmp', 'uploads');
      const pending = existsSync(pendingDir) ? readdirSync(pendingDir).filter((name) => name.endsWith('.upload')) : [];
      assert.deepEqual(pending, [], 'un envoi refusé ne doit laisser aucun fichier temporaire');
    } finally {
      await smallBackend.stop();
    }
  });
});

describe('parcours P0 : analyse sans fournisseur', () => {
  it('refuse de lancer une analyse sans clés, sans appel externe', async (t) => {
    if (!requireProjectApi(t)) return;
    const project = await createProject();
    const upload = await uploadSource(project.id, 'source-30s.mp4');
    assert.equal(upload.status, 200, upload.text);

    const started = await http(server().baseUrl, `/api/projects/${project.id}/analyze`, { method: 'POST' });

    if (started.status === 503) {
      assert.deepEqual(validateApiErrorResponse(started.json), [], started.text);
      assert.equal((started.json as { error: { code: string } }).error.code, 'PROVIDER_NOT_CONFIGURED');
      return;
    }

    assert.fail(`503 attendu sans fournisseur configuré, reçu ${started.status} : ${started.text}`);
  });
});

interface MockBrollItem {
  id: string;
  status: string;
  enabled: boolean;
  selectedCandidateId: string | null;
  startSeconds: number;
  endSeconds: number;
  fit: string;
  candidates: Array<{
    id: string;
    provider: string;
    title: string;
    downloadUrl: string;
    attribution: string;
    durationSeconds: number;
  }>;
}

interface MockSuggestions {
  projectId: string;
  revision: number;
  visualAnalysisAvailable: boolean;
  brollItems: MockBrollItem[];
  timeline: { segments: Array<{ brollItemId: string; candidateId: string; startSeconds: number; endSeconds: number; fit: string }> };
}

describe('parcours P0 : analyse hors ligne et édition (PROVIDER_MODE=mock)', () => {
  const toolsAvailable = ffmpegAvailable() && ffprobeAvailable();
  let mock: RunningBackend | undefined;
  let project: ProjectEnvelope['project'];
  let uploadedRevision = 0;
  let started: HttpResult | undefined;
  let finished: ProjectEnvelope['project'] | undefined;
  let suggestions: MockSuggestions | undefined;

  before(async () => {
    if (!toolsAvailable) return;
    mock = await startBackend({ env: { PROVIDER_MODE: 'mock', MAX_ANALYSES_PER_DAY: '10' } });
    const base = mock.baseUrl;

    const creation = await http(base, '/api/projects', { method: 'POST' });
    assert.equal(creation.status, 201, creation.text);
    project = (creation.json as ProjectEnvelope).project;

    const upload = await uploadSourceTo(base, project.id, 'source-30s.mp4');
    assert.equal(upload.status, 200, upload.text);
    uploadedRevision = (upload.json as ProjectEnvelope).project.revision;

    started = await http(base, `/api/projects/${project.id}/analyze`, { method: 'POST' });

    const deadline = Date.now() + 90_000;
    let status: { analysis: { status: string } } | undefined;
    while (Date.now() < deadline) {
      const poll = await http(base, `/api/projects/${project.id}/status`);
      assert.equal(poll.status, 200, poll.text);
      assert.deepEqual(validateProjectStatusResponse(poll.json), []);
      status = poll.json as { analysis: { status: string } };
      if (status.analysis.status === 'completed' || status.analysis.status === 'failed') break;
      await sleep(250);
    }
    assert.equal(
      status?.analysis.status,
      'completed',
      `l’analyse simulée doit se terminer sans réseau (dernier statut : ${JSON.stringify(status)})\n${mock.logs()}`,
    );

    const reread = await http(base, `/api/projects/${project.id}`);
    assert.equal(reread.status, 200, reread.text);
    assert.deepEqual(validateGetProjectResponse(reread.json), []);
    finished = (reread.json as ProjectEnvelope).project;

    const listed = await http(base, `/api/projects/${project.id}/suggestions`);
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual(validateSuggestionsResponse(listed.json), []);
    suggestions = listed.json as MockSuggestions;
  });

  after(async () => {
    await mock?.stop();
  });

  function requireMock(t: TestContext): boolean {
    if (!toolsAvailable) {
      t.skip('FFmpeg et ffprobe sont nécessaires pour l’analyse hors ligne.');
      return false;
    }
    assert.ok(mock, 'backend simulé non démarré');
    return true;
  }

  function mockBase(): string {
    assert.ok(mock);
    return mock.baseUrl;
  }

  it('POST /analyze répond 202 et produit une transcription et des suggestions marquées « simulation »', (t) => {
    if (!requireMock(t)) return;
    assert.ok(started);
    assert.equal(started.status, 202, started.text);
    assert.deepEqual(validateProjectStatusResponse(started.json), []);
    assert.equal((started.json as { analysis: { status: string } }).analysis.status, 'queued');

    assert.ok(finished);
    assert.equal(finished.analysis.status, 'completed');
    assert.equal(finished.analysis.stage, null);
    assert.equal(finished.analysis.error, null);
    assert.equal(finished.analysis.model, 'simulation-hors-ligne');
    assert.equal(finished.analysis.visualAnalysisAvailable, false, 'la simulation ne doit pas prétendre avoir analysé les images');
    assert.deepEqual(finished.analysis.keyframes, []);
    assert.match(finished.analysis.summary ?? '', /\[Simulation\]/);
    assert.ok(finished.revision > uploadedRevision, 'l’analyse doit augmenter la révision');

    const transcript = finished.transcript;
    assert.ok(transcript, 'transcription absente après une analyse simulée');
    assert.equal(transcript.provider, 'simulation');
    assert.equal(transcript.model, 'simulation-hors-ligne');
    assert.equal(transcript.language, 'fr');
    assert.equal(transcript.segments.length, 4);
    for (const segment of transcript.segments) {
      assert.match(segment.text, /^\[Simulation\]/);
      assert.ok(segment.endSeconds > segment.startSeconds);
    }
  });

  it('GET /suggestions expose quatre B-rolls simulés avec candidats, sans les présenter comme réels', (t) => {
    if (!requireMock(t)) return;
    assert.ok(suggestions);
    assert.equal(suggestions.projectId, project.id);
    assert.equal(suggestions.visualAnalysisAvailable, false);
    assert.equal(suggestions.brollItems.length, 4);

    for (const item of suggestions.brollItems) {
      assert.equal(item.status, 'suggested');
      assert.equal(item.enabled, true);
      assert.equal(item.selectedCandidateId, item.candidates[0]?.id, 'le premier candidat est proposé par défaut');
      assert.equal(item.candidates.length, 2);
      for (const candidate of item.candidates) {
        assert.equal(candidate.provider, 'simulation');
        assert.match(candidate.title, /^\[Simulation\]/);
        assert.equal(new URL(candidate.downloadUrl).hostname, 'simulation.invalid');
        assert.match(candidate.attribution, /simulé|simulation/i);
        assert.ok(candidate.durationSeconds > 0);
      }
    }
    assert.equal(suggestions.timeline.segments.length, suggestions.brollItems.length, 'chaque suggestion avec candidat est montée par défaut');
    assert.deepEqual(
      suggestions.timeline.segments.map((segment) => segment.brollItemId),
      suggestions.brollItems.map((item) => item.id),
      'la timeline doit suivre l’ordre des suggestions',
    );
  });

  it('PATCH /timeline modifie un candidat, persiste, puis refuse révision périmée, chevauchement et valeurs hors contrat', async (t) => {
    if (!requireMock(t)) return;
    assert.ok(suggestions);
    const [first, second] = suggestions.brollItems;
    assert.ok(first && second);
    assert.ok(first.candidates[1], 'le premier B-roll doit proposer deux candidats');
    const secondCandidate = second.candidates[0];
    assert.ok(secondCandidate);
    const replacement = first.candidates[1];

    const patch = (body: unknown) =>
      http(mockBase(), `/api/projects/${project.id}/timeline`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    let revision = suggestions.revision;
    const mounted = await patch({
      baseRevision: revision,
      items: [{ id: first.id, selectedCandidateId: replacement.id, startSeconds: 1, endSeconds: 4, fit: 'cover' }],
    });
    assert.equal(mounted.status, 200, mounted.text);
    assert.deepEqual(validateUpdateTimelineResponse(mounted.json), []);
    const mountedProject = (mounted.json as ProjectEnvelope).project;
    assert.equal(mountedProject.revision, revision + 1);
    assert.equal(mountedProject.timeline.segments.length, suggestions.brollItems.length);
    assert.deepEqual(mountedProject.timeline.segments[0], {
      brollItemId: first.id,
      candidateId: replacement.id,
      startSeconds: 1,
      endSeconds: 4,
      fit: 'cover',
    });
    revision += 1;

    const reread = await http(mockBase(), `/api/projects/${project.id}/suggestions`);
    assert.equal(reread.status, 200, reread.text);
    assert.deepEqual(validateSuggestionsResponse(reread.json), []);
    const persisted = reread.json as MockSuggestions;
    assert.equal(persisted.revision, revision);
    assert.equal(persisted.timeline.segments.length, suggestions.brollItems.length);
    assert.equal(persisted.brollItems[0]?.selectedCandidateId, replacement.id);

    const stale = await patch({ baseRevision: suggestions.revision, items: [{ id: first.id, enabled: false }] });
    assertApiError(stale, 409, ['REVISION_CONFLICT']);

    const overlap = await patch({
      baseRevision: revision,
      items: [{ id: second.id, startSeconds: 2, endSeconds: 5 }],
    });
    assertApiError(overlap, 422, ['TIMELINE_OVERLAP']);

    const wrongCandidate = await patch({
      baseRevision: revision,
      items: [{ id: first.id, selectedCandidateId: secondCandidate.id }],
    });
    assertApiError(wrongCandidate, 422, ['TIMELINE_INVALID']);

    const tooLong = await patch({ baseRevision: revision, items: [{ id: second.id, startSeconds: 5, endSeconds: 16 }] });
    assertApiError(tooLong, 422, ['TIMELINE_INVALID']);

    const unknown = await patch({ baseRevision: revision, items: [{ id: 'br_inconnu', enabled: false }] });
    assertApiError(unknown, 422, ['TIMELINE_INVALID']);

    const disabled = await patch({ baseRevision: revision, items: [{ id: first.id, enabled: false }] });
    assert.equal(disabled.status, 200, disabled.text);
    assert.deepEqual(validateUpdateTimelineResponse(disabled.json), []);
    const disabledProject = (disabled.json as ProjectEnvelope).project;
    assert.equal(disabledProject.revision, revision + 1);
    assert.equal(disabledProject.timeline.segments.length, suggestions.brollItems.length - 1);
    assert.ok(
      disabledProject.timeline.segments.every((segment) => segment.brollItemId !== first.id),
      'un B-roll désactivé ne doit plus être monté',
    );
    assert.equal(disabledProject.brollItems[0]?.enabled, false);
  });

  async function waitForRenderState(
    predicate: (status: string) => boolean,
    timeoutMs = 120_000,
  ): Promise<{
    status: string;
    jobId: string | null;
    revision: number | null;
    progress: number;
    outputFile: { sizeBytes: number; durationSeconds: number } | null;
    error: { code: string } | null;
  }> {
    const deadline = Date.now() + timeoutMs;
    let last: {
      status: string;
      jobId: string | null;
      revision: number | null;
      progress: number;
      outputFile: { sizeBytes: number; durationSeconds: number } | null;
      error: { code: string } | null;
    } | undefined;

    while (Date.now() < deadline) {
      const result = await http(mockBase(), `/api/projects/${project.id}/render/status`);
      assert.equal(result.status, 200, result.text);
      assert.deepEqual(validateRenderStatusResponse(result.json), []);
      last = (result.json as { render: typeof last }).render;
      if (predicate(last!.status)) return last!;
      await sleep(250);
    }
    assert.fail(`état de rendu non atteint en ${timeoutMs} ms : ${JSON.stringify(last)}\n${mock?.logs() ?? ''}`);
  }

  function runWorkerOnce(): { status: number | null; output: string } {
    assert.ok(mock);
    const result = spawnSync(process.execPath, ['src/worker.ts', '--once'], {
      cwd: path.join(PROJECT_ROOT, 'renderer'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_PATH: mock.databasePath,
        STORAGE_ROOT: mock.storageRoot,
        FFMPEG_PATH: process.env.FFMPEG_PATH ?? 'ffmpeg',
        FFPROBE_PATH: process.env.FFPROBE_PATH ?? 'ffprobe',
        MAX_CONCURRENT_RENDERS: '1',
      },
      encoding: 'utf8',
      timeout: 180_000,
      windowsHide: true,
    });
    return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
  }

  it('POST /render prépare les médias simulés, le worker produit le MP4, /download le sert', async (t) => {
    if (!requireMock(t)) return;

    const current = await http(mockBase(), `/api/projects/${project.id}`);
    assert.equal(current.status, 200, current.text);
    const revision = (current.json as ProjectEnvelope).project.revision;

    const start = await http(mockBase(), `/api/projects/${project.id}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision }),
    });
    assert.equal(start.status, 202, start.text);
    assert.deepEqual(validateStartRenderResponse(start.json), []);
    const startBody = start.json as {
      render: { status: string; jobId: string | null; revision: number | null; progress: number; error: unknown };
    };
    assert.equal(startBody.render.status, 'preparing');
    assert.equal(startBody.render.revision, revision);
    assert.ok(startBody.render.jobId);

    const prepared = await waitForRenderState((status) => status !== 'preparing');
    assert.equal(prepared.status, 'queued', `préparation échouée : ${JSON.stringify(prepared)}\n${mock.logs()}`);
    assert.equal(prepared.error, null);

    const worker = runWorkerOnce();
    assert.equal(worker.status, 0, `le worker doit sortir sans erreur :\n${worker.output}`);

    const completed = await waitForRenderState((status) => status === 'completed' || status === 'failed');
    assert.equal(completed.status, 'completed', `rendu échoué : ${JSON.stringify(completed)}\n${worker.output}`);
    assert.equal(completed.progress, 1, 'un export terminé doit afficher 100 %');
    assert.equal(completed.error, null);
    assert.ok(completed.outputFile && completed.outputFile.sizeBytes > 0, 'taille du MP4 absente');
    assert.ok(
      completed.outputFile.durationSeconds > 29.5 && completed.outputFile.durationSeconds < 30.5,
      `durée de sortie inattendue : ${completed.outputFile.durationSeconds}`,
    );

    const download = await http(mockBase(), `/api/projects/${project.id}/download`);
    assert.equal(download.status, 200, download.text.slice(0, 300));
    assert.match(download.headers.get('content-type') ?? '', /^video\/mp4\b/);
    assert.match(download.headers.get('content-disposition') ?? '', /attachment/i);
    assert.equal(Number(download.headers.get('content-length')), download.bytes.byteLength);
    assert.ok(download.bytes.byteLength > 100_000, `MP4 téléchargé trop petit : ${download.bytes.byteLength} octets`);

    const dir = mkdtempSync(path.join(tmpdir(), 'alt-broll-download-'));
    try {
      const file = path.join(dir, 'export.mp4');
      writeFileSync(file, download.bytes);
      const probe = probeMedia(file);
      assert.ok(probe, 'le MP4 téléchargé doit être lisible par ffprobe');
      const video = videoStream(probe);
      assert.ok(video, 'piste vidéo absente du MP4 final');
      assert.equal(video.width, 640);
      assert.equal(video.height, 360);
      const duration = formatDuration(probe);
      assert.ok(duration !== null && Math.abs(duration - 30) < 0.2, `durée finale inattendue : ${duration}`);
      assert.ok(audioStream(probe), "l'audio d'origine doit être conservé dans l'export");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('POST /render refuse une révision périmée et un montage vide', async (t) => {
    if (!requireMock(t)) return;

    const current = await http(mockBase(), `/api/projects/${project.id}`);
    assert.equal(current.status, 200, current.text);
    const projectNow = (current.json as ProjectEnvelope).project;

    const stale = await http(mockBase(), `/api/projects/${project.id}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: projectNow.revision + 1 }),
    });
    assertApiError(stale, 409, ['REVISION_CONFLICT']);

    const items = projectNow.brollItems.map((item) => ({ id: item.id, enabled: false }));
    const cleared = await http(mockBase(), `/api/projects/${project.id}/timeline`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevision: projectNow.revision, items }),
    });
    assert.equal(cleared.status, 200, cleared.text);
    const clearedProject = (cleared.json as ProjectEnvelope).project;
    assert.deepEqual(clearedProject.timeline.segments, []);

    const noSegments = await http(mockBase(), `/api/projects/${project.id}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: clearedProject.revision }),
    });
    assertApiError(noSegments, 422, ['RENDER_NO_SEGMENTS']);
  });
});
