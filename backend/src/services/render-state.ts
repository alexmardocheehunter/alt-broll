import { ERROR_CODES, type ErrorCode, type ErrorInfo, type RenderJobRow, type RenderState } from '../contract.ts';

/** Le message d'erreur vient du worker : longueur bornée par précaution. */
const MAX_ERROR_MESSAGE_LENGTH = 300;
const DEFAULT_RENDER_ERROR_MESSAGE = "L'export a échoué. Relancez-le ; si le problème persiste, signalez-le.";

/** État du rendu exposé par l'API à partir du dernier job du projet (null = aucun export demandé). */
export function toRenderState(row: RenderJobRow | null): RenderState {
  if (row === null) {
    return {
      status: 'idle',
      jobId: null,
      revision: null,
      progress: 0,
      outputFile: null,
      startedAt: null,
      completedAt: null,
      error: null,
    };
  }

  const completed = row.status === 'completed';
  return {
    status: row.status,
    jobId: row.id,
    revision: row.project_revision,
    progress: displayedProgress(row),
    outputFile:
      completed && row.output_size_bytes !== null && row.output_duration_seconds !== null
        ? { sizeBytes: row.output_size_bytes, durationSeconds: row.output_duration_seconds }
        : null,
    startedAt: toIsoDate(row.started_at_ms),
    completedAt: toIsoDate(row.completed_at_ms),
    error: row.status === 'failed' ? toRenderError(row) : null,
  };
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Progression affichée : 1 une fois terminé, 0 tant que le rendu n'a pas (re)commencé
 * (un job remis en file par recoverStale garde l'ancienne valeur jusqu'au prochain claim).
 */
function displayedProgress(row: RenderJobRow): number {
  if (row.status === 'completed') return 1;
  if (row.status === 'preparing' || row.status === 'queued') return 0;
  return Math.min(1, Math.max(0, row.progress));
}

/** Un échec de rendu ne peut porter qu'un code RENDER_* (ou INTERNAL_ERROR) ; tout autre code est remplacé. */
function toRenderErrorCode(value: string | null): ErrorCode {
  return isErrorCode(value) && (value.startsWith('RENDER_') || value === 'INTERNAL_ERROR') ? value : 'INTERNAL_ERROR';
}

function toRenderError(row: RenderJobRow): ErrorInfo {
  const code = toRenderErrorCode(row.error_code);
  const message = row.error_message?.trim().slice(0, MAX_ERROR_MESSAGE_LENGTH) || DEFAULT_RENDER_ERROR_MESSAGE;
  // Un job invalide est un défaut du backend : le relancer ne changerait rien.
  return { code, stage: 'render', message, retryable: code !== 'RENDER_INVALID_JOB' };
}

function toIsoDate(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}
