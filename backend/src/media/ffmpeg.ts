import { execFile } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_DETAIL_LENGTH = 800;

/** ffmpeg absent ou non exécutable : problème d'installation du serveur. */
export class FfmpegUnavailableError extends Error {
  constructor(command: string, options?: ErrorOptions) {
    super(`ffmpeg introuvable (${command}).`, options);
    this.name = 'FfmpegUnavailableError';
  }
}

/** ffmpeg a échoué ; le message reprend la fin de son journal (logs serveur uniquement). */
export class FfmpegFailedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FfmpegFailedError';
  }
}

/** Exécute ffmpeg sans shell ni lecture du clavier ; renvoie son journal (stderr). */
export function runFfmpeg(
  ffmpegPath: string,
  args: readonly string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ['-hide_banner', '-nostdin', ...args],
      { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, encoding: 'utf8' },
      (error, _stdout, stderr) => {
        if (error === null) {
          resolve(stderr);
          return;
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new FfmpegUnavailableError(ffmpegPath, { cause: error }));
          return;
        }
        reject(new FfmpegFailedError(stderr.trim().slice(-MAX_ERROR_DETAIL_LENGTH) || error.message, { cause: error }));
      },
    );
  });
}
