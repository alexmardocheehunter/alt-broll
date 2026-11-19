import type { AppConfig } from '../config/env.ts';
import type { Logger } from '../utils/logger.ts';
import { createGroqTranscriptionProvider } from './groq.provider.ts';
import { createOpenRouterAnalysisProvider } from './openrouter.provider.ts';
import { createPixabaySearchProvider } from './pixabay.provider.ts';
import { createSimulationProviders } from './simulation.provider.ts';
import type { AnalysisProviders, FetchLike } from './types.ts';

/**
 * Fournisseurs de l'analyse selon la configuration : simulés en mode mock, réels si
 * toutes les clés et le modèle sont présents, null sinon (POST /analyze répond alors 503).
 */
export function createAnalysisProviders(
  config: AppConfig,
  logger: Logger,
  fetch: FetchLike = globalThis.fetch,
): AnalysisProviders | null {
  const { mode, groq, openRouter, pixabay } = config.providers;
  if (mode === 'mock') return createSimulationProviders();
  if (groq.apiKey === undefined || openRouter.apiKey === undefined || openRouter.model === undefined || pixabay.apiKey === undefined) {
    return null;
  }
  return {
    transcription: createGroqTranscriptionProvider({ apiKey: groq.apiKey, model: groq.transcriptionModel, fetch }),
    analysis: createOpenRouterAnalysisProvider({
      apiKey: openRouter.apiKey,
      model: openRouter.model,
      fallbackModels: openRouter.fallbackModels,
      fetch,
      logger,
      prefetchModelList: true,
    }),
    brollSearch: createPixabaySearchProvider({ apiKey: pixabay.apiKey, fetch }),
  };
}
