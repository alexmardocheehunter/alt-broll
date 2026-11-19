import type { AnalysisProviders, BrollCandidateDraft } from './types.ts';

/**
 * FOURNISSEURS SIMULÉS (PROVIDER_MODE=mock, demande QA-002)
 * Pour les tests hors ligne uniquement ; refusés en production par la configuration.
 * Aucune donnée produite ici ne se fait passer pour du réel : provider = 'simulation',
 * modèle « simulation-hors-ligne », textes préfixés « [Simulation] », URL en .invalid.
 */
export const SIMULATION_MODEL = 'simulation-hors-ligne';

const SAMPLE_SENTENCES = [
  'Je vends des jus de fruits frais au marché.',
  'Chaque matin, je choisis les mangues les plus mûres.',
  'Le soir, je range mon stand près de la plage.',
  'Mon projet est d’ouvrir un kiosque en ville.',
] as const;

const SAMPLE_QUERIES = ['busy market street', 'fresh mangoes', 'beach sunset', 'city street kiosk'] as const;

export function createSimulationProviders(): AnalysisProviders {
  return {
    transcription: {
      async transcribe({ durationSeconds }) {
        const slot = durationSeconds / SAMPLE_SENTENCES.length;
        const segments = SAMPLE_SENTENCES.map((sentence, index) => ({
          startSeconds: round3(index * slot),
          endSeconds: round3((index + 1) * slot),
          text: `[Simulation] ${sentence}`,
        }));
        return {
          provider: 'simulation',
          model: SIMULATION_MODEL,
          language: 'fr',
          text: segments.map((segment) => segment.text).join(' '),
          segments,
          words: [],
        };
      },
    },

    analysis: {
      async analyze({ durationSeconds, transcriptSegments }) {
        const suggestions = transcriptSegments.slice(0, SAMPLE_QUERIES.length).map((segment, index) => {
          const startSeconds = round3(Math.min(segment.startSeconds + 0.5, Math.max(0, durationSeconds - 3)));
          return {
            startSeconds,
            endSeconds: round3(Math.min(durationSeconds, startSeconds + 3)),
            reason: `[Simulation] Plan de coupe proposé sans IA pour le segment ${index + 1}.`,
            searchQuery: SAMPLE_QUERIES[index] ?? 'city street',
          };
        });
        return {
          model: SIMULATION_MODEL,
          // La simulation n'analyse aucune image : ne jamais le prétendre.
          visualAnalysisUsed: false,
          summary: '[Simulation] Résumé non produit par une IA.',
          suggestions,
        };
      },
    },

    brollSearch: {
      async search({ query, limit }) {
        const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'media';
        return Array.from({ length: Math.min(limit, 2) }, (_, index): BrollCandidateDraft => ({
          provider: 'simulation',
          providerMediaId: `${slug}-${index + 1}`,
          title: `[Simulation] ${query}`,
          previewUrl: `https://simulation.invalid/broll/${slug}-${index + 1}-preview.mp4`,
          downloadUrl: `https://simulation.invalid/broll/${slug}-${index + 1}.mp4`,
          sourcePageUrl: 'https://simulation.invalid/',
          thumbnailUrl: null,
          durationSeconds: 12,
          width: 1280,
          height: 720,
          attribution: 'Média simulé : aucun appel à Pixabay',
        }));
      },
    },
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
