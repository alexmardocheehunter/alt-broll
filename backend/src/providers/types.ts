import type { BrollCandidate, TranscriptSegment, TranscriptWord, TranscriptionProviderName } from '../contract.ts';

/** fetch injectable : les tests remplacent le réseau, jamais d'appel réel aux API. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TranscriptionRequest {
  /** Fichier audio mono 16 kHz préparé par le backend. */
  readonly audioFile: string;
  /** Langue imposée (ISO 639-1), ou null pour la détection automatique. */
  readonly language: string | null;
  readonly durationSeconds: number;
}

export interface TranscriptionResult {
  readonly provider: TranscriptionProviderName;
  readonly model: string;
  readonly language: string;
  readonly text: string;
  readonly segments: readonly TranscriptSegment[];
  readonly words: readonly TranscriptWord[];
}

export interface TranscriptionProvider {
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface AnalysisPrompt {
  readonly system: string;
  readonly user: string;
}

/** Suggestion brute du modèle, avant normalisation (bornes, chevauchements, limites). */
export interface RawSuggestion {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly reason: string;
  readonly searchQuery: string;
}

export interface ContentAnalysisRequest {
  readonly prompt: AnalysisPrompt;
  /** Planche contact JPEG, ou null : analyse sur le texte seul. */
  readonly contactSheet: Buffer | null;
  readonly durationSeconds: number;
  readonly transcriptSegments: readonly TranscriptSegment[];
}

export interface ContentAnalysisResult {
  /** Modèle qui a réellement répondu. */
  readonly model: string;
  /** true seulement si l'image a été envoyée ET traitée par un modèle qui accepte les images. */
  readonly visualAnalysisUsed: boolean;
  readonly summary: string;
  readonly suggestions: readonly RawSuggestion[];
}

export interface ContentAnalysisProvider {
  analyze(request: ContentAnalysisRequest): Promise<ContentAnalysisResult>;
}

export type BrollOrientation = 'landscape' | 'portrait';

export interface BrollSearchRequest {
  /** Mots-clés en anglais. */
  readonly query: string;
  /** Durée du segment à couvrir : les médias plus longs sont préférés. */
  readonly minDurationSeconds: number;
  readonly orientation: BrollOrientation;
  readonly limit: number;
  /** Plus grand côté de l'export : la version téléchargée vise cette taille (pas plus lourde que nécessaire). */
  readonly targetLongSide: number;
}

/** Candidat sans identifiant : le service d'analyse attribue les id. */
export type BrollCandidateDraft = Omit<BrollCandidate, 'id'>;

export interface BrollSearchProvider {
  search(request: BrollSearchRequest): Promise<BrollCandidateDraft[]>;
}

/** Les trois services de l'analyse : réels (Groq, OpenRouter, Pixabay) ou simulés (tests). */
export interface AnalysisProviders {
  readonly transcription: TranscriptionProvider;
  readonly analysis: ContentAnalysisProvider;
  readonly brollSearch: BrollSearchProvider;
}
