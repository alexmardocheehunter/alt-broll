import { TIMELINE_RULES, type Keyframe, type Transcript } from '../contract.ts';
import type { AnalysisPrompt, ContentAnalysisProvider, ContentAnalysisResult, RawSuggestion } from '../providers/types.ts';
import { AppError } from '../utils/errors.ts';
import type { Logger } from '../utils/logger.ts';

const MAX_REASON_LENGTH = 240;
const MAX_QUERY_WORDS = 5;
const MAX_QUERY_LENGTH = 80;
const DEFAULT_REASON = 'Illustre le propos à ce moment de la vidéo.';
/** Environ un B-roll toutes les 20 secondes de vidéo. */
const SECONDS_PER_SUGGESTION = 20;

export interface NormalizedSuggestion {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly reason: string;
  readonly searchQuery: string;
}

export interface PromptContext {
  readonly durationSeconds: number;
  readonly transcript: Transcript;
  readonly keyframes: readonly Keyframe[];
  readonly withImage: boolean;
}

export function targetSuggestionCount(durationSeconds: number): number {
  return Math.min(TIMELINE_RULES.maxBrollItems, Math.max(1, Math.round(durationSeconds / SECONDS_PER_SUGGESTION)));
}

/** Consignes au modèle : règles de montage du contrat, transcription horodatée, planche contact. */
export function buildAnalysisPrompt({ durationSeconds, transcript, keyframes, withImage }: PromptContext): AnalysisPrompt {
  const { minSegmentSeconds, maxSegmentSeconds, maxBrollItems } = TIMELINE_RULES;
  const duration = durationSeconds.toFixed(1);
  const system = [
    'You are a video editor assistant. You choose the moments of a spoken video that would benefit from a B-roll: a generic stock shot displayed over the original audio.',
    'Rules:',
    `- Propose about ${targetSuggestionCount(durationSeconds)} B-rolls, never more than ${maxBrollItems}. Quality matters more than quantity.`,
    `- Each B-roll lasts between ${minSegmentSeconds} and ${maxSegmentSeconds} seconds (ideally 3 to 5), lies within [0, ${duration}] seconds and never overlaps another B-roll.`,
    '- Place a B-roll where the speaker mentions something concrete and visual: a place, an object, an action, a situation.',
    '- Avoid the first 2 seconds, moments where the speaker shows or points at something on screen, and emotional moments where the face matters.',
    '- searchQuery: 2 to 4 English keywords describing generic stock footage available on a free video bank. No person names, no brands, no on-screen text.',
    '- reason: one short sentence in French explaining why a B-roll helps at this moment.',
    '- summary: one sentence in French summarizing the video.',
    'Answer only with the JSON object described by the provided schema.',
  ].join('\n');

  const transcriptLines = transcript.segments.map(
    (segment) => `[${segment.startSeconds.toFixed(1)}-${segment.endSeconds.toFixed(1)}] ${segment.text}`,
  );
  const visual = withImage
    ? `Attached image: contact sheet of ${keyframes.length} frames, read left to right then top to bottom; each frame shows its time in seconds. Frame times: ${keyframes.map((frame) => `#${frame.index + 1}=${frame.timeSeconds.toFixed(1)}s`).join(', ')}. Use it to see what is already on screen.`
    : 'No image is available: rely on the transcript only.';
  const user = [
    `Video duration: ${duration} seconds.`,
    `Transcript (language: ${transcript.language}), one line per segment, start-end in seconds:`,
    ...(transcriptLines.length > 0 ? transcriptLines : [transcript.text]),
    visual,
  ].join('\n');

  return { system, user };
}

export interface AnalyzeContentOptions {
  readonly provider: ContentAnalysisProvider;
  readonly transcript: Transcript;
  readonly durationSeconds: number;
  readonly keyframes: readonly Keyframe[];
  readonly contactSheet: Buffer | null;
  readonly logger: Logger;
}

/** Analyse avec la planche contact ; si l'appel avec image échoue, nouvel essai sur le texte seul. */
export async function analyzeContent(options: AnalyzeContentOptions): Promise<ContentAnalysisResult> {
  const { provider, transcript, durationSeconds, keyframes, contactSheet, logger } = options;
  const request = (withImage: boolean) => ({
    prompt: buildAnalysisPrompt({ durationSeconds, transcript, keyframes, withImage }),
    contactSheet: withImage ? contactSheet : null,
    durationSeconds,
    transcriptSegments: transcript.segments,
  });

  if (contactSheet === null) return provider.analyze(request(false));
  try {
    return await provider.analyze(request(true));
  } catch (error) {
    // Clé refusée ou quota atteint : réessayer sans image ne changerait rien.
    if (error instanceof AppError && (error.code === 'PROVIDER_NOT_CONFIGURED' || error.code === 'PROVIDER_RATE_LIMITED')) {
      throw error;
    }
    logger.warn('analysis.vision_failed_text_fallback', { err: error });
    return provider.analyze(request(false));
  }
}

/**
 * Rend les suggestions du modèle conformes au contrat : bornes de la vidéo, durées
 * TIMELINE_RULES, temps à la ms, tri, aucun chevauchement, au plus maxBrollItems.
 */
export function normalizeSuggestions(raw: readonly RawSuggestion[], durationSeconds: number): NormalizedSuggestion[] {
  const { minSegmentSeconds, maxSegmentSeconds, maxBrollItems } = TIMELINE_RULES;

  const bounded = raw
    .flatMap((suggestion): NormalizedSuggestion[] => {
      const searchQuery = cleanQuery(suggestion.searchQuery);
      if (!Number.isFinite(suggestion.startSeconds) || !Number.isFinite(suggestion.endSeconds) || searchQuery === '') {
        return [];
      }
      let start = clamp(suggestion.startSeconds, 0, durationSeconds);
      let end = clamp(suggestion.endSeconds, 0, durationSeconds);
      if (end < start) [start, end] = [end, start];
      end = Math.min(end, start + maxSegmentSeconds);
      if (end - start < minSegmentSeconds) {
        end = Math.min(durationSeconds, start + minSegmentSeconds);
        start = Math.max(0, end - minSegmentSeconds);
      }
      if (end - start < minSegmentSeconds - 1e-9) return [];
      return [
        {
          startSeconds: round3(start),
          endSeconds: round3(end),
          reason: cleanText(suggestion.reason, MAX_REASON_LENGTH) || DEFAULT_REASON,
          searchQuery,
        },
      ];
    })
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const kept: NormalizedSuggestion[] = [];
  for (const suggestion of bounded) {
    if (kept.length === maxBrollItems) break;
    const previous = kept.at(-1);
    if (previous === undefined || suggestion.startSeconds >= previous.endSeconds) {
      kept.push(suggestion);
    } else if (suggestion.endSeconds - previous.endSeconds >= minSegmentSeconds) {
      // Chevauchement : le B-roll commence à la fin du précédent s'il lui reste assez de durée.
      kept.push({ ...suggestion, startSeconds: previous.endSeconds });
    }
  }
  return kept;
}

/** Mots-clés de recherche : minuscules, sans accent ni ponctuation, 5 mots au plus. */
export function cleanQuery(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, MAX_QUERY_WORDS)
    .join(' ')
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
}

function cleanText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
