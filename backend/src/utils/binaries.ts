import { execFile } from 'node:child_process';

export interface BinaryStatus {
  readonly available: boolean;
  /** Version annoncée par `<binaire> -version`, ex. "9.0.2-full_build-www.gyan.dev". */
  readonly version: string | null;
}

const PROBE_TIMEOUT_MS = 5_000;

/** Vérifie qu'un exécutable FFmpeg répond, sans shell (aucune injection possible). */
export function probeBinary(command: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<BinaryStatus> {
  return new Promise((resolve) => {
    execFile(command, ['-version'], { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve({ available: false, version: null });
        return;
      }
      const firstLine = stdout.split(/\r?\n/, 1)[0] ?? '';
      resolve({ available: true, version: /version\s+(\S+)/.exec(firstLine)?.[1] ?? null });
    });
  });
}
