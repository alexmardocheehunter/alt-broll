import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import type { FetchLike } from '../providers/types.ts';

/** Téléchargement refusé ou interrompu ; le message reste dans les logs serveur. */
export class MediaDownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MediaDownloadError';
  }
}

export interface DownloadOptions {
  readonly fetch: FetchLike;
  /** Taille maximale acceptée, vérifiée sur l'en-tête puis pendant la réception. */
  readonly maxBytes: number;
  /** Délai maximal de tout le téléchargement. */
  readonly timeoutMs: number;
  /** Adresses autorisées, vérifiées avant l'appel et après les redirections. */
  readonly isAllowedUrl: (url: string) => boolean;
  /** Annulation par l'appelant (projet supprimé pendant le téléchargement). */
  readonly signal?: AbortSignal;
}

/** Télécharge `url` dans `destination` en flux, sans dépasser `maxBytes`. Renvoie le nombre d'octets reçus. */
export async function downloadMedia(url: string, destination: string, options: DownloadOptions): Promise<number> {
  if (!options.isAllowedUrl(url)) throw new MediaDownloadError('adresse non autorisée');

  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  const response = await options.fetch(url, { signal });
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new MediaDownloadError(`réponse HTTP ${response.status}`);
  }
  const finalUrl = response.url === '' ? url : response.url;
  if (!options.isAllowedUrl(finalUrl)) {
    await response.body.cancel();
    throw new MediaDownloadError('redirection vers une adresse non autorisée');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    await response.body.cancel();
    throw new MediaDownloadError(`fichier trop volumineux (${declared} octets annoncés)`);
  }

  let received = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > options.maxBytes) callback(new MediaDownloadError('fichier trop volumineux'));
      else callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), limiter, createWriteStream(destination));
  return received;
}
