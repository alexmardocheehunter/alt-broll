import { z } from 'zod';
import type { Logger } from '../utils/logger.ts';
import { callProvider, invalidProviderResponse, readJsonBody } from './http.ts';
import type { ContentAnalysisProvider, ContentAnalysisResult, FetchLike } from './types.ts';

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_TIMEOUT_MS = 90_000;
/** La liste publique pèse plusieurs Mo : délai large, chargée en avance au démarrage. */
const MODELS_TIMEOUT_MS = 30_000;
const MODEL_LIST_TTL_MS = 60 * 60 * 1000;
/** Après un échec, la liste n'est redemandée qu'au bout de 10 min pour ne pas ralentir chaque analyse. */
const MODEL_LIST_RETRY_MS = 10 * 60 * 1000;
/** Large : certains modèles gratuits « réfléchissent » avant de répondre et consomment des tokens. */
const MAX_COMPLETION_TOKENS = 6_000;
/** Modèle principal + 2 secours au plus. */
const MAX_MODEL_CHAIN = 3;

/** Forme imposée à la réponse (structured outputs) : le JSON est garanti, puis revalidé. */
export const BROLL_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'suggestions'],
  properties: {
    summary: { type: 'string', description: 'Une phrase en français résumant la vidéo.' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['startSeconds', 'endSeconds', 'reason', 'searchQuery'],
        properties: {
          startSeconds: { type: 'number' },
          endSeconds: { type: 'number' },
          reason: { type: 'string', description: 'Une phrase courte en français.' },
          searchQuery: { type: 'string', description: '2 à 4 mots-clés en anglais.' },
        },
      },
    },
  },
} as const;

const planSchema = z.object({
  summary: z.string(),
  suggestions: z.array(
    z.object({ startSeconds: z.number(), endSeconds: z.number(), reason: z.string(), searchQuery: z.string() }),
  ),
});

const completionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }) }))
    .min(1),
});

const modelListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      architecture: z.object({ input_modalities: z.array(z.string()).optional() }).optional(),
    }),
  ),
});

export interface OpenRouterProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  /** Essayés dans l'ordre par OpenRouter si les précédents sont indisponibles. */
  readonly fallbackModels?: readonly string[];
  readonly fetch?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: Logger;
  readonly now?: () => number;
  /** Charge la liste des modèles dès la création, pour que la première analyse n'attende pas. */
  readonly prefetchModelList?: boolean;
}

/** Liste publique des modèles OpenRouter : tous ceux qui existent, et ceux qui acceptent les images. */
interface ModelCatalog {
  readonly all: ReadonlySet<string>;
  readonly image: ReadonlySet<string>;
}

/**
 * Analyse texte + image via OpenRouter. La chaîne de modèles est confrontée à la liste
 * publique : un modèle disparu (fréquent pour les modèles gratuits) est ignoré, et l'image
 * n'est confiée qu'aux modèles qui l'acceptent réellement.
 */
export function createOpenRouterAnalysisProvider(options: OpenRouterProviderOptions): ContentAnalysisProvider {
  const { apiKey, model, fallbackModels = [], fetch = globalThis.fetch, sleep, logger, now = Date.now } = options;
  const chain = [...new Set([model, ...fallbackModels])].slice(0, MAX_MODEL_CHAIN);
  /** catalog null : dernier chargement en échec, mémorisé MODEL_LIST_RETRY_MS. */
  let cached: { checkedAtMs: number; catalog: ModelCatalog | null } | null = null;
  let inFlight: Promise<ModelCatalog | null> | null = null;

  /** En cache 1 h (10 min après un échec) ; null si la liste est inaccessible : la chaîne est alors utilisée telle quelle. */
  function modelCatalog(): Promise<ModelCatalog | null> {
    if (cached !== null) {
      const ttl = cached.catalog === null ? MODEL_LIST_RETRY_MS : MODEL_LIST_TTL_MS;
      if (now() - cached.checkedAtMs < ttl) return Promise.resolve(cached.catalog);
    }
    inFlight ??= loadCatalog().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function loadCatalog(): Promise<ModelCatalog | null> {
    try {
      const response = await callProvider(
        OPENROUTER_MODELS_URL,
        { method: 'GET' },
        { provider: 'OpenRouter', stage: 'analysis', timeoutMs: MODELS_TIMEOUT_MS, fetch, sleep, retries: 0 },
      );
      const list = modelListSchema.parse(await response.json());
      const catalog: ModelCatalog = {
        all: new Set(list.data.map((entry) => entry.id)),
        image: new Set(list.data.filter((entry) => entry.architecture?.input_modalities?.includes('image')).map((entry) => entry.id)),
      };
      cached = { checkedAtMs: now(), catalog };
      return catalog;
    } catch (error) {
      logger?.warn('openrouter.model_list_unavailable', { err: error });
      cached = { checkedAtMs: now(), catalog: null };
      return null;
    }
  }

  if (options.prefetchModelList === true) void modelCatalog();

  return {
    async analyze({ prompt, contactSheet }) {
      const catalog = await modelCatalog();
      const existing = catalog === null ? chain : chain.filter((id) => catalog.all.has(id));
      if (existing.length < chain.length) {
        logger?.warn('openrouter.models_unavailable', { missing: chain.filter((id) => !existing.includes(id)) });
      }
      // Si plus aucun modèle n'existe, la chaîne est tentée telle quelle : l'erreur d'OpenRouter sera explicite.
      const usable = existing.length > 0 ? existing : chain;

      let models = usable;
      let sendImage = contactSheet !== null;
      if (sendImage && catalog !== null) {
        const visionModels = usable.filter((id) => catalog.image.has(id));
        if (visionModels.length > 0) models = visionModels;
        else sendImage = false;
      }

      const userContent =
        sendImage && contactSheet !== null
          ? [
              { type: 'text', text: prompt.user },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${contactSheet.toString('base64')}` } },
            ]
          : prompt.user;
      const body = {
        ...(models.length > 1 ? { models } : { model: models[0] }),
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'broll_plan', strict: true, schema: BROLL_PLAN_SCHEMA } },
        // N'envoyer qu'aux hébergeurs qui respectent response_format.
        provider: { require_parameters: true },
        temperature: 0.2,
        max_tokens: MAX_COMPLETION_TOKENS,
      };

      const response = await callProvider(
        OPENROUTER_CHAT_URL,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        { provider: 'OpenRouter', stage: 'analysis', timeoutMs: OPENROUTER_TIMEOUT_MS, fetch, sleep },
      );
      return parseOpenRouterCompletion(await readJsonBody(response, 'OpenRouter', 'analysis'), {
        imageSent: sendImage,
        requestedModel: models[0] ?? model,
      });
    },
  };
}

/** Réponse chat/completions → plan de B-rolls validé. */
export function parseOpenRouterCompletion(
  raw: unknown,
  { imageSent, requestedModel }: { readonly imageSent: boolean; readonly requestedModel: string },
): ContentAnalysisResult {
  if (typeof raw === 'object' && raw !== null && 'error' in raw) {
    throw invalidProviderResponse('OpenRouter', 'analysis', JSON.stringify((raw as { error: unknown }).error));
  }
  const completion = completionSchema.safeParse(raw);
  if (!completion.success) throw invalidProviderResponse('OpenRouter', 'analysis', completion.error.message);

  const content = completion.data.choices[0]?.message.content;
  if (content === undefined || content === null || content.trim() === '') {
    throw invalidProviderResponse('OpenRouter', 'analysis', 'réponse vide');
  }

  let plan: z.infer<typeof planSchema>;
  try {
    plan = planSchema.parse(JSON.parse(stripJsonFences(content)));
  } catch (error) {
    throw invalidProviderResponse('OpenRouter', 'analysis', error instanceof Error ? error.message : String(error));
  }

  return {
    model: completion.data.model ?? requestedModel,
    visualAnalysisUsed: imageSent,
    summary: plan.summary.trim(),
    suggestions: plan.suggestions,
  };
}

/** Certains hébergeurs entourent le JSON de ```json … ``` malgré response_format. */
function stripJsonFences(content: string): string {
  const trimmed = content.trim();
  return /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
}
