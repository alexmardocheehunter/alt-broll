import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it, type TestContext } from 'node:test';
import { http, sleep, startBackend, type HttpResult, type RunningBackend } from '../lib/backend-server.ts';
import { ID_PATTERN } from '../../shared/contract.ts';
import { mediaPath } from '../lib/paths.ts';
import {
  validateApiErrorResponse,
  validateCreateProjectResponse,
  validateGetProjectResponse,
  validateProjectStatusResponse,
  validateUploadSourceResponse,
} from '../lib/validation/api.ts';

/*
 * Parcours P0 : import → analyse → suggestions → édition → export → download.
 *
 * Le backend n'expose encore que /api/health et /api/config. Tant que
 * POST /api/projects répond 404, chaque test est marqué « skipped » avec la
 * raison exacte : aucun faux succès n'est produit.
 *
 * Aucun test ne contacte Groq, OpenRouter ou Pixabay : clés vides et, quand
 * l'analyse sera livrée, on vérifie qu'elle refuse de partir sans fournisseur.
 * Le parcours complet restera skipped jusqu'à ce que le backend fournisse un
 * mode fournisseur hors ligne explicitement identifié (voir
 * docs/OPENCODE_QA_STATUS.md).
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
    analysis: { status: string };
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
  const form = new FormData();
  const bytes = readFileSync(mediaPath(fixture));
  form.set(
    options.field ?? 'video',
    new Blob([bytes], { type: options.mimeType ?? 'video/mp4' }),
    options.filename ?? fixture,
  );
  return http(server().baseUrl, `/api/projects/${projectId}/upload`, { method: 'POST', body: form });
}

function assertApiError(result: HttpResult, expectedStatus: number, expectedCodes: readonly string[]): void {
  assert.equal(result.status, expectedStatus, `statut ${expectedStatus} attendu (reçu ${result.status}) : ${result.text}`);
  assert.deepEqual(validateApiErrorResponse(result.json), []);
  const body = result.json as { error: { code: string } };
  assert.ok(expectedCodes.includes(body.error.code), `code ${expectedCodes.join(' | ')} attendu, reçu ${body.error.code}`);
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

    if (started.status === 404) {
      assert.deepEqual(validateApiErrorResponse(started.json), [], started.text);
      t.skip('POST /api/projects/:id/analyze n’est pas encore livrée (404) : test d’analyse en attente de Claude Code.');
      return;
    }

    if (started.status === 503) {
      assert.deepEqual(validateApiErrorResponse(started.json), [], started.text);
      assert.equal((started.json as { error: { code: string } }).error.code, 'PROVIDER_NOT_CONFIGURED');
      return;
    }

    assert.ok([200, 202].includes(started.status), `503 ou 202 attendu, reçu ${started.status} : ${started.text}`);
    assert.deepEqual(validateProjectStatusResponse(started.json), []);

    let last: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await http(server().baseUrl, `/api/projects/${project.id}/status`);
      assert.equal(status.status, 200, status.text);
      assert.deepEqual(validateProjectStatusResponse(status.json), []);
      last = status.json;
      const analysis = (status.json as { analysis: { status: string } }).analysis;
      if (analysis.status === 'failed' || analysis.status === 'completed') break;
      await sleep(250);
    }

    const analysis = (last as { analysis: { status: string; error: { code: string } | null } }).analysis;
    assert.equal(analysis.status, 'failed', 'sans fournisseur, l’analyse doit échouer et non réussir');
    assert.equal(analysis.error?.code, 'PROVIDER_NOT_CONFIGURED');
  });

  it('parcours complet analyse → suggestions → timeline → rendu → download', (t) => {
    if (!requireProjectApi(t)) return;
    t.skip(
      'Aucun mode fournisseur hors ligne (Groq/OpenRouter/Pixabay) n’est fourni par le backend. ' +
        'Les tests ne doivent jamais appeler les API réelles : livrer une injection de test clairement identifiée ' +
        '(voir docs/OPENCODE_QA_STATUS.md, demande QA-002), puis activer ce parcours.',
    );
  });
});
