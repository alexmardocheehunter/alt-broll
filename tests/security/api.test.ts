import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { http, startBackend, type HttpResult, type RunningBackend } from '../lib/backend-server.ts';
import { mediaPath, PROJECT_ROOT } from '../lib/paths.ts';
import {
  validateApiErrorResponse,
  validateHealthResponse,
  validatePublicConfigResponse,
} from '../lib/validation/api.ts';

/*
 * Audit dynamique de sécurité : le vrai backend est lancé sur un port libre,
 * avec des clés fournisseur forcées vides et une base temporaire.
 *
 * Aucune requête ne sort de la machine : les seules URLs appelées sont
 * 127.0.0.1:<port>. Les tests vérifient CORS, en-têtes, erreurs structurées,
 * limitation de taille, traversée de chemin et refus de démarrer en production
 * sans clés.
 */

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

function assertStructuredError(result: HttpResult, expectedStatus: number, expectedCode: string): void {
  assert.equal(result.status, expectedStatus, `statut ${expectedStatus} attendu (reçu ${result.status}) : ${result.text}`);
  const problems = validateApiErrorResponse(result.json);
  assert.deepEqual(problems, [], `corps d’erreur hors contrat : ${problems.join(' ; ')}`);
  const body = result.json as { error: { code: string; retryable: boolean }; requestId: string };
  assert.equal(body.error.code, expectedCode);
  assert.equal(body.requestId, result.headers.get('x-request-id'), 'requestId du corps ≠ en-tête X-Request-Id');
  assert.doesNotMatch(result.text, /[A-Za-z]:\\|\/home\/|\/Users\/|node_modules|\bENOENT\b|\n\s+at\s+\S+/);
}

describe('sécurité API : en-têtes et CORS', () => {
  it('n’expose ni X-Powered-By ni cookie, et attribue un X-Request-Id unique', async () => {
    const first = await http(server().baseUrl, '/api/health');
    const second = await http(server().baseUrl, '/api/config');

    for (const result of [first, second]) {
      assert.equal(result.headers.get('x-powered-by'), null);
      assert.equal(result.headers.get('set-cookie'), null);
      const requestId = result.headers.get('x-request-id');
      assert.match(requestId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    }
    assert.notEqual(first.headers.get('x-request-id'), second.headers.get('x-request-id'));

    assert.match(first.headers.get('content-type') ?? '', /^application\/json\b/);
    assert.match(second.headers.get('content-type') ?? '', /^application\/json\b/);
  });

  it('accepte l’origine déclarée dans FRONTEND_ORIGIN', async () => {
    const result = await http(server().baseUrl, '/api/health', {
      headers: { Origin: 'https://qa.alt-broll.test' },
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('access-control-allow-origin'), 'https://qa.alt-broll.test');
    assert.match(result.headers.get('vary') ?? '', /Origin/i);
    assert.equal(result.headers.get('access-control-allow-credentials'), null);
  });

  it('refuse une origine étrangère sans renvoyer d’en-tête CORS', async () => {
    for (const origin of ['https://evil.example', 'null']) {
      const result = await http(server().baseUrl, '/api/health', { headers: { Origin: origin } });
      assert.equal(result.status, 200, 'la requête simple reste traitée, mais sans autorisation CORS');
      assert.equal(result.headers.get('access-control-allow-origin'), null, `origine autorisée à tort : ${origin}`);
    }
  });

  it('répond correctement au préflight d’une origine autorisée', async () => {
    const result = await http(server().baseUrl, '/api/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5500',
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'content-type, authorization',
      },
    });
    assert.equal(result.status, 204);
    assert.equal(result.headers.get('access-control-allow-origin'), 'http://localhost:5500');
    assert.match(result.headers.get('access-control-allow-methods') ?? '', /PATCH/);
    assert.match(result.headers.get('access-control-allow-headers') ?? '', /authorization/i);
    assert.equal(result.headers.get('access-control-max-age'), '600');
  });

  it('refuse le préflight d’une origine non déclarée', async () => {
    const result = await http(server().baseUrl, '/api/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'GET',
      },
    });
    assert.equal(result.headers.get('access-control-allow-origin'), null);
  });
});

describe('sécurité API : santé et configuration publiques', () => {
  it('GET /api/health respecte le contrat et ne révèle aucune clé', async () => {
    const result = await http(server().baseUrl, '/api/health');
    assert.ok([200, 503].includes(result.status), `statut inattendu : ${result.status}`);
    assert.deepEqual(validateHealthResponse(result.json), []);

    const health = result.json as {
      providers: { groq: boolean; openrouter: boolean; pixabay: boolean };
      uptimeSeconds: number;
      time: string;
    };
    assert.deepEqual(health.providers, { groq: false, openrouter: false, pixabay: false });
    assert.ok(health.uptimeSeconds >= 0);
    assert.ok(Math.abs(Date.now() - Date.parse(health.time)) < 120_000);
    assert.doesNotMatch(result.text, /apiKey|GROQ_API_KEY|OPENROUTER_API_KEY|PIXABAY_API_KEY|secret/i);
  });

  it('GET /api/config expose uniquement les règles publiques, jamais un chemin', async () => {
    const result = await http(server().baseUrl, '/api/config');
    assert.equal(result.status, 200);
    assert.deepEqual(validatePublicConfigResponse(result.json), []);
    assert.doesNotMatch(
      result.text,
      /apiKey|DATABASE_PATH|STORAGE_ROOT|FRONTEND_ORIGIN|APP_BASE_URL|[A-Za-z]:\\|\/home\/|\/Users\//,
    );
  });
});

describe('sécurité API : erreurs structurées', () => {
  it('une route inconnue renvoie 404 NOT_FOUND avec requestId vérifiable', async () => {
    const result = await http(server().baseUrl, '/api/route-inconnue');
    assertStructuredError(result, 404, 'NOT_FOUND');
  });

  it('un projet inexistant est indistinguable d’une route inconnue (pas d’énumération)', async () => {
    const result = await http(server().baseUrl, '/api/projects/projet_inexistant');
    assertStructuredError(result, 404, 'NOT_FOUND');
    assert.doesNotMatch(result.text, /projet_inexistant/i, 'le corps ne doit pas confirmer l’existence ou l’absence d’un identifiant');
  });

  it('un JSON invalide renvoie 400 BAD_REQUEST sans détail technique', async () => {
    const result = await http(server().baseUrl, '/api/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"incomplet":',
    });
    assertStructuredError(result, 400, 'BAD_REQUEST');
    assert.match(result.text, /JSON valide/i);
  });

  it('un corps JSON au-delà de 1 Mio renvoie 413 PAYLOAD_TOO_LARGE', async () => {
    const result = await http(server().baseUrl, '/api/health', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remplissage: 'a'.repeat(1_100_000) }),
    });
    assertStructuredError(result, 413, 'PAYLOAD_TOO_LARGE');
  });

  it('les erreurs 4xx ne contiennent ni stack ni chemin serveur', async () => {
    for (const route of ['/api/inconnu', '/.env', '/backend/data/alt-broll.sqlite']) {
      const result = await http(server().baseUrl, route);
      assert.equal(result.status, 404);
      assert.doesNotMatch(result.headers.get('x-powered-by') ?? '', /express/i);
      assert.doesNotMatch(result.text, /express|node_modules|\.ts:\d+|at\s+\w+\s*\(/i);
    }
  });
});

describe('sécurité API : traversée de chemin et fichiers internes', () => {
  it('les tentatives de lecture de .env, base, stockage et fixtures restent des 404', async () => {
    const attempts = [
      '/.env',
      '/.env.example',
      '/backend/data/alt-broll.sqlite',
      '/storage/qa.sqlite',
      '/tests/fixtures/media/source-30s.mp4',
      '/tests/fixtures/media/manifest.json',
      '/api/projects/..%5C..%5C.env',
      '/api/projects/%2e%2e%2f%2e%2e%2f.env',
      '/api/projects/..%2F..%2Fbackend%2Fdata%2Fqa.sqlite',
    ];
    for (const route of attempts) {
      const result = await http(server().baseUrl, route);
      assert.equal(result.status, 404, `${route} ne doit pas être servi (statut ${result.status})`);
      assert.match(result.headers.get('content-type') ?? '', /^application\/json\b/, `${route} ne doit pas renvoyer un fichier`);
      assert.doesNotMatch(result.text, /source-30s|SQLite format|PIXABAY|GROQ|OPENROUTER/i);
    }
  });

  it('une méthode non prévue sur une route technique reste une 404 structurée', async () => {
    const result = await http(server().baseUrl, '/api/health', { method: 'PUT' });
    assertStructuredError(result, 404, 'NOT_FOUND');
  });
});

describe('sécurité API : import de fichiers', () => {
  it('neutralise un nom de fichier tentant une traversée de dossier', async () => {
    const creation = await http(server().baseUrl, '/api/projects', { method: 'POST' });
    assert.equal(creation.status, 201, creation.text);
    const projectId = (creation.json as { project: { id: string } }).project.id;

    const form = new FormData();
    form.set(
      'video',
      new Blob([readFileSync(mediaPath('source-30s.mp4'))], { type: 'video/mp4' }),
      '..\\..\\evil.mp4',
    );

    const result = await http(server().baseUrl, `/api/projects/${projectId}/upload`, { method: 'POST', body: form });
    assert.equal(result.status, 200, result.text);

    const source = (result.json as { project: { source: { originalName: string; storedFileName: string } } }).project.source;
    assert.equal(source.originalName, 'evil.mp4', 'le nom d’origine doit être réduit au basename');
    assert.match(source.storedFileName, /^[0-9a-f-]{36}\.mp4$/, 'le nom de stockage doit être un UUID serveur');
    assert.doesNotMatch(source.storedFileName, /[\\/]|\.\./);

    const sourceDir = path.join(server().storageRoot, 'projects', projectId, 'source');
    assert.deepEqual(readdirSync(sourceDir), [source.storedFileName], 'aucun fichier hors du nom prévu ne doit être écrit');
  });

  it('refuse un fichier dont le type déclaré n’est pas une vidéo', async () => {
    const creation = await http(server().baseUrl, '/api/projects', { method: 'POST' });
    assert.equal(creation.status, 201, creation.text);
    const projectId = (creation.json as { project: { id: string } }).project.id;

    const form = new FormData();
    form.set('video', new Blob([readFileSync(mediaPath('source-30s.mp4'))], { type: 'text/plain' }), 'source.mp4');
    const result = await http(server().baseUrl, `/api/projects/${projectId}/upload`, { method: 'POST', body: form });

    assert.equal(result.status, 415, result.text);
    assert.deepEqual(validateApiErrorResponse(result.json), []);
    assert.equal((result.json as { error: { code: string } }).error.code, 'UPLOAD_UNSUPPORTED_TYPE');
  });
});

describe('sécurité API : limitation de débit', () => {
  it('renvoie 429 RATE_LIMITED avec Retry-After au-delà de la limite d’écritures', async () => {
    const limited = await startBackend({ env: { RATE_LIMIT_WRITES_PER_HOUR: '2' } });
    try {
      for (let index = 0; index < 2; index += 1) {
        const allowed = await http(limited.baseUrl, '/api/projects', { method: 'POST' });
        assert.equal(allowed.status, 201, `écriture ${index + 1} refusée à tort : ${allowed.text}`);
      }

      const blocked = await http(limited.baseUrl, '/api/projects', { method: 'POST' });
      assert.equal(blocked.status, 429, blocked.text);
      assert.deepEqual(validateApiErrorResponse(blocked.json), []);
      assert.equal((blocked.json as { error: { code: string; retryable: boolean } }).error.code, 'RATE_LIMITED');
      assert.equal((blocked.json as { error: { retryable: boolean } }).error.retryable, true);
      const retryAfter = Number(blocked.headers.get('retry-after'));
      assert.ok(Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 3600, `Retry-After invalide : ${retryAfter}`);

      const read = await http(limited.baseUrl, '/api/health');
      assert.equal(read.status, 200, 'la limitation ne doit pas bloquer les lectures');
    } finally {
      await limited.stop();
    }
  });

  it('ignore X-Forwarded-For quand TRUST_PROXY est désactivé (pas d’usurpation)', async () => {
    const limited = await startBackend({ env: { RATE_LIMIT_WRITES_PER_HOUR: '1' } });
    try {
      const first = await http(limited.baseUrl, '/api/projects', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '203.0.113.10' },
      });
      assert.equal(first.status, 201, first.text);

      const spoofed = await http(limited.baseUrl, '/api/projects', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '203.0.113.11' },
      });
      assert.equal(spoofed.status, 429, 'une IP forgée ne doit pas ouvrir un nouveau quota');
    } finally {
      await limited.stop();
    }
  });

  it('applique la limite par adresse cliente derrière un proxy de confiance', async () => {
    const proxied = await startBackend({
      env: { TRUST_PROXY: 'loopback', RATE_LIMIT_WRITES_PER_HOUR: '1' },
    });
    try {
      const first = await http(proxied.baseUrl, '/api/projects', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '203.0.113.20' },
      });
      assert.equal(first.status, 201, first.text);

      const sameClient = await http(proxied.baseUrl, '/api/projects', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '203.0.113.20' },
      });
      assert.equal(sameClient.status, 429, 'le même client doit être limité');

      const otherClient = await http(proxied.baseUrl, '/api/projects', {
        method: 'POST',
        headers: { 'X-Forwarded-For': '203.0.113.21' },
      });
      assert.equal(otherClient.status, 201, 'un autre client doit conserver son propre quota');
    } finally {
      await proxied.stop();
    }
  });
});

describe('sécurité : configuration de production', () => {
  function runServer(env: Record<string, string>): { status: number | null; stderr: string; stdout: string } {
    const result = spawnSync(process.execPath, ['src/server.ts'], {
      cwd: path.join(PROJECT_ROOT, 'backend'),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '3987',
        LOG_LEVEL: 'error',
        GROQ_API_KEY: '',
        OPENROUTER_API_KEY: '',
        OPENROUTER_MODEL: '',
        PIXABAY_API_KEY: '',
        ...env,
      },
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    });
    return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' };
  }

  it('refuse de démarrer en production sans les quatre variables fournisseur', () => {
    const result = runServer({});
    assert.equal(result.status, 1, `le serveur aurait dû refuser de démarrer : ${result.stdout}`);
    assert.match(result.stderr, /Configuration invalide/);
    for (const key of ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'PIXABAY_API_KEY']) {
      assert.match(result.stderr, new RegExp(key), `la variable manquante ${key} doit être citée`);
    }
    assert.doesNotMatch(result.stderr, /gsk_[A-Za-z0-9]{8,}|sk-or-v1-[A-Za-z0-9]{8,}/);
  });

  it('refuse un PORT hors bornes sans afficher la valeur brute', () => {
    const result = spawnSync(process.execPath, ['src/server.ts'], {
      cwd: path.join(PROJECT_ROOT, 'backend'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: '0',
        LOG_LEVEL: 'error',
        GROQ_API_KEY: '',
        OPENROUTER_API_KEY: '',
        OPENROUTER_MODEL: '',
        PIXABAY_API_KEY: '',
      },
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr ?? '', /PORT/);
    assert.match(result.stderr ?? '', /Configuration invalide/);
  });

  it('refuse TRUST_PROXY=true : un client ne doit pas choisir son adresse IP', () => {
    const result = spawnSync(process.execPath, ['src/server.ts'], {
      cwd: path.join(PROJECT_ROOT, 'backend'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: '3988',
        LOG_LEVEL: 'error',
        TRUST_PROXY: 'true',
        GROQ_API_KEY: '',
        OPENROUTER_API_KEY: '',
        OPENROUTER_MODEL: '',
        PIXABAY_API_KEY: '',
      },
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    });
    assert.equal(result.status, 1, `TRUST_PROXY=true aurait dû être refusé : ${result.stdout}`);
    assert.match(result.stderr ?? '', /TRUST_PROXY/);
    assert.match(result.stderr ?? '', /Configuration invalide/);
  });
});
