import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Transcript } from '../src/contract.ts';
import type { ContentAnalysisProvider, ContentAnalysisRequest } from '../src/providers/types.ts';
import { AppError } from '../src/utils/errors.ts';
import {
  analyzeContent,
  buildAnalysisPrompt,
  cleanQuery,
  normalizeSuggestions,
  targetSuggestionCount,
} from '../src/services/vision-analysis.service.ts';
import { silentLogger } from './helpers.ts';

const transcript: Transcript = {
  provider: 'groq',
  model: 'whisper-large-v3-turbo',
  language: 'fr',
  text: 'Bonjour. Je vends des mangues au marché.',
  segments: [
    { startSeconds: 0, endSeconds: 2.5, text: 'Bonjour.' },
    { startSeconds: 2.5, endSeconds: 7.25, text: 'Je vends des mangues au marché.' },
  ],
  words: [],
};

function suggestion(startSeconds: number, endSeconds: number, searchQuery = 'market', reason = 'raison') {
  return { startSeconds, endSeconds, reason, searchQuery };
}

describe('normalizeSuggestions', () => {
  it('borne les temps à la vidéo, inverse un intervalle à l’envers et arrondit à la milliseconde', () => {
    const result = normalizeSuggestions([suggestion(25, 22.12345), suggestion(-3, 2)], 28);

    assert.deepEqual(
      result.map((s) => [s.startSeconds, s.endSeconds]),
      [
        [0, 2],
        [22.123, 25],
      ],
    );
  });

  it('applique les durées du contrat : 1 s au minimum, 10 s au maximum', () => {
    const result = normalizeSuggestions([suggestion(2, 2.2), suggestion(10, 40)], 60);

    assert.deepEqual(
      result.map((s) => [s.startSeconds, s.endSeconds]),
      [
        [2, 3],
        [10, 20],
      ],
    );
  });

  it('écarte les valeurs invalides et les requêtes vides', () => {
    const result = normalizeSuggestions(
      [suggestion(Number.NaN, 3), suggestion(1, 3, '¿¡!'), suggestion(4, 6, 'beach')],
      30,
    );

    assert.deepEqual(result.map((s) => s.searchQuery), ['beach']);
  });

  it('supprime les chevauchements : début décalé si assez de durée, sinon suggestion écartée', () => {
    const result = normalizeSuggestions([suggestion(1, 4), suggestion(3, 7), suggestion(6.5, 7.2)], 30);

    assert.deepEqual(
      result.map((s) => [s.startSeconds, s.endSeconds]),
      [
        [1, 4],
        [4, 7],
      ],
    );
  });

  it('garde au plus 8 B-rolls, dans l’ordre chronologique', () => {
    const many = Array.from({ length: 12 }, (_, i) => suggestion(100 - i * 5, 102 - i * 5));

    const result = normalizeSuggestions(many, 120);

    assert.equal(result.length, 8);
    assert.ok(result.every((s, i, all) => i === 0 || s.startSeconds >= (all[i - 1]?.endSeconds ?? 0)));
  });

  it('nettoie la requête et la raison', () => {
    const [result] = normalizeSuggestions([suggestion(1, 3, '  Marché Coloré, AFRIQUE!!  ', '  Elle\nparle  du marché. ')], 10);

    assert.equal(result?.searchQuery, 'marche colore afrique');
    assert.equal(result?.reason, 'Elle parle du marché.');
  });
});

describe('cleanQuery', () => {
  it('limite à cinq mots en minuscules, sans accent ni ponctuation', () => {
    assert.equal(cleanQuery('Fresh, Juicy MANGOES on a wooden Table today'), 'fresh juicy mangoes on a');
    assert.equal(cleanQuery('café-terrasse'), 'cafe-terrasse');
  });
});

describe('buildAnalysisPrompt', () => {
  it('donne la durée, le nombre visé, la transcription horodatée et les instants des images', () => {
    const prompt = buildAnalysisPrompt({
      durationSeconds: 60,
      transcript,
      keyframes: [
        { index: 0, timeSeconds: 2.5 },
        { index: 1, timeSeconds: 7.5 },
      ],
      withImage: true,
    });

    assert.match(prompt.system, /about 3 B-rolls, never more than 8/);
    assert.match(prompt.system, /reason: one short sentence in French/);
    assert.match(prompt.user, /Video duration: 60\.0 seconds\./);
    assert.match(prompt.user, /\[2\.5-7\.3\] Je vends des mangues au marché\./);
    assert.match(prompt.user, /#1=2\.5s, #2=7\.5s/);
  });

  it("indique au modèle qu'aucune image n'est fournie", () => {
    const prompt = buildAnalysisPrompt({ durationSeconds: 30, transcript, keyframes: [], withImage: false });

    assert.match(prompt.user, /No image is available/);
  });

  it('vise environ un B-roll toutes les 20 secondes, entre 1 et 8', () => {
    assert.deepEqual([5, 30, 60, 180, 600].map(targetSuggestionCount), [1, 2, 3, 8, 8]);
  });
});

describe('analyzeContent', () => {
  function provider(behaviour: (request: ContentAnalysisRequest) => Promise<void>): ContentAnalysisProvider & {
    calls: ContentAnalysisRequest[];
  } {
    const calls: ContentAnalysisRequest[] = [];
    return {
      calls,
      analyze: async (request) => {
        calls.push(request);
        await behaviour(request);
        return { model: 'm', visualAnalysisUsed: request.contactSheet !== null, summary: '', suggestions: [] };
      },
    };
  }
  const options = { transcript, durationSeconds: 10, keyframes: [], contactSheet: Buffer.from('jpeg'), logger: silentLogger };

  it("réessaie sans l'image quand l'appel avec image échoue", async () => {
    const fake = provider(async (request) => {
      if (request.contactSheet !== null) throw new Error('image refusée');
    });

    const result = await analyzeContent({ ...options, provider: fake });

    assert.equal(fake.calls.length, 2);
    assert.equal(result.visualAnalysisUsed, false);
  });

  it('ne réessaie pas quand le quota est atteint', async () => {
    const fake = provider(async () => {
      throw new AppError({ code: 'PROVIDER_RATE_LIMITED', stage: 'analysis', httpStatus: 502, message: 'quota' });
    });

    await assert.rejects(analyzeContent({ ...options, provider: fake }), /quota/);
    assert.equal(fake.calls.length, 1);
  });
});
