import { z } from 'zod';
import { TIMELINE_RULES } from '../contract.ts';
import { callProvider, invalidProviderResponse, readJsonBody } from './http.ts';
import type { BrollCandidateDraft, BrollOrientation, BrollSearchProvider, BrollSearchRequest, FetchLike } from './types.ts';

const PIXABAY_VIDEOS_URL = 'https://pixabay.com/api/videos/';
const PIXABAY_TIMEOUT_MS = 15_000;
/** Les conditions de l'API Pixabay imposent de garder les réponses en cache 24 h. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const RESULTS_PER_PAGE = 20;
/** Version téléchargée pour l'export : jamais au-delà du 1080p. */
const MAX_RENDITION_SIDE = 1920;
/** Version de preview : la plus légère qui reste nette. */
const MIN_PREVIEW_SIDE = 640;

const renditionSchema = z.object({
  url: z.string(),
  width: z.number(),
  height: z.number(),
  thumbnail: z.string().optional(),
});

const hitSchema = z.object({
  id: z.number(),
  pageURL: z.string(),
  tags: z.string().default(''),
  duration: z.number(),
  user: z.string().default('Pixabay'),
  videos: z.record(z.string(), renditionSchema),
});
export type PixabayHit = z.infer<typeof hitSchema>;

const responseSchema = z.object({ hits: z.array(hitSchema) });

export interface PixabayProviderOptions {
  readonly apiKey: string;
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** Recherche de vidéos Pixabay, réponses en cache 24 h, URL limitées aux domaines pixabay.com. */
export function createPixabaySearchProvider({
  apiKey,
  fetch = globalThis.fetch,
  sleep,
  now = Date.now,
}: PixabayProviderOptions): BrollSearchProvider {
  const cache = new Map<string, { expiresAtMs: number; hits: PixabayHit[] }>();

  async function fetchHits(query: string): Promise<PixabayHit[]> {
    const key = query.toLowerCase();
    const cached = cache.get(key);
    if (cached !== undefined && cached.expiresAtMs > now()) return cached.hits;

    const params = new URLSearchParams({
      key: apiKey,
      q: query,
      lang: 'en',
      video_type: 'film',
      safesearch: 'true',
      order: 'popular',
      per_page: String(RESULTS_PER_PAGE),
    });
    const response = await callProvider(
      `${PIXABAY_VIDEOS_URL}?${params.toString()}`,
      { method: 'GET' },
      {
        provider: 'Pixabay',
        stage: 'broll_search',
        timeoutMs: PIXABAY_TIMEOUT_MS,
        fetch,
        sleep,
        // Pixabay signale une clé invalide par un 400 en texte brut.
        classify: (status, detail) => (status === 400 && /api key/i.test(detail) ? 'PROVIDER_NOT_CONFIGURED' : undefined),
      },
    );
    const parsed = responseSchema.safeParse(await readJsonBody(response, 'Pixabay', 'broll_search'));
    if (!parsed.success) throw invalidProviderResponse('Pixabay', 'broll_search', parsed.error.message);

    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    cache.set(key, { expiresAtMs: now() + CACHE_TTL_MS, hits: parsed.data.hits });
    return parsed.data.hits;
  }

  return {
    async search(request) {
      return rankPixabayHits(await fetchHits(request.query), request);
    },
  };
}

/** Classe les résultats : orientation de la source d'abord, puis durée suffisante, puis popularité. */
export function rankPixabayHits(
  hits: readonly PixabayHit[],
  { minDurationSeconds, orientation, limit, targetLongSide }: Omit<BrollSearchRequest, 'query'>,
): BrollCandidateDraft[] {
  const score = (draft: BrollCandidateDraft): number =>
    (orientationOf(draft) === orientation ? 2 : 0) + (draft.durationSeconds >= minDurationSeconds ? 1 : 0);
  return hits
    .map((hit) => toCandidateDraft(hit, targetLongSide))
    .filter((draft): draft is BrollCandidateDraft => draft !== null && draft.durationSeconds >= TIMELINE_RULES.minSegmentSeconds)
    .map((draft, rank) => ({ draft, rank, score: score(draft) }))
    .sort((a, b) => b.score - a.score || a.rank - b.rank)
    .slice(0, limit)
    .map(({ draft }) => draft);
}

/**
 * Résultat Pixabay → candidat du contrat ; null si aucune version exploitable.
 * Version téléchargée : la plus légère qui atteint la taille de l'export (`targetLongSide`),
 * sans dépasser le 1080p ; à défaut, la plus grande disponible.
 */
export function toCandidateDraft(hit: PixabayHit, targetLongSide: number = MAX_RENDITION_SIDE): BrollCandidateDraft | null {
  if (!isPixabayUrl(hit.pageURL)) return null;
  const renditions = Object.values(hit.videos)
    .filter((rendition) => rendition.url !== '' && rendition.width > 0 && rendition.height > 0 && isPixabayUrl(rendition.url))
    .sort((a, b) => a.width * a.height - b.width * b.height);
  const smallest = renditions[0];
  if (smallest === undefined) return null;

  const longSide = (rendition: { width: number; height: number }): number => Math.max(rendition.width, rendition.height);
  const preview = renditions.find((rendition) => longSide(rendition) >= MIN_PREVIEW_SIDE) ?? smallest;
  const withinLimit = renditions.filter((rendition) => longSide(rendition) <= MAX_RENDITION_SIDE);
  const pool = withinLimit.length > 0 ? withinLimit : renditions;
  const download =
    pool.find((rendition) => longSide(rendition) >= Math.min(targetLongSide, MAX_RENDITION_SIDE)) ?? pool[pool.length - 1] ?? smallest;
  const thumbnail = renditions.map((rendition) => rendition.thumbnail).find((url) => url !== undefined && isPixabayUrl(url));

  return {
    provider: 'pixabay',
    providerMediaId: String(hit.id),
    title: hit.tags.trim() === '' ? 'Vidéo Pixabay' : hit.tags.trim(),
    previewUrl: preview.url,
    downloadUrl: download.url,
    sourcePageUrl: hit.pageURL,
    thumbnailUrl: thumbnail ?? null,
    durationSeconds: hit.duration,
    width: download.width,
    height: download.height,
    attribution: `Vidéo de ${hit.user} sur Pixabay`,
  };
}

/** HTTPS et domaine pixabay.com uniquement : le backend ne téléchargera rien d'autre. */
export function isPixabayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'pixabay.com' || url.hostname.endsWith('.pixabay.com'));
  } catch {
    return false;
  }
}

function orientationOf({ width, height }: { width: number; height: number }): BrollOrientation {
  return height > width ? 'portrait' : 'landscape';
}
