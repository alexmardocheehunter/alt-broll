import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Transcript } from '../contract.ts';
import { FfmpegUnavailableError, runFfmpeg } from '../media/ffmpeg.ts';
import type { TranscriptionProvider, TranscriptionResult } from '../providers/types.ts';
import { AppError } from '../utils/errors.ts';

const AUDIO_TIMEOUT_MS = 120_000;
/** Limite d'envoi de Groq (25 Mo), avec une marge. Une vidéo de 3 min donne environ 1,5 Mo. */
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const AUDIO_FILE_NAME = 'audio.mp3';

/** Extrait l'audio à transcrire (mono 16 kHz, MP3 64 kbit/s) dans le dossier de travail ; renvoie son chemin. */
export async function prepareAudio(ffmpegPath: string, sourceFile: string, workDir: string): Promise<string> {
  const audioFile = path.join(workDir, AUDIO_FILE_NAME);
  await extractAudio(ffmpegPath, sourceFile, audioFile);
  const { size } = await stat(audioFile);
  if (size > MAX_AUDIO_BYTES) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      stage: 'transcription',
      httpStatus: 422,
      message: 'La piste audio est trop longue pour être transcrite en une seule fois.',
    });
  }
  return audioFile;
}

export interface TranscribeAudioOptions {
  readonly audioFile: string;
  readonly durationSeconds: number;
  readonly language: string | null;
  readonly provider: TranscriptionProvider;
}

/** Transcrit l'audio et normalise le résultat ; une transcription vide est une erreur, jamais inventée. */
export async function transcribeAudio(options: TranscribeAudioOptions): Promise<Transcript> {
  const result = await options.provider.transcribe({
    audioFile: options.audioFile,
    language: options.language,
    durationSeconds: options.durationSeconds,
  });
  const transcript = normalizeTranscript(result, options.durationSeconds);
  if (transcript.text === '') {
    throw new AppError({
      code: 'TRANSCRIPTION_EMPTY',
      stage: 'transcription',
      httpStatus: 422,
      message:
        "Aucune parole n'a été détectée dans la vidéo : ALT B-ROLL a besoin d'un commentaire parlé pour proposer des plans de coupe.",
    });
  }
  return transcript;
}

export async function extractAudio(ffmpegPath: string, sourceFile: string, audioFile: string): Promise<void> {
  try {
    await runFfmpeg(
      ffmpegPath,
      ['-y', '-v', 'error', '-protocol_whitelist', 'file', '-i', sourceFile, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k', audioFile],
      AUDIO_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof FfmpegUnavailableError) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        stage: 'transcription',
        httpStatus: 503,
        retryable: true,
        message: 'Le traitement vidéo est momentanément indisponible sur le serveur. Réessayez plus tard.',
        cause: error,
      });
    }
    throw new AppError({
      code: 'VIDEO_UNREADABLE',
      stage: 'transcription',
      httpStatus: 422,
      message: 'Impossible de lire la piste audio de la vidéo.',
      details: { reason: error instanceof Error ? error.message : String(error) },
    });
  }
}

/** Temps arrondis à la ms et bornés à la durée de la vidéo ; segments et mots vides écartés. */
export function normalizeTranscript(result: TranscriptionResult, durationSeconds: number): Transcript {
  const clampTime = (value: number): number => round3(Math.min(Math.max(value, 0), durationSeconds));
  const segments = result.segments
    .map((segment) => ({
      startSeconds: clampTime(segment.startSeconds),
      endSeconds: clampTime(segment.endSeconds),
      text: collapseSpaces(segment.text),
    }))
    .filter((segment) => segment.text !== '' && segment.endSeconds > segment.startSeconds);
  const words = result.words
    .map((word) => ({
      startSeconds: clampTime(word.startSeconds),
      endSeconds: clampTime(word.endSeconds),
      word: word.word.trim(),
    }))
    .filter((word) => word.word !== '' && word.endSeconds >= word.startSeconds);

  return {
    provider: result.provider,
    model: result.model,
    language: result.language,
    text: collapseSpaces(result.text) || segments.map((segment) => segment.text).join(' '),
    segments,
    words,
  };
}

function collapseSpaces(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
