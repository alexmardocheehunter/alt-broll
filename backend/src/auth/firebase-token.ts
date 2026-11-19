import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import type { AuthUser } from '../contract.ts';
import type { FetchLike } from '../providers/types.ts';

/** Clés publiques des jetons Firebase Authentication, au format JWK. */
export const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const KEYS_TIMEOUT_MS = 10_000;
const DEFAULT_KEYS_TTL_MS = 60 * 60 * 1000;
/** Clé inconnue ou service injoignable : au plus un rechargement des clés toutes les 30 s. */
const MIN_REFRESH_INTERVAL_MS = 30_000;
/** Écart d'horloge toléré avec les serveurs de Google. */
const CLOCK_TOLERANCE_SECONDS = 60;
const MAX_TOKEN_LENGTH = 4096;
const MAX_UID_LENGTH = 128;

/** Jeton absent de la liste des formes acceptées, expiré, ou pas émis pour ce projet. */
export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(`jeton refusé : ${reason}`);
    this.name = 'InvalidTokenError';
  }
}

/** Clés publiques de Google indisponibles : impossible de vérifier un jeton pour l'instant. */
export class SigningKeysUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super('clés publiques de Firebase Authentication indisponibles', options);
    this.name = 'SigningKeysUnavailableError';
  }
}

export interface TokenVerifier {
  /** Compte du jeton d'identification Firebase ; InvalidTokenError ou SigningKeysUnavailableError sinon. */
  verify(token: string): Promise<AuthUser>;
}

export interface FirebaseTokenVerifierOptions {
  readonly projectId: string;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
}

const headerSchema = z.object({ alg: z.literal('RS256'), kid: z.string().min(1) });
const jwksSchema = z.object({
  keys: z.array(z.looseObject({ kid: z.string().min(1), kty: z.string(), n: z.string().optional(), e: z.string().optional() })),
});

/**
 * Vérifie les jetons d'identification Firebase comme le documente Firebase pour une
 * bibliothèque JWT tierce : signature RS256 par une clé publique de Google, émetteur et
 * audience du projet, dates cohérentes, uid non vide.
 */
export function createFirebaseTokenVerifier({ projectId, fetch = globalThis.fetch, now = Date.now }: FirebaseTokenVerifierOptions): TokenVerifier {
  const payloadSchema = z.object({
    iss: z.literal(`https://securetoken.google.com/${projectId}`),
    aud: z.literal(projectId),
    sub: z.string().min(1).max(MAX_UID_LENGTH),
    iat: z.number(),
    exp: z.number(),
    auth_time: z.number(),
    email: z.string().optional(),
  });

  let keys = new Map<string, KeyObject>();
  let expiresAtMs = 0;
  let lastFetchMs = Number.NEGATIVE_INFINITY;
  let pending: Promise<void> | null = null;

  async function fetchKeys(): Promise<void> {
    lastFetchMs = now();
    const response = await fetch(FIREBASE_JWKS_URL, { signal: AbortSignal.timeout(KEYS_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { keys: jwks } = jwksSchema.parse(await response.json());
    const next = new Map<string, KeyObject>();
    for (const jwk of jwks) {
      if (jwk.kty === 'RSA') next.set(jwk.kid, createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' }));
    }
    keys = next;
    expiresAtMs = now() + maxAgeMs(response.headers.get('cache-control'));
  }

  async function keyFor(kid: string): Promise<KeyObject> {
    if (pending !== null) {
      await pending;
    } else if ((now() >= expiresAtMs || !keys.has(kid)) && now() - lastFetchMs >= MIN_REFRESH_INTERVAL_MS) {
      // En cas d'échec, les clés déjà connues restent utilisées : Google les garde valides plusieurs jours.
      pending = fetchKeys()
        .catch((error: unknown) => {
          if (keys.size === 0) throw new SigningKeysUnavailableError({ cause: error });
        })
        .finally(() => {
          pending = null;
        });
      await pending;
    }
    const key = keys.get(kid);
    if (key !== undefined) return key;
    if (keys.size === 0) throw new SigningKeysUnavailableError();
    throw new InvalidTokenError('clé de signature inconnue');
  }

  return {
    async verify(token) {
      if (token.length > MAX_TOKEN_LENGTH) throw new InvalidTokenError('trop long');
      const [encodedHeader, encodedPayload, encodedSignature, ...rest] = token.split('.');
      if (encodedHeader === undefined || encodedPayload === undefined || encodedSignature === undefined || rest.length > 0) {
        throw new InvalidTokenError('format JWT attendu');
      }
      const header = headerSchema.safeParse(decodeSegment(encodedHeader));
      if (!header.success) throw new InvalidTokenError('en-tête non accepté');

      const key = await keyFor(header.data.kid);
      const signed = Buffer.from(`${encodedHeader}.${encodedPayload}`);
      if (!verifySignature('RSA-SHA256', signed, key, Buffer.from(encodedSignature, 'base64url'))) {
        throw new InvalidTokenError('signature invalide');
      }

      const payload = payloadSchema.safeParse(decodeSegment(encodedPayload));
      if (!payload.success) throw new InvalidTokenError('émetteur, audience ou compte non accepté');
      const nowSeconds = now() / 1000;
      const { exp, iat, auth_time: authTime, sub, email } = payload.data;
      if (exp <= nowSeconds - CLOCK_TOLERANCE_SECONDS) throw new InvalidTokenError('expiré');
      if (iat > nowSeconds + CLOCK_TOLERANCE_SECONDS || authTime > nowSeconds + CLOCK_TOLERANCE_SECONDS) {
        throw new InvalidTokenError('émis dans le futur');
      }
      return { id: sub, email: email ?? null };
    },
  };
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Durée de validité annoncée par Google (Cache-Control: max-age), sinon une heure. */
function maxAgeMs(cacheControl: string | null): number {
  const match = /max-age=(\d+)/i.exec(cacheControl ?? '');
  const seconds = match === null ? Number.NaN : Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_KEYS_TTL_MS;
}
