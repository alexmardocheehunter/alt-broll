import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { TranscriptSegment } from '../contract.ts';
import { callProvider, invalidProviderResponse, readJsonBody } from './http.ts';
import type { FetchLike, TranscriptionProvider, TranscriptionResult } from './types.ts';

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_TIMEOUT_MS = 120_000;

/** Au-delà, un segment est presque toujours une « hallucination » de Whisper sur un silence ou de la musique. */
const MAX_NO_SPEECH_PROBABILITY = 0.9;

/** Whisper renvoie parfois le nom de la langue plutôt que son code. */
const LANGUAGE_CODES: Readonly<Record<string, string>> = {
  french: 'fr',
  english: 'en',
  spanish: 'es',
  german: 'de',
  italian: 'it',
  portuguese: 'pt',
  arabic: 'ar',
  dutch: 'nl',
};

const responseSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
  segments: z
    .array(z.object({ start: z.number(), end: z.number(), text: z.string(), no_speech_prob: z.number().optional() }))
    .default([]),
  words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })).default([]),
});

export interface GroqProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Transcription Groq Whisper (verbose_json, horodatage par segment et par mot). */
export function createGroqTranscriptionProvider({
  apiKey,
  model,
  fetch = globalThis.fetch,
  sleep,
}: GroqProviderOptions): TranscriptionProvider {
  return {
    async transcribe({ audioFile, language }) {
      const audio = await readFile(audioFile);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), 'audio.mp3');
      form.append('model', model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
      form.append('timestamp_granularities[]', 'word');
      form.append('temperature', '0');
      if (language !== null) form.append('language', language);

      const response = await callProvider(
        GROQ_TRANSCRIPTION_URL,
        { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form },
        { provider: 'Groq', stage: 'transcription', timeoutMs: GROQ_TIMEOUT_MS, fetch, sleep },
      );
      return parseGroqTranscription(await readJsonBody(response, 'Groq', 'transcription'), model, language);
    },
  };
}

/** Réponse verbose_json → résultat du contrat ; segments « sans parole » et leurs mots écartés. */
export function parseGroqTranscription(
  raw: unknown,
  model: string,
  requestedLanguage: string | null,
): TranscriptionResult {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw invalidProviderResponse('Groq', 'transcription', parsed.error.message);
  const { text, language, segments, words } = parsed.data;

  const kept: TranscriptSegment[] = segments
    .filter((segment) => (segment.no_speech_prob ?? 0) < MAX_NO_SPEECH_PROBABILITY)
    .map((segment) => ({ startSeconds: segment.start, endSeconds: segment.end, text: segment.text.trim() }));
  const keptWords = words
    .map((word) => ({ startSeconds: word.start, endSeconds: word.end, word: word.word.trim() }))
    .filter((word) => {
      const middle = (word.startSeconds + word.endSeconds) / 2;
      return kept.some((segment) => middle >= segment.startSeconds && middle <= segment.endSeconds);
    });

  return {
    provider: 'groq',
    model,
    language: requestedLanguage ?? toLanguageCode(language),
    text: segments.length > 0 ? kept.map((segment) => segment.text).join(' ').trim() : text.trim(),
    segments: kept,
    words: keptWords,
  };
}

function toLanguageCode(value: string | undefined): string {
  const lower = value?.trim().toLowerCase() ?? '';
  if (/^[a-z]{2}$/.test(lower)) return lower;
  return LANGUAGE_CODES[lower] ?? 'fr';
}
