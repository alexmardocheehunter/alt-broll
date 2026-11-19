import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseGroqTranscription } from '../src/providers/groq.provider.ts';
import { callProvider } from '../src/providers/http.ts';
import { createOpenRouterAnalysisProvider, parseOpenRouterCompletion } from '../src/providers/openrouter.provider.ts';
import {
  createPixabaySearchProvider,
  isPixabayUrl,
  rankPixabayHits,
  toCandidateDraft,
  type PixabayHit,
} from '../src/providers/pixabay.provider.ts';
import type { FetchLike } from '../src/providers/types.ts';
import { AppError } from '../src/utils/errors.ts';

const noSleep = async (): Promise<void> => {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function sequence(...responses: Array<Response | Error>): FetchLike & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fake = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    const next = responses.shift();
    if (next === undefined) throw new Error('appel réseau inattendu');
    if (next instanceof Error) throw next;
    return next;
  };
  return Object.assign(fake, { calls });
}

function appErrorWith(code: string, retryable?: boolean) {
  return (error: unknown): boolean =>
    error instanceof AppError && error.code === code && (retryable === undefined || error.retryable === retryable);
}

describe('callProvider', () => {
  const options = { provider: 'Groq' as const, stage: 'transcription' as const, timeoutMs: 1_000, sleep: noSleep };

  it('réessaie une fois après une panne 503', async () => {
    const fetch = sequence(new Response('panne', { status: 503 }), json({ ok: true }));

    const response = await callProvider('https://api.test/x', {}, { ...options, fetch });

    assert.equal(response.status, 200);
    assert.equal(fetch.calls.length, 2);
  });

  it('traduit un quota dépassé en PROVIDER_RATE_LIMITED, réessayable', async () => {
    const fetch = sequence(new Response('', { status: 429 }), new Response('', { status: 429 }));

    await assert.rejects(callProvider('https://api.test/x', {}, { ...options, fetch }), appErrorWith('PROVIDER_RATE_LIMITED', true));
  });

  it('traduit une clé refusée en PROVIDER_NOT_CONFIGURED, sans nouvelle tentative', async () => {
    const fetch = sequence(new Response('{"error":"invalid api key"}', { status: 401 }));

    await assert.rejects(callProvider('https://api.test/x', {}, { ...options, fetch }), appErrorWith('PROVIDER_NOT_CONFIGURED', false));
    assert.equal(fetch.calls.length, 1);
  });

  it('distingue le dépassement de délai de la panne réseau', async () => {
    const timeout = Object.assign(new Error('délai'), { name: 'TimeoutError' });

    await assert.rejects(
      callProvider('https://api.test/x', {}, { ...options, fetch: sequence(timeout, timeout) }),
      appErrorWith('PROVIDER_TIMEOUT'),
    );
    await assert.rejects(
      callProvider('https://api.test/x', {}, { ...options, fetch: sequence(new TypeError('fetch failed'), new TypeError('fetch failed')) }),
      appErrorWith('PROVIDER_UNAVAILABLE'),
    );
  });
});

describe('Groq', () => {
  it('convertit verbose_json et écarte les segments « sans parole » et leurs mots', () => {
    const result = parseGroqTranscription(
      {
        text: 'Bonjour à tous. Sous-titres réalisés par la communauté.',
        language: 'French',
        segments: [
          { start: 0, end: 2, text: ' Bonjour à tous.', no_speech_prob: 0.01 },
          { start: 2, end: 5, text: ' Sous-titres réalisés par la communauté.', no_speech_prob: 0.97 },
        ],
        words: [
          { word: 'Bonjour', start: 0.1, end: 0.6 },
          { word: 'Sous-titres', start: 2.2, end: 2.9 },
        ],
      },
      'whisper-large-v3-turbo',
      null,
    );

    assert.equal(result.provider, 'groq');
    assert.equal(result.language, 'fr');
    assert.equal(result.text, 'Bonjour à tous.');
    assert.deepEqual(result.segments, [{ startSeconds: 0, endSeconds: 2, text: 'Bonjour à tous.' }]);
    assert.deepEqual(result.words.map((word) => word.word), ['Bonjour']);
  });

  it('signale une réponse inattendue par PROVIDER_INVALID_RESPONSE', () => {
    assert.throws(() => parseGroqTranscription({ segments: 'non' }, 'm', 'fr'), appErrorWith('PROVIDER_INVALID_RESPONSE'));
  });
});

describe('OpenRouter', () => {
  const plan = { summary: 'Résumé.', suggestions: [{ startSeconds: 1, endSeconds: 3, reason: 'r', searchQuery: 'q' }] };
  const completion = (content: string, model = 'anthropic/claude-haiku-5.5') => ({ model, choices: [{ message: { content } }] });
  const modelList = (ids: string[]) => json({ data: ids.map((id) => ({ id, architecture: { input_modalities: ['text', 'image'] } })) });
  const request = { prompt: { system: 's', user: 'u' }, contactSheet: Buffer.from('jpeg'), durationSeconds: 10, transcriptSegments: [] };

  it('lit le plan JSON, même entouré de balises ```json', () => {
    const result = parseOpenRouterCompletion(completion('```json\n' + JSON.stringify(plan) + '\n```'), {
      imageSent: true,
      requestedModel: 'x',
    });

    assert.equal(result.model, 'anthropic/claude-haiku-5.5');
    assert.equal(result.visualAnalysisUsed, true);
    assert.equal(result.suggestions.length, 1);
  });

  it('refuse une réponse vide, une erreur ou un JSON hors schéma', () => {
    const parse = (raw: unknown) => parseOpenRouterCompletion(raw, { imageSent: false, requestedModel: 'x' });

    assert.throws(() => parse(completion('')), appErrorWith('PROVIDER_INVALID_RESPONSE'));
    assert.throws(() => parse({ error: { message: 'oups' } }), appErrorWith('PROVIDER_INVALID_RESPONSE'));
    assert.throws(() => parse(completion('{"summary":1}')), appErrorWith('PROVIDER_INVALID_RESPONSE'));
  });

  it("envoie l'image, le schéma JSON et le modèle de secours quand les deux modèles acceptent les images", async () => {
    const fetch = sequence(modelList(['anthropic/claude-haiku-5.5', 'google/gemini-3.8-flash']), json(completion(JSON.stringify(plan))));
    const provider = createOpenRouterAnalysisProvider({
      apiKey: 'cle-test',
      model: 'anthropic/claude-haiku-5.5',
      fallbackModels: ['google/gemini-3.8-flash'],
      fetch,
      sleep: noSleep,
    });

    const result = await provider.analyze(request);
    const body = JSON.parse(String(fetch.calls[1]?.init?.body)) as Record<string, unknown>;

    assert.equal(result.visualAnalysisUsed, true);
    assert.deepEqual(body.models, ['anthropic/claude-haiku-5.5', 'google/gemini-3.8-flash']);
    assert.match(JSON.stringify(body.messages), /data:image\/jpeg;base64,/);
    assert.equal((body.response_format as { type: string }).type, 'json_schema');
    assert.deepEqual(body.provider, { require_parameters: true });
  });

  it("ignore un modèle disparu et réserve l'image aux modèles qui l'acceptent", async () => {
    const catalog = json({
      data: [
        { id: 'gratuit/vision:free', architecture: { input_modalities: ['text', 'image'] } },
        { id: 'gratuit/texte:free', architecture: { input_modalities: ['text'] } },
      ],
    });
    const fetch = sequence(catalog, json(completion(JSON.stringify(plan), 'gratuit/vision:free')), json(completion(JSON.stringify(plan), 'gratuit/vision:free')));
    const provider = createOpenRouterAnalysisProvider({
      apiKey: 'cle-test',
      model: 'gratuit/vision:free',
      fallbackModels: ['gratuit/disparu:free', 'gratuit/texte:free'],
      fetch,
      sleep: noSleep,
    });

    await provider.analyze(request);
    await provider.analyze({ ...request, contactSheet: null });
    const withImage = JSON.parse(String(fetch.calls[1]?.init?.body)) as Record<string, unknown>;
    const textOnly = JSON.parse(String(fetch.calls[2]?.init?.body)) as Record<string, unknown>;

    assert.equal(withImage.model, 'gratuit/vision:free', 'image confiée au seul modèle vision');
    assert.deepEqual(textOnly.models, ['gratuit/vision:free', 'gratuit/texte:free'], 'modèle disparu écarté');
    assert.equal(fetch.calls.length, 3, 'liste des modèles gardée en cache');
  });

  it("ne redemande pas une liste des modèles indisponible à chaque analyse, et la charge en avance", async () => {
    const answer = () => json(completion(JSON.stringify(plan), 'gratuit/vision:free'));
    const fetch = sequence(new TypeError('liste inaccessible'), answer(), answer());
    const provider = createOpenRouterAnalysisProvider({
      apiKey: 'cle-test',
      model: 'gratuit/vision:free',
      fetch,
      sleep: noSleep,
      prefetchModelList: true,
    });

    await provider.analyze(request);
    await provider.analyze(request);

    assert.equal(fetch.calls.length, 3, '1 liste (échec mémorisé) + 2 analyses');
    assert.match(fetch.calls[0]?.url ?? '', /\/models$/, 'liste chargée dès la création');
  });

  it("annonce un quota gratuit du jour épuisé plutôt qu'une saturation passagère", async () => {
    const quota = () => new Response('{"error":{"message":"Rate limit exceeded: free-models-per-day"}}', { status: 429 });
    const fetch = sequence(new TypeError('liste inaccessible'), quota(), quota());
    const provider = createOpenRouterAnalysisProvider({ apiKey: 'cle-test', model: 'gratuit/vision:free', fetch, sleep: noSleep });

    await assert.rejects(provider.analyze(request), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'PROVIDER_RATE_LIMITED');
      assert.match(error.message, /quota gratuit du jour.*Réessayez demain/);
      return true;
    });
  });

  it("n'envoie pas l'image et ne prétend pas l'avoir analysée si aucun modèle n'accepte les images", async () => {
    const fetch = sequence(modelList(['autre/modele']), json(completion(JSON.stringify(plan), 'texte/seul')));
    const provider = createOpenRouterAnalysisProvider({ apiKey: 'cle-test', model: 'texte/seul', fetch, sleep: noSleep });

    const result = await provider.analyze(request);
    const body = JSON.parse(String(fetch.calls[1]?.init?.body)) as Record<string, unknown>;

    assert.equal(result.visualAnalysisUsed, false);
    assert.doesNotMatch(JSON.stringify(body.messages), /image_url/);
    assert.equal(body.model, 'texte/seul');
  });
});

describe('Pixabay', () => {
  const hit = (id: number, overrides: Partial<PixabayHit> = {}): PixabayHit => ({
    id,
    pageURL: `https://pixabay.com/videos/clip-${id}/`,
    tags: 'market, street',
    duration: 15,
    user: 'Auteur',
    videos: {
      large: { url: `https://cdn.pixabay.com/video/${id}_large.mp4`, width: 3840, height: 2160 },
      medium: { url: `https://cdn.pixabay.com/video/${id}_medium.mp4`, width: 1920, height: 1080, thumbnail: `https://cdn.pixabay.com/video/${id}.jpg` },
      small: { url: `https://cdn.pixabay.com/video/${id}_small.mp4`, width: 1280, height: 720 },
      tiny: { url: `https://cdn.pixabay.com/video/${id}_tiny.mp4`, width: 640, height: 360 },
    },
    ...overrides,
  });

  it('choisit une preview légère, la meilleure version ≤ 1080p pour l’export, et cite l’auteur', () => {
    const draft = toCandidateDraft(hit(7));

    assert.ok(draft);
    assert.equal(draft.previewUrl, 'https://cdn.pixabay.com/video/7_tiny.mp4');
    assert.equal(draft.downloadUrl, 'https://cdn.pixabay.com/video/7_medium.mp4');
    assert.deepEqual([draft.width, draft.height], [1920, 1080]);
    assert.equal(draft.thumbnailUrl, 'https://cdn.pixabay.com/video/7.jpg');
    assert.equal(draft.attribution, 'Vidéo de Auteur sur Pixabay');
  });

  it("télécharge la version la plus légère qui atteint la taille de l'export", () => {
    const at = (target: number, videos?: PixabayHit['videos']) =>
      toCandidateDraft(videos === undefined ? hit(9) : hit(9, { videos }), target)?.downloadUrl;

    assert.equal(at(1280), 'https://cdn.pixabay.com/video/9_small.mp4', 'export 720p : version 1280×720');
    assert.equal(at(1000), 'https://cdn.pixabay.com/video/9_small.mp4');
    assert.equal(at(1920), 'https://cdn.pixabay.com/video/9_medium.mp4', 'export 1080p : version 1920×1080');
    assert.equal(at(4000), 'https://cdn.pixabay.com/video/9_medium.mp4', 'jamais au-delà du 1080p');
    const onlySmall = { tiny: { url: 'https://cdn.pixabay.com/video/9_tiny.mp4', width: 640, height: 360 } };
    assert.equal(at(1920, onlySmall), 'https://cdn.pixabay.com/video/9_tiny.mp4', 'à défaut, la plus grande disponible');
    const only4k = { large: { url: 'https://cdn.pixabay.com/video/9_large.mp4', width: 3840, height: 2160 } };
    assert.equal(at(1280, only4k), 'https://cdn.pixabay.com/video/9_large.mp4', 'seule version proposée');
  });

  it('écarte les médias hors des domaines pixabay.com', () => {
    assert.equal(toCandidateDraft(hit(8, { pageURL: 'https://evil.example/8' })), null);
    assert.equal(isPixabayUrl('http://cdn.pixabay.com/x.mp4'), false);
    assert.equal(isPixabayUrl('https://cdn.pixabay.com.evil.example/x.mp4'), false);
    assert.equal(isPixabayUrl('https://cdn.pixabay.com/x.mp4'), true);
  });

  it("préfère l'orientation de la source puis une durée suffisante, et limite à 4 candidats", () => {
    const portrait = hit(2, {
      videos: { medium: { url: 'https://cdn.pixabay.com/video/2.mp4', width: 1080, height: 1920 } },
    });
    const tooShort = hit(3, { duration: 2 });
    const ranked = rankPixabayHits([hit(1), portrait, tooShort, hit(4), hit(5), hit(6)], {
      minDurationSeconds: 4,
      orientation: 'portrait',
      limit: 4,
      targetLongSide: 1920,
    });

    assert.deepEqual(ranked.map((draft) => draft.providerMediaId), ['2', '1', '4', '5']);
  });

  it('garde les réponses en cache (exigence Pixabay) et signale une clé invalide', async () => {
    const fetch = sequence(json({ hits: [hit(1)] }));
    const provider = createPixabaySearchProvider({ apiKey: 'cle-test', fetch, sleep: noSleep });
    const request = { query: 'market', minDurationSeconds: 3, orientation: 'landscape' as const, limit: 4, targetLongSide: 1920 };

    await provider.search(request);
    await provider.search(request);

    assert.equal(fetch.calls.length, 1);
    assert.match(fetch.calls[0]?.url ?? '', /q=market/);

    const refused = createPixabaySearchProvider({
      apiKey: 'mauvaise',
      fetch: sequence(new Response('[ERROR 400] Invalid or missing API key', { status: 400 })),
      sleep: noSleep,
    });
    await assert.rejects(refused.search(request), appErrorWith('PROVIDER_NOT_CONFIGURED'));
  });
});
