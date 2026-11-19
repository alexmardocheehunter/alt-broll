import { randomBytes } from 'node:crypto';
import { TIMELINE_RULES, type BrollItem, type SourceVideo } from '../contract.ts';
import type { BrollCandidateDraft, BrollOrientation, BrollSearchProvider } from '../providers/types.ts';
import type { Logger } from '../utils/logger.ts';
import type { NormalizedSuggestion } from './vision-analysis.service.ts';

/** Sans résultat, nouvel essai avec les deux premiers mots-clés seulement. */
const FALLBACK_QUERY_WORDS = 2;

/**
 * Cherche jusqu'à 4 candidats par suggestion et construit les B-rolls (sélection : le premier
 * candidat). `targetLongSide` : grand côté de l'export, taille visée des vidéos téléchargées.
 */
export async function buildBrollItems(
  suggestions: readonly NormalizedSuggestion[],
  source: SourceVideo,
  provider: BrollSearchProvider,
  logger: Logger,
  targetLongSide: number,
): Promise<BrollItem[]> {
  const orientation: BrollOrientation = source.height > source.width ? 'portrait' : 'landscape';
  const items: BrollItem[] = [];
  let failures = 0;
  let lastError: unknown = null;

  for (const suggestion of suggestions) {
    let drafts: BrollCandidateDraft[] = [];
    try {
      drafts = await searchWithFallback(provider, suggestion, orientation, targetLongSide);
    } catch (error) {
      failures += 1;
      lastError = error;
      logger.warn('broll_search.failed', { query: suggestion.searchQuery, err: error });
    }
    items.push(toBrollItem(suggestion, drafts));
  }

  // Recherche impossible partout (clé refusée, service en panne) : l'analyse échoue
  // plutôt que de livrer des suggestions toutes vides.
  if (suggestions.length > 0 && failures === suggestions.length) throw lastError;
  return items;
}

async function searchWithFallback(
  provider: BrollSearchProvider,
  suggestion: NormalizedSuggestion,
  orientation: BrollOrientation,
  targetLongSide: number,
): Promise<BrollCandidateDraft[]> {
  const request = {
    query: suggestion.searchQuery,
    minDurationSeconds: suggestion.endSeconds - suggestion.startSeconds,
    orientation,
    limit: TIMELINE_RULES.maxCandidatesPerItem,
    targetLongSide,
  };
  const results = await provider.search(request);
  const words = suggestion.searchQuery.split(' ');
  if (results.length > 0 || words.length <= FALLBACK_QUERY_WORDS) return results;
  return provider.search({ ...request, query: words.slice(0, FALLBACK_QUERY_WORDS).join(' ') });
}

/** B-roll suggéré, actif, en « cover », avec le premier candidat sélectionné. */
export function toBrollItem(suggestion: NormalizedSuggestion, drafts: readonly BrollCandidateDraft[]): BrollItem {
  const candidates = drafts.map((draft) => ({ ...draft, id: newId('cand') }));
  const selected = candidates[0];
  // D-07 : un B-roll ne dure pas plus longtemps que la vidéo choisie.
  const endSeconds =
    selected === undefined
      ? suggestion.endSeconds
      : Math.round(Math.min(suggestion.endSeconds, suggestion.startSeconds + selected.durationSeconds) * 1000) / 1000;
  return {
    id: newId('broll'),
    startSeconds: suggestion.startSeconds,
    endSeconds,
    reason: suggestion.reason,
    searchQuery: suggestion.searchQuery,
    candidates,
    selectedCandidateId: selected?.id ?? null,
    status: 'suggested',
    fit: 'cover',
    enabled: true,
  };
}

export function newId(prefix: 'broll' | 'cand'): string {
  return `${prefix}_${randomBytes(5).toString('hex')}`;
}
