import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import express, { type RequestHandler } from 'express';
import { createApp } from '../src/app.ts';
import type { ApiErrorResponse, HealthResponse, PublicConfigResponse } from '../src/contract.ts';
import { openDatabase } from '../src/db/database.ts';
import { AppError, errorHandler, notFoundHandler } from '../src/utils/errors.ts';
import { requestContext } from '../src/utils/request-context.ts';
import { silentLogger, startTestServer, testConfig, type TestServer } from './helpers.ts';

const AVAILABLE = { available: true, version: 'test' } as const;
const MISSING = { available: false, version: null } as const;

describe('API système', () => {
  let db: DatabaseSync;
  let server: TestServer;

  before(async () => {
    db = openDatabase(':memory:');
    const config = testConfig({ FRONTEND_ORIGIN: 'http://localhost:5500,https://alt-broll.web.app' });
    const app = createApp({ config, logger: silentLogger, db, binaries: { ffmpeg: AVAILABLE, ffprobe: AVAILABLE } });
    server = await startTestServer(app);
  });

  after(async () => {
    await server.close();
    db.close();
  });

  it("GET /api/health répond 200 avec l'état des dépendances", async () => {
    const res = await fetch(`${server.baseUrl}/api/health`);
    const body = (await res.json()) as HealthResponse;

    assert.equal(res.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.schemaVersion, 1);
    assert.deepEqual(body.checks, { database: 'ok', ffmpeg: 'ok', ffprobe: 'ok' });
    assert.deepEqual(body.providers, { groq: false, openrouter: false, pixabay: false });
  });

  it('GET /api/config expose les limites publiques du contrat', async () => {
    const res = await fetch(`${server.baseUrl}/api/config`);
    const body = (await res.json()) as PublicConfigResponse;

    assert.equal(res.status, 200);
    assert.equal(body.upload.fieldName, 'video');
    assert.equal(body.upload.maxBytes, 150 * 1024 * 1024);
    assert.deepEqual(body.upload.acceptedMimeTypes, ['video/mp4']);
    assert.equal(body.timeline.maxCandidatesPerItem, 4);
    assert.deepEqual(body.fits, ['cover', 'contain']);
  });

  it('répond à une route inconnue par une 404 structurée et identifiée', async () => {
    const res = await fetch(`${server.baseUrl}/api/route-inconnue`);
    const body = (await res.json()) as ApiErrorResponse;

    assert.equal(res.status, 404);
    assert.deepEqual(
      { code: body.error.code, stage: body.error.stage, retryable: body.error.retryable },
      { code: 'NOT_FOUND', stage: 'request', retryable: false },
    );
    assert.equal(res.headers.get('x-request-id'), body.requestId);
  });

  it('rejette un JSON invalide par une erreur 400 sans détail technique', async () => {
    const res = await fetch(`${server.baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"incomplet": ',
    });
    const text = await res.text();
    const body = JSON.parse(text) as ApiErrorResponse;

    assert.equal(res.status, 400);
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.doesNotMatch(text, /SyntaxError|JSON\.parse|node_modules/);
  });

  it('autorise seulement les origines configurées (CORS)', async () => {
    const allowed = await fetch(`${server.baseUrl}/api/health`, { headers: { Origin: 'https://alt-broll.web.app' } });
    const refused = await fetch(`${server.baseUrl}/api/health`, { headers: { Origin: 'https://inconnu.example' } });

    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://alt-broll.web.app');
    assert.equal(refused.headers.get('access-control-allow-origin'), null);
  });
});

describe('API système avec une dépendance manquante', () => {
  it('signale un état dégradé (503) quand ffprobe est introuvable', async () => {
    const db = openDatabase(':memory:');
    const app = createApp({ config: testConfig(), logger: silentLogger, db, binaries: { ffmpeg: AVAILABLE, ffprobe: MISSING } });
    const server = await startTestServer(app);
    try {
      const res = await fetch(`${server.baseUrl}/api/health`);
      const body = (await res.json()) as HealthResponse;

      assert.equal(res.status, 503);
      assert.equal(body.status, 'degraded');
      assert.equal(body.checks.ffprobe, 'missing');
    } finally {
      await server.close();
      db.close();
    }
  });
});

describe('errorHandler', () => {
  async function serveThrowing(handler: RequestHandler): Promise<TestServer> {
    const app = express();
    app.use(requestContext(silentLogger));
    app.get('/boom', handler);
    app.use(notFoundHandler);
    app.use(errorHandler(silentLogger));
    return startTestServer(app);
  }

  it("transmet le code, l'étape, le message et le statut HTTP d'une AppError", async () => {
    const server = await serveThrowing(() => {
      throw new AppError({
        code: 'VIDEO_TOO_LONG',
        stage: 'upload',
        httpStatus: 422,
        message: 'La vidéo dépasse la durée maximale de la bêta (3 min).',
      });
    });
    try {
      const res = await fetch(`${server.baseUrl}/boom`);
      const body = (await res.json()) as ApiErrorResponse;

      assert.equal(res.status, 422);
      assert.deepEqual(body.error, {
        code: 'VIDEO_TOO_LONG',
        stage: 'upload',
        message: 'La vidéo dépasse la durée maximale de la bêta (3 min).',
        retryable: false,
      });
    } finally {
      await server.close();
    }
  });

  it("masque le message et la stack d'une erreur inattendue", async () => {
    const server = await serveThrowing(() => {
      throw new Error('ENOENT: C:\\secret\\storage\\projects\\abc\\source.mp4');
    });
    try {
      const res = await fetch(`${server.baseUrl}/boom`);
      const text = await res.text();
      const body = JSON.parse(text) as ApiErrorResponse;

      assert.equal(res.status, 500);
      assert.equal(body.error.code, 'INTERNAL_ERROR');
      assert.doesNotMatch(text, /ENOENT|secret|storage|at /);
    } finally {
      await server.close();
    }
  });
});
