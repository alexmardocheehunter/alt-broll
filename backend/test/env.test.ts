import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, PROJECT_ROOT, loadConfig } from '../src/config/env.ts';

const PRODUCTION_KEYS = {
  NODE_ENV: 'production',
  GROQ_API_KEY: 'test-groq',
  OPENROUTER_API_KEY: 'test-openrouter',
  OPENROUTER_MODEL: 'fournisseur/modele-vision',
  PIXABAY_API_KEY: 'test-pixabay',
};

function configErrorMatching(pattern: RegExp) {
  return (error: unknown): boolean => error instanceof ConfigError && pattern.test(error.message);
}

describe('loadConfig', () => {
  it('applique les valeurs par défaut en développement', () => {
    const config = loadConfig({});

    assert.equal(config.nodeEnv, 'development');
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 3000);
    assert.deepEqual(config.frontendOrigins, ['http://localhost:5500']);
    assert.equal(config.limits.maxUploadBytes, 150 * 1024 * 1024);
    assert.equal(config.limits.maxVideoDurationSeconds, 180);
    assert.equal(config.limits.renderMaxShortSide, 1080);
    assert.equal(config.providers.groq.transcriptionModel, 'whisper-large-v3-turbo');
  });

  it('résout les chemins relatifs depuis la racine du projet, quel que soit le dossier courant', () => {
    const config = loadConfig({ DATABASE_PATH: './backend/data/test.sqlite', STORAGE_ROOT: './storage' });

    assert.equal(config.paths.databasePath, path.join(PROJECT_ROOT, 'backend', 'data', 'test.sqlite'));
    assert.equal(config.paths.storageRoot, path.join(PROJECT_ROOT, 'storage'));
  });

  it('traite une valeur vide comme une variable absente', () => {
    const config = loadConfig({ GROQ_API_KEY: '', PORT: '   ' });

    assert.equal(config.providers.groq.apiKey, undefined);
    assert.equal(config.port, 3000);
  });

  it('rejette un port invalide en nommant la variable', () => {
    assert.throws(() => loadConfig({ PORT: 'abc' }), configErrorMatching(/PORT/));
  });

  it('exige les clés des fournisseurs et le modèle en production', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production' }),
      configErrorMatching(/GROQ_API_KEY[\s\S]*OPENROUTER_API_KEY[\s\S]*OPENROUTER_MODEL[\s\S]*PIXABAY_API_KEY/),
    );
  });

  it('accepte une configuration de production complète', () => {
    const config = loadConfig(PRODUCTION_KEYS);

    assert.equal(config.nodeEnv, 'production');
    assert.equal(config.providers.openRouter.model, 'fournisseur/modele-vision');
  });

  it("n'inclut jamais la valeur d'un secret dans le message d'erreur", () => {
    const secret = 'sk-ne-doit-jamais-apparaitre';

    assert.throws(
      () => loadConfig({ GROQ_API_KEY: secret, PORT: '-1', MAX_UPLOAD_MB: 'beaucoup' }),
      (error: unknown) => error instanceof ConfigError && !error.message.includes(secret),
    );
  });

  it('rejette une durée minimale supérieure ou égale à la durée maximale', () => {
    assert.throws(
      () => loadConfig({ MIN_VIDEO_DURATION_SECONDS: '200', MAX_VIDEO_DURATION_SECONDS: '180' }),
      configErrorMatching(/MIN_VIDEO_DURATION_SECONDS/),
    );
  });

  it('accepte une liste d\'origines CORS et rejette une origine avec chemin', () => {
    const config = loadConfig({ FRONTEND_ORIGIN: 'http://localhost:5500, https://alt-broll.web.app' });
    assert.deepEqual(config.frontendOrigins, ['http://localhost:5500', 'https://alt-broll.web.app']);

    assert.throws(
      () => loadConfig({ FRONTEND_ORIGIN: 'https://alt-broll.web.app/app/' }),
      configErrorMatching(/FRONTEND_ORIGIN/),
    );
  });

  it('limite RENDER_MAX_SHORT_SIDE à 720 ou 1080', () => {
    assert.equal(loadConfig({ RENDER_MAX_SHORT_SIDE: '720' }).limits.renderMaxShortSide, 720);
    assert.throws(() => loadConfig({ RENDER_MAX_SHORT_SIDE: '900' }), configErrorMatching(/RENDER_MAX_SHORT_SIDE/));
  });

  it('accepte les fournisseurs simulés en développement mais les refuse en production', () => {
    assert.equal(loadConfig({}).providers.mode, 'live');
    assert.equal(loadConfig({ PROVIDER_MODE: 'mock' }).providers.mode, 'mock');
    assert.throws(() => loadConfig({ ...PRODUCTION_KEYS, PROVIDER_MODE: 'mock' }), configErrorMatching(/PROVIDER_MODE/));
  });

  it('impose le français à la transcription par défaut, ou la détection automatique avec « auto »', () => {
    assert.equal(loadConfig({}).providers.groq.language, 'fr');
    assert.equal(loadConfig({ TRANSCRIPTION_LANGUAGE: 'auto' }).providers.groq.language, null);
    assert.throws(() => loadConfig({ TRANSCRIPTION_LANGUAGE: 'french' }), configErrorMatching(/TRANSCRIPTION_LANGUAGE/));
  });

  it('plafonne les analyses à 50 par 24 h par défaut', () => {
    assert.equal(loadConfig({}).limits.analysesPerDay, 50);
    assert.equal(loadConfig({ MAX_ANALYSES_PER_DAY: '5' }).limits.analysesPerDay, 5);
  });

  it('lit les modèles OpenRouter de secours, facultatifs et séparés par des virgules', () => {
    assert.deepEqual(loadConfig({}).providers.openRouter.fallbackModels, []);
    assert.deepEqual(
      loadConfig({ OPENROUTER_FALLBACK_MODEL: ' vision/secours:free , texte/secours:free,' }).providers.openRouter.fallbackModels,
      ['vision/secours:free', 'texte/secours:free'],
    );
  });

  it('lit TRUST_PROXY et refuse de faire confiance à tous les proxys', () => {
    assert.equal(loadConfig({}).trustProxy, false);
    assert.equal(loadConfig({ TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
    assert.equal(loadConfig({ TRUST_PROXY: '2' }).trustProxy, 2);
    assert.throws(() => loadConfig({ TRUST_PROXY: 'true' }), configErrorMatching(/TRUST_PROXY/));
  });

  it('désactive la connexion par défaut et exige projet Firebase et secret des liens en mode firebase', () => {
    const secret = 'a'.repeat(32);
    assert.deepEqual(loadConfig({}).auth, { mode: 'none' });
    assert.deepEqual(loadConfig({ AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'alt-broll-beta', MEDIA_URL_SECRET: secret }).auth, {
      mode: 'firebase',
      firebaseProjectId: 'alt-broll-beta',
      mediaUrlSecret: secret,
    });
    assert.throws(() => loadConfig({ AUTH_MODE: 'firebase', MEDIA_URL_SECRET: secret }), configErrorMatching(/FIREBASE_PROJECT_ID/));
    assert.throws(() => loadConfig({ AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'Mauvais_ID' }), configErrorMatching(/FIREBASE_PROJECT_ID/));
    assert.throws(
      () => loadConfig({ AUTH_MODE: 'firebase', FIREBASE_PROJECT_ID: 'alt-broll-beta', MEDIA_URL_SECRET: 'court' }),
      configErrorMatching(/MEDIA_URL_SECRET/),
    );
    assert.throws(() => loadConfig({ AUTH_MODE: 'google' }), configErrorMatching(/AUTH_MODE/));
  });

  it('renvoie une configuration figée', () => {
    const config = loadConfig({});

    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.limits));
  });
});
