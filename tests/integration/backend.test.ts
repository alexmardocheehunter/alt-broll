import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { TIMELINE_RULES } from '../../shared/contract.ts';
import { http, startBackend, type RunningBackend } from '../lib/backend-server.ts';
import { ffmpegAvailable, ffprobeAvailable } from '../lib/media.ts';
import {
  validateApiErrorResponse,
  validateCreateProjectResponse,
  validateGetProjectResponse,
  validateHealthResponse,
  validateProjectStatusResponse,
  validatePublicConfigResponse,
  validateRenderStatusResponse,
  validateSuggestionsResponse,
  validateUpdateTimelineResponse,
} from '../lib/validation/api.ts';

/*
 * Tests d'intégration du backend réel (Claude Code), sans mock interne :
 * le processus `node src/server.ts` est lancé avec une base et un stockage
 * temporaires, clés fournisseur vides. On vérifie le socle livré
 * (health, config, erreurs, schéma SQLite) et on fige l'état des routes P0
 * non encore implémentées pour que leur livraison soit détectée.
 */

const toolsAvailable = ffmpegAvailable() && ffprobeAvailable();

let backend: RunningBackend | undefined;

before(async () => {
  backend = await startBackend();
});

after(async () => {
  await backend?.stop();
});

function server(): RunningBackend {
  assert.ok(backend, 'backend non démarré');
  return backend;
}

const RENDER_JOB_COLUMNS = [
  'id',
  'project_id',
  'project_revision',
  'status',
  'payload',
  'progress',
  'attempts',
  'max_attempts',
  'worker_id',
  'lease_expires_at_ms',
  'output_size_bytes',
  'output_duration_seconds',
  'error_code',
  'error_message',
  'created_at_ms',
  'updated_at_ms',
  'started_at_ms',
  'completed_at_ms',
];

const PROJECT_COLUMNS = ['id', 'schema_version', 'revision', 'document', 'created_at_ms', 'updated_at_ms'];

describe('intégration backend : socle livré', () => {
  it('GET /api/health décrit la base, FFmpeg et les fournisseurs non configurés', async () => {
    const result = await http(server().baseUrl, '/api/health');
    assert.equal(result.status, toolsAvailable ? 200 : 503, result.text);
    assert.deepEqual(validateHealthResponse(result.json), []);

    const health = result.json as {
      status: string;
      service: string;
      schemaVersion: number;
      checks: { database: string; ffmpeg: string; ffprobe: string };
      providers: Record<string, boolean>;
    };
    assert.equal(health.service, 'alt-broll-backend');
    assert.equal(health.schemaVersion, 1);
    assert.equal(health.checks.database, 'ok');
    assert.equal(health.checks.ffmpeg, toolsAvailable ? 'ok' : 'missing');
    assert.equal(health.checks.ffprobe, toolsAvailable ? 'ok' : 'missing');
    assert.deepEqual(health.providers, { groq: false, openrouter: false, pixabay: false });
  });

  it('GET /api/config renvoie exactement les limites du serveur de test', async () => {
    const result = await http(server().baseUrl, '/api/config');
    assert.equal(result.status, 200);
    assert.deepEqual(validatePublicConfigResponse(result.json), []);

    const config = result.json as {
      upload: {
        fieldName: string;
        maxBytes: number;
        minDurationSeconds: number;
        maxDurationSeconds: number;
        acceptedMimeTypes: string[];
        acceptedExtensions: string[];
      };
      timeline: unknown;
      fits: string[];
    };
    assert.equal(config.upload.fieldName, 'video');
    assert.equal(config.upload.maxBytes, 150 * 1024 * 1024);
    assert.equal(config.upload.minDurationSeconds, 5);
    assert.equal(config.upload.maxDurationSeconds, 180);
    assert.deepEqual(config.upload.acceptedMimeTypes, ['video/mp4']);
    assert.deepEqual(config.upload.acceptedExtensions, ['.mp4']);
    assert.deepEqual(config.timeline, TIMELINE_RULES);
    assert.deepEqual(config.fits, ['cover', 'contain']);
  });

  it('la base SQLite temporaire contient le schéma du contrat, en WAL', () => {
    assert.ok(existsSync(server().databasePath), 'base SQLite absente');
    assert.ok(statSync(server().databasePath).size > 0);

    const db = new DatabaseSync(server().databasePath);
    try {
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.equal(Number(version.user_version), 1);

      const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      assert.equal(String(journal.journal_mode).toLowerCase(), 'wal');

      const projectColumns = (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map((row) =>
        String(row.name),
      );
      assert.deepEqual(projectColumns, PROJECT_COLUMNS);

      const jobColumns = (db.prepare('PRAGMA table_info(render_jobs)').all() as Array<{ name: string }>).map((row) =>
        String(row.name),
      );
      assert.deepEqual(jobColumns, RENDER_JOB_COLUMNS);

      const jobDdl = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'render_jobs'")
        .get() as { sql: string } | undefined;
      assert.ok(jobDdl);
      for (const status of ['preparing', 'queued', 'rendering', 'completed', 'failed']) {
        assert.match(jobDdl.sql, new RegExp(`'${status}'`), `statut ${status} absent du CHECK SQL`);
      }
      assert.match(jobDdl.sql, /CHECK \(progress >= 0 AND progress <= 1\)/);
    } finally {
      db.close();
    }
  });

  it('le stockage temporaire est créé au démarrage', () => {
    assert.ok(existsSync(server().storageRoot), 'dossier de stockage absent');
    assert.ok(statSync(server().storageRoot).isDirectory());
  });

  it('les logs du serveur ne contiennent aucune clé fournisseur', async () => {
    await http(server().baseUrl, '/api/health');
    await http(server().baseUrl, '/api/inconnu');
    const logs = server().logs();
    assert.doesNotMatch(logs, /gsk_[A-Za-z0-9]{8,}|sk-or-v1-[A-Za-z0-9]{8,}/);
    assert.doesNotMatch(logs, /GROQ_API_KEY=|OPENROUTER_API_KEY=|PIXABAY_API_KEY=/);
  });
});

describe('intégration backend : routes projets livrées (contrat)', () => {
  it('POST /api/projects crée un projet vide conforme, relu à l’identique', async () => {
    const creation = await http(server().baseUrl, '/api/projects', { method: 'POST' });
    assert.equal(creation.status, 201, creation.text);
    assert.deepEqual(validateCreateProjectResponse(creation.json), []);

    const created = (creation.json as { project: { id: string; revision: number; source: unknown; urls: unknown } }).project;
    assert.equal(created.revision, 0);
    assert.equal(created.source, null);
    assert.deepEqual(created.urls, { source: null, download: null });

    const reread = await http(server().baseUrl, `/api/projects/${created.id}`);
    assert.equal(reread.status, 200, reread.text);
    assert.deepEqual(validateGetProjectResponse(reread.json), []);
    assert.equal((reread.json as { project: { id: string } }).project.id, created.id);
  });

  it('GET /status et /suggestions répondent au contrat pour un projet vide', async () => {
    const creation = await http(server().baseUrl, '/api/projects', { method: 'POST' });
    assert.equal(creation.status, 201, creation.text);
    const projectId = (creation.json as { project: { id: string } }).project.id;

    const status = await http(server().baseUrl, `/api/projects/${projectId}/status`);
    assert.equal(status.status, 200, status.text);
    assert.deepEqual(validateProjectStatusResponse(status.json), []);
    const statusBody = status.json as { projectId: string; sourceUploaded: boolean; analysis: { status: string } };
    assert.equal(statusBody.projectId, projectId);
    assert.equal(statusBody.sourceUploaded, false);
    assert.equal(statusBody.analysis.status, 'idle');

    const suggestions = await http(server().baseUrl, `/api/projects/${projectId}/suggestions`);
    assert.equal(suggestions.status, 200, suggestions.text);
    assert.deepEqual(validateSuggestionsResponse(suggestions.json), []);
    const suggestionsBody = suggestions.json as { projectId: string; brollItems: unknown[]; timeline: { segments: unknown[] } };
    assert.equal(suggestionsBody.projectId, projectId);
    assert.deepEqual(suggestionsBody.brollItems, []);
    assert.deepEqual(suggestionsBody.timeline, { segments: [] });
  });

  it('POST /api/projects/:id/analyze refuse un projet sans vidéo (409 ANALYSIS_NOT_READY)', async () => {
    const creation = await http(server().baseUrl, '/api/projects', { method: 'POST' });
    assert.equal(creation.status, 201, creation.text);
    const projectId = (creation.json as { project: { id: string } }).project.id;

    const result = await http(server().baseUrl, `/api/projects/${projectId}/analyze`, { method: 'POST' });
    assert.equal(result.status, 409, result.text);
    assert.deepEqual(validateApiErrorResponse(result.json), []);
    const body = result.json as { error: { code: string; stage: string; retryable: boolean } };
    assert.equal(body.error.code, 'ANALYSIS_NOT_READY');
    assert.equal(body.error.stage, 'analysis');
    assert.equal(body.error.retryable, false);
  });

  it('PATCH /api/projects/:id/timeline valide le corps, la révision et la source', async () => {
    const creation = await http(server().baseUrl, '/api/projects', { method: 'POST' });
    assert.equal(creation.status, 201, creation.text);
    const created = (creation.json as { project: { id: string; revision: number } }).project;
    const route = `/api/projects/${created.id}/timeline`;
    const patch = (body: unknown) =>
      http(server().baseUrl, route, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const empty = await patch({ baseRevision: created.revision, items: [] });
    assert.equal(empty.status, 200, empty.text);
    assert.deepEqual(validateUpdateTimelineResponse(empty.json), []);
    assert.equal((empty.json as { project: { revision: number } }).project.revision, created.revision, 'une requête vide ne doit rien changer');

    const unknownField = await patch({ baseRevision: created.revision, items: [], champInconnu: true });
    assert.equal(unknownField.status, 400, unknownField.text);
    assert.deepEqual(validateApiErrorResponse(unknownField.json), []);
    assert.equal((unknownField.json as { error: { code: string } }).error.code, 'VALIDATION_FAILED');

    const stale = await patch({ baseRevision: created.revision + 5, items: [] });
    assert.equal(stale.status, 409, stale.text);
    assert.deepEqual(validateApiErrorResponse(stale.json), []);
    assert.equal((stale.json as { error: { code: string } }).error.code, 'REVISION_CONFLICT');

    const noSource = await patch({ baseRevision: created.revision, items: [{ id: 'br_absent', enabled: false }] });
    assert.equal(noSource.status, 422, noSource.text);
    assert.deepEqual(validateApiErrorResponse(noSource.json), []);
    assert.equal((noSource.json as { error: { code: string } }).error.code, 'TIMELINE_INVALID');
  });

  it('GET /render/status expose un état idle conforme et /download refuse sans export', async () => {
    const creation = await http(server().baseUrl, '/api/projects', { method: 'POST' });
    assert.equal(creation.status, 201, creation.text);
    const projectId = (creation.json as { project: { id: string; revision: number } }).project.id;

    const status = await http(server().baseUrl, `/api/projects/${projectId}/render/status`);
    assert.equal(status.status, 200, status.text);
    assert.deepEqual(validateRenderStatusResponse(status.json), []);
    const body = status.json as {
      projectId: string;
      projectRevision: number;
      render: { status: string; jobId: string | null; progress: number; urls?: unknown };
    };
    assert.equal(body.projectId, projectId);
    assert.equal(body.render.status, 'idle');
    assert.equal(body.render.jobId, null);
    assert.equal(body.render.progress, 0);

    const download = await http(server().baseUrl, `/api/projects/${projectId}/download`);
    assert.equal(download.status, 409, download.text);
    assert.deepEqual(validateApiErrorResponse(download.json), []);
    const error = (download.json as { error: { code: string; stage: string; retryable: boolean } }).error;
    assert.equal(error.code, 'DOWNLOAD_NOT_READY');
    assert.equal(error.stage, 'download');
    assert.equal(error.retryable, true);
  });

  it('POST /render refuse un projet non analysé et un corps invalide', async () => {
    const creation = await http(server().baseUrl, '/api/projects', { method: 'POST' });
    assert.equal(creation.status, 201, creation.text);
    const created = (creation.json as { project: { id: string; revision: number } }).project;
    const route = `/api/projects/${created.id}/render`;
    const post = (body: unknown) =>
      http(server().baseUrl, route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const invalid = await post({});
    assert.equal(invalid.status, 400, invalid.text);
    assert.deepEqual(validateApiErrorResponse(invalid.json), []);
    assert.equal((invalid.json as { error: { code: string } }).error.code, 'VALIDATION_FAILED');

    const notReady = await post({ revision: created.revision });
    assert.equal(notReady.status, 409, notReady.text);
    assert.deepEqual(validateApiErrorResponse(notReady.json), []);
    assert.equal((notReady.json as { error: { code: string } }).error.code, 'RENDER_NOT_READY');
  });

  it('GET /media/source sans vidéo importée renvoie 404 structurée, sans chemin serveur', async () => {
    const creation = await http(server().baseUrl, '/api/projects', { method: 'POST' });
    assert.equal(creation.status, 201, creation.text);
    const projectId = (creation.json as { project: { id: string } }).project.id;

    const result = await http(server().baseUrl, `/api/projects/${projectId}/media/source`);
    assert.equal(result.status, 404, result.text);
    assert.deepEqual(validateApiErrorResponse(result.json), []);
    assert.equal((result.json as { error: { code: string } }).error.code, 'NOT_FOUND');
    assert.doesNotMatch(result.text, /[A-Za-z]:\\|\/home\/|\/Users\/|storage|projects\\/i);
  });
});

describe('intégration backend : route P0 encore attendue (19/11/2026)', () => {
  /*
   * Claude a livré création, lecture, statut, suggestions, import, média
   * source, analyse, édition de timeline, rendu, statut et téléchargement.
   * Seule la suppression (proposée D-11) reste absente. On utilise un vrai
   * projet pour distinguer « route absente » de « projet inconnu » : quand elle
   * sera livrée, ce test échouera volontairement et devra être remplacé.
   */
  let projectId = '';

  before(async () => {
    const creation = await http(server().baseUrl, '/api/projects', { method: 'POST' });
    assert.equal(creation.status, 201, creation.text);
    projectId = (creation.json as { project: { id: string } }).project.id;
  });

  const routes: ReadonlyArray<readonly [string, string]> = [['DELETE', '/api/projects/:id']];

  for (const [method, template] of routes) {
    it(`${method} ${template.replace(':id', 'projet_qa')} n’est pas encore livrée → 404 structurée`, async () => {
      const route = template.replace(':id', projectId);
      const result = await http(server().baseUrl, route, {
        method,
        ...(method === 'POST' || method === 'PATCH'
          ? { headers: { 'Content-Type': 'application/json' }, body: '{}' }
          : {}),
      });
      assert.equal(result.status, 404, `${method} ${template} semble implémentée : mettre à jour ce test et le parcours.`);
      assert.deepEqual(validateApiErrorResponse(result.json), []);
      const body = result.json as { error: { code: string; stage: string }; requestId: string };
      assert.equal(body.error.code, 'NOT_FOUND');
      assert.equal(body.error.stage, 'request');
      assert.equal(body.requestId, result.headers.get('x-request-id'));
    });
  }
});
