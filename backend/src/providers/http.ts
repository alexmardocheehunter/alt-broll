import type { ErrorCode, ErrorStage } from '../contract.ts';
import { AppError } from '../utils/errors.ts';
import type { FetchLike } from './types.ts';

export type ProviderName = 'Groq' | 'OpenRouter' | 'Pixabay';

export interface ProviderCallOptions {
  readonly provider: ProviderName;
  readonly stage: ErrorStage;
  readonly timeoutMs: number;
  readonly fetch: FetchLike;
  /** Nouvelles tentatives sur 429, 5xx ou panne réseau (1 par défaut). */
  readonly retries?: number;
  /** Attente entre deux tentatives (remplaçable dans les tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Code plus précis pour un refus donné (ex. clé Pixabay invalide signalée par un 400). */
  readonly classify?: (status: number, detail: string) => ErrorCode | undefined;
}

const BASE_RETRY_DELAY_MS = 1_500;
const MAX_RETRY_DELAY_MS = 10_000;
const MAX_DETAIL_LENGTH = 500;
/** Refus 429 dû au quota du jour (offres gratuites) : inutile de réessayer avant le lendemain. */
const DAILY_QUOTA_PATTERN = /per[-\s]?day|daily|quota/i;

/**
 * Appelle un fournisseur : délai maximal, une nouvelle tentative sur 429, 5xx ou
 * panne réseau, puis traduction de l'échec en erreur du contrat. Le détail technique
 * (statut, début de la réponse) ne va que dans les logs, jamais au navigateur.
 */
export async function callProvider(url: string, init: RequestInit, options: ProviderCallOptions): Promise<Response> {
  const retries = options.retries ?? 1;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt += 1) {
    let response: Response;
    try {
      response = await options.fetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs) });
    } catch (error) {
      if (attempt < retries) {
        await sleep(BASE_RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw providerError(options, timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', { cause: error });
    }

    if (response.ok) return response;

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < retries) {
      await response.body?.cancel();
      await sleep(retryDelayMs(response, attempt));
      continue;
    }
    const detail = (await response.text().catch(() => '')).slice(0, MAX_DETAIL_LENGTH);
    const code = options.classify?.(response.status, detail) ?? codeForStatus(response.status);
    const message =
      response.status === 429 && DAILY_QUOTA_PATTERN.test(detail)
        ? `Le quota gratuit du jour du service ${options.provider} est atteint. Réessayez demain.`
        : undefined;
    throw providerError(options, code, { status: response.status, detail, ...(message === undefined ? {} : { message }) });
  }
}

/** Corps JSON d'une réponse réussie ; une réponse illisible devient PROVIDER_INVALID_RESPONSE. */
export async function readJsonBody(response: Response, provider: ProviderName, stage: ErrorStage): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw providerError({ provider, stage }, 'PROVIDER_INVALID_RESPONSE', { cause: error, detail: 'JSON illisible' });
  }
}

/** Réponse reçue mais inexploitable (format inattendu). */
export function invalidProviderResponse(provider: ProviderName, stage: ErrorStage, detail: string): AppError {
  return providerError({ provider, stage }, 'PROVIDER_INVALID_RESPONSE', { detail: detail.slice(0, MAX_DETAIL_LENGTH) });
}

function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 402 || status === 403) return 'PROVIDER_NOT_CONFIGURED';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_INVALID_RESPONSE';
}

function providerError(
  { provider, stage }: { readonly provider: ProviderName; readonly stage: ErrorStage },
  code: ErrorCode,
  extra: { status?: number; detail?: string; cause?: unknown; message?: string },
): AppError {
  const messages: Partial<Record<ErrorCode, string>> = {
    PROVIDER_NOT_CONFIGURED: `Le service ${provider} refuse la configuration du serveur (clé API ou crédit) : l'administrateur doit la vérifier.`,
    PROVIDER_RATE_LIMITED: `Le service ${provider} reçoit trop de demandes pour le moment. Réessayez dans une minute.`,
    PROVIDER_TIMEOUT: `Le service ${provider} n'a pas répondu à temps. Réessayez.`,
    PROVIDER_UNAVAILABLE: `Le service ${provider} est momentanément indisponible. Réessayez dans quelques minutes.`,
    PROVIDER_INVALID_RESPONSE: `Le service ${provider} a renvoyé une réponse inexploitable. Réessayez.`,
  };
  return new AppError({
    code,
    stage,
    httpStatus: code === 'PROVIDER_TIMEOUT' ? 504 : 502,
    retryable: code !== 'PROVIDER_NOT_CONFIGURED',
    message: extra.message ?? messages[code] ?? `Le service ${provider} a échoué.`,
    details: { provider, status: extra.status, detail: extra.detail },
    cause: extra.cause,
  });
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfterSeconds = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(MAX_RETRY_DELAY_MS, retryAfterSeconds * 1000);
  }
  return BASE_RETRY_DELAY_MS * (attempt + 1);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
