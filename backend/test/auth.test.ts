import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  createFirebaseTokenVerifier,
  FIREBASE_JWKS_URL,
  InvalidTokenError,
  SigningKeysUnavailableError,
} from '../src/auth/firebase-token.ts';
import { createMediaUrlSigner } from '../src/auth/media-url.ts';
import type { ApiErrorResponse, AuthSessionResponse, CreateProjectResponse, GetProjectResponse } from '../src/contract.ts';
import type { FetchLike } from '../src/providers/types.ts';
import { startTestApp, type TestApp } from './helpers.ts';

const PROJECT_ID = 'alt-broll-test';
const SECRET = 'secret-de-test-des-liens-signes-0123456789';
const NOW_MS = Date.parse('2026-11-19T10:00:00.000Z');
const NOW_S = NOW_MS / 1000;

interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
}

function newKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, publicKey };
}

const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Jeton au format Firebase, signé par `key` ; `claims` remplace les valeurs par défaut. */
function token(key: SigningKey, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): string {
  const head = base64url({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const body = base64url({
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: 'uid-awa',
    user_id: 'uid-awa',
    email: 'awa@example.com',
    iat: NOW_S - 60,
    exp: NOW_S + 3600,
    auth_time: NOW_S - 120,
    ...claims,
  });
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

/** Clés publiques servies comme le fait Google (JWK + Cache-Control). */
function jwksFetch(keys: () => readonly SigningKey[]): FetchLike & { calls: number } {
  const fetch = (async (url: string) => {
    fetch.calls += 1;
    assert.equal(url, FIREBASE_JWKS_URL);
    const body = { keys: keys().map((key) => ({ ...key.publicKey.export({ format: 'jwk' }), kid: key.kid, alg: 'RS256', use: 'sig' })) };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Cache-Control': 'public, max-age=3600' } });
  }) as FetchLike & { calls: number };
  fetch.calls = 0;
  return fetch;
}

describe('jetons Firebase', () => {
  const current = newKey('cle-1');
  const verifierWith = (fetch: FetchLike, now: () => number = () => NOW_MS) =>
    createFirebaseTokenVerifier({ projectId: PROJECT_ID, fetch, now });

  it('accepte un jeton valide et renvoie le compte', async () => {
    const user = await verifierWith(jwksFetch(() => [current])).verify(token(current));
    assert.deepEqual(user, { id: 'uid-awa', email: 'awa@example.com' });
  });

  it('refuse tout jeton non conforme', async () => {
    const verifier = verifierWith(jwksFetch(() => [current]));
    const intruder = newKey('cle-1');
    const forged = token(current, { sub: 'uid-pirate' }).split('.');
    const cases: Record<string, string> = {
      expiré: token(current, { exp: NOW_S - 120 }),
      'autre projet (audience)': token(current, { aud: 'autre-projet' }),
      'autre émetteur': token(current, { iss: 'https://accounts.google.com' }),
      'émis dans le futur': token(current, { iat: NOW_S + 600 }),
      'connexion dans le futur': token(current, { auth_time: NOW_S + 600 }),
      'compte vide': token(current, { sub: '' }),
      'signé par une autre clé': token(intruder),
      'contenu modifié après signature': `${forged[0]}.${base64url({ sub: 'uid-pirate' })}.${forged[2]}`,
      'algorithme imposé « none »': `${base64url({ alg: 'none', kid: 'cle-1' })}.${base64url({ sub: 'x' })}.`,
      'algorithme HS256': token(current, {}, { alg: 'HS256' }),
      'pas un JWT': 'abc.def',
      'clé inconnue': token(newKey('cle-inconnue')),
    };
    for (const [label, value] of Object.entries(cases)) {
      await assert.rejects(verifier.verify(value), InvalidTokenError, label);
    }
  });

  it('garde les clés en cache, et les recharge pour une clé nouvelle (rotation)', async () => {
    const next = newKey('cle-2');
    let published = [current];
    let nowMs = NOW_MS;
    const fetch = jwksFetch(() => published);
    const verifier = verifierWith(fetch, () => nowMs);

    await verifier.verify(token(current));
    await verifier.verify(token(current));
    assert.equal(fetch.calls, 1, 'clés en cache');

    published = [current, next];
    nowMs += 60_000;
    assert.equal((await verifier.verify(token(next, { iat: NOW_S, auth_time: NOW_S }))).id, 'uid-awa');
    assert.equal(fetch.calls, 2, 'rechargées pour la nouvelle clé');
  });

  it('signale une indisponibilité si les clés de Google sont injoignables', async () => {
    const verifier = verifierWith(async () => new Response('panne', { status: 503 }));
    await assert.rejects(verifier.verify(token(current)), SigningKeysUnavailableError);
  });
});

describe('liens signés', () => {
  it('valident la vidéo du bon projet, avant échéance, et rien d’autre', () => {
    let nowMs = NOW_MS;
    const signer = createMediaUrlSigner(SECRET, () => nowMs);
    const params = new URLSearchParams(signer.query('projet-a', 'source'));
    const exp = params.get('exp');
    const sig = params.get('sig');

    assert.equal(signer.isValid('projet-a', 'source', exp, sig), true);
    assert.equal(signer.isValid('projet-b', 'source', exp, sig), false, 'autre projet');
    assert.equal(signer.isValid('projet-a', 'download', exp, sig), false, 'autre fichier');
    assert.equal(signer.isValid('projet-a', 'source', String(Number(exp) + 3600), sig), false, 'échéance modifiée');
    assert.equal(createMediaUrlSigner('autre-secret-de-test-0123456789-abcdef').isValid('projet-a', 'source', exp, sig), false);
    assert.equal(signer.isValid('projet-a', 'source', undefined, undefined), false);
    nowMs = Number(exp) * 1000 + 1;
    assert.equal(signer.isValid('projet-a', 'source', exp, sig), false, 'expiré');
  });

  it('gardent la même adresse pendant une heure (cache du navigateur)', () => {
    let nowMs = Date.parse('2026-11-19T10:05:00.000Z');
    const signer = createMediaUrlSigner(SECRET, () => nowMs);
    const first = signer.query('projet-a', 'source');
    nowMs += 40 * 60_000;
    assert.equal(signer.query('projet-a', 'source'), first);
  });
});

describe('connexion Google (AUTH_MODE=firebase)', () => {
  const key = newKey('cle-app');
  let app: TestApp;
  const realNow = Date.now() / 1000;
  /** Jetons datés de maintenant : le serveur de test utilise l'horloge réelle. */
  const live = (claims: Record<string, unknown> = {}): string =>
    token(key, { iat: realNow - 60, auth_time: realNow - 120, exp: realNow + 3600, ...claims });
  const awa = live();
  const kofi = live({ sub: 'uid-kofi', user_id: 'uid-kofi', email: 'kofi@example.com' });

  before(async () => {
    app = await startTestApp(
      { AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: PROJECT_ID, MEDIA_URL_SECRET: SECRET, RATE_LIMIT_WRITES_PER_HOUR: '1000' },
      { fetch: jwksFetch(() => [key]) },
    );
  });

  after(async () => {
    await app.close();
  });

  const call = (route: string, bearer: string | null, init: RequestInit = {}) =>
    fetch(`${app.baseUrl}${route}`, {
      ...init,
      headers: { ...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }), ...(init.headers as Record<string, string>) },
    });

  async function createProject(bearer: string): Promise<string> {
    const res = await call('/api/projects', bearer, { method: 'POST' });
    assert.equal(res.status, 201);
    return ((await res.json()) as CreateProjectResponse).project.id;
  }

  it('indique le mode de connexion et le compte reconnu', async () => {
    const anonymous = (await (await call('/api/auth/session', null)).json()) as AuthSessionResponse;
    const signedIn = (await (await call('/api/auth/session', awa)).json()) as AuthSessionResponse;
    const expired = (await (await call('/api/auth/session', live({ exp: realNow - 600 }))).json()) as AuthSessionResponse;

    assert.deepEqual(anonymous, { mode: 'firebase', firebaseProjectId: PROJECT_ID, user: null });
    assert.deepEqual(signedIn.user, { id: 'uid-awa', email: 'awa@example.com' });
    assert.equal(expired.user, null);
  });

  it('exige une connexion pour créer ou ouvrir un projet ; santé et règles restent publiques', async () => {
    const refused = await call('/api/projects', null, { method: 'POST' });
    const body = (await refused.json()) as ApiErrorResponse;
    const id = await createProject(awa);
    const withoutToken = await call(`/api/projects/${id}`, null);
    const badToken = await call(`/api/projects/${id}`, `${awa}x`);

    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get('www-authenticate'), 'Bearer');
    assert.deepEqual([body.error.code, body.error.stage], ['UNAUTHORIZED', 'request']);
    assert.equal(withoutToken.status, 401);
    assert.equal(badToken.status, 401);
    assert.equal((await call('/api/config', null)).status, 200);
    assert.equal((await call('/api/health', null)).status, 200);
  });

  it("cache les projets d'un autre compte (404), y compris pour les modifier ou les supprimer", async () => {
    const id = await createProject(awa);

    const own = await call(`/api/projects/${id}`, awa);
    const reads = await Promise.all(
      [`/api/projects/${id}`, `/api/projects/${id}/status`, `/api/projects/${id}/render/status`].map((route) => call(route, kofi)),
    );
    const removal = await call(`/api/projects/${id}`, kofi, { method: 'DELETE' });
    const patch = await call(`/api/projects/${id}/timeline`, kofi, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevision: 0, items: [] }),
    });

    assert.equal(own.status, 200);
    assert.deepEqual([...reads, removal, patch].map((res) => res.status), [404, 404, 404, 404, 404]);
    assert.equal((await call(`/api/projects/${id}`, awa, { method: 'DELETE' })).status, 204, 'le propriétaire peut supprimer');
  });

  it('ouvre la vidéo et le téléchargement par lien signé, sans en-tête', async () => {
    const id = await createProject(awa);
    const project = ((await (await call(`/api/projects/${id}`, awa)).json()) as GetProjectResponse).project;
    const signer = createMediaUrlSigner(SECRET);

    const signedSource = await call(`/api/projects/${id}/media/source?${signer.query(id, 'source')}`, null);
    const signedDownload = await call(`/api/projects/${id}/download?${signer.query(id, 'download')}`, null);
    const wrongResource = await call(`/api/projects/${id}/media/source?${signer.query(id, 'download')}`, null);
    const signedButWrite = await call(`/api/projects/${id}/analyze?${signer.query(id, 'source')}`, null, { method: 'POST' });

    assert.equal(project.urls.source, null, 'pas encore de vidéo');
    // Le lien est accepté : la réponse vient de la route (rien à servir), pas du contrôle d'accès.
    assert.equal(signedSource.status, 404);
    assert.match(((await signedSource.json()) as ApiErrorResponse).error.message, /Aucune vidéo/);
    assert.equal(signedDownload.status, 409);
    assert.equal(wrongResource.status, 401);
    assert.equal(signedButWrite.status, 401);
  });
});
