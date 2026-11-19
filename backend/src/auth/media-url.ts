import { createHmac, timingSafeEqual } from 'node:crypto';

/** Fichiers ouverts par le navigateur sans en-tête Authorization : lecteur vidéo et téléchargement. */
export type SignedResource = 'source' | 'download';

/** Validité minimale d'un lien ; l'échéance est arrondie à l'heure pour garder une URL stable (cache du navigateur). */
const MIN_VALIDITY_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface MediaUrlSigner {
  /** Paramètres « exp=…&sig=… » à ajouter à l'URL du fichier. */
  query(projectId: string, resource: SignedResource): string;
  isValid(projectId: string, resource: SignedResource, exp: unknown, sig: unknown): boolean;
}

export function createMediaUrlSigner(secret: string, now: () => number = Date.now): MediaUrlSigner {
  const signature = (projectId: string, resource: SignedResource, exp: number): Buffer =>
    createHmac('sha256', secret).update(`v1:${projectId}:${resource}:${exp}`).digest();

  return {
    query(projectId, resource) {
      const exp = Math.ceil((now() + MIN_VALIDITY_MS) / HOUR_MS) * (HOUR_MS / 1000);
      return `exp=${exp}&sig=${signature(projectId, resource, exp).toString('base64url')}`;
    },
    isValid(projectId, resource, exp, sig) {
      if (typeof exp !== 'string' || typeof sig !== 'string' || !/^\d{1,12}$/.test(exp)) return false;
      const expSeconds = Number(exp);
      if (expSeconds * 1000 <= now()) return false;
      const expected = signature(projectId, resource, expSeconds);
      const received = Buffer.from(sig, 'base64url');
      return received.length === expected.length && timingSafeEqual(received, expected);
    },
  };
}
