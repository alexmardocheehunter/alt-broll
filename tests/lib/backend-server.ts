import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from './paths.ts';

const BACKEND_DIR = path.join(PROJECT_ROOT, 'backend');
const READY_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 8_000;

export interface RunningBackend {
  baseUrl: string;
  databasePath: string;
  storageRoot: string;
  /** Sortie stdout + stderr du processus (diagnostic en cas d'échec). */
  logs(): string;
  stop(): Promise<void>;
}

/**
 * Démarre le vrai backend (node src/server.ts) sur un port libre, avec une base
 * SQLite et un stockage temporaires. Les clés fournisseur sont forcées vides :
 * les tests ne doivent jamais appeler Groq, OpenRouter ou Pixabay, même si un
 * .env local existe.
 */
export interface BackendOptions {
  /** Variables d'environnement supplémentaires (prioritaires sur les valeurs de test). */
  env?: Readonly<Record<string, string>>;
}

export async function startBackend(options: BackendOptions = {}): Promise<RunningBackend> {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'alt-broll-qa-'));
  const databasePath = path.join(tempDir, 'qa.sqlite');
  const storageRoot = path.join(tempDir, 'storage');
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    APP_BASE_URL: baseUrl,
    FRONTEND_ORIGIN: 'http://localhost:5500,https://qa.alt-broll.test',
    LOG_LEVEL: 'error',
    DATABASE_PATH: databasePath,
    STORAGE_ROOT: storageRoot,
    // Un .env local ne doit pas changer le résultat des tests.
    GROQ_API_KEY: '',
    OPENROUTER_API_KEY: '',
    OPENROUTER_MODEL: '',
    PIXABAY_API_KEY: '',
    MAX_UPLOAD_MB: '150',
    MIN_VIDEO_DURATION_SECONDS: '5',
    MAX_VIDEO_DURATION_SECONDS: '180',
    RENDER_MAX_SHORT_SIDE: '1080',
    ...options.env,
  };

  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: BACKEND_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let output = '';
  const capture = (chunk: Buffer): void => {
    output += chunk.toString('utf8');
    if (output.length > 200_000) output = output.slice(-200_000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`Le backend s'est arrêté avant d'être prêt.\n--- sortie ---\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.status === 200 || response.status === 503) {
        await response.body?.cancel();
        return buildHandle(child, baseUrl, databasePath, storageRoot, tempDir, () => output);
      }
      await response.body?.cancel();
    } catch {
      // Pas encore prêt : nouvel essai.
    }
    await sleep(100);
  }

  await stopChild(child);
  throw new Error(`Le backend n'a pas répondu en ${READY_TIMEOUT_MS} ms.\n--- sortie ---\n${output}`);
}

function buildHandle(
  child: ChildProcessWithoutNullStreams,
  baseUrl: string,
  databasePath: string,
  storageRoot: string,
  tempDir: string,
  logs: () => string,
): RunningBackend {
  let stopped = false;
  return {
    baseUrl,
    databasePath,
    storageRoot,
    logs,
    async stop() {
      if (stopped) return;
      stopped = true;
      await stopChild(child);
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const exited = await waitForExit(child, STOP_TIMEOUT_MS);
  if (!exited) {
    child.kill('SIGKILL');
    await waitForExit(child, 2_000);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Impossible de trouver un port libre.'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HttpResult {
  status: number;
  headers: Headers;
  text: string;
  /** Corps JSON parsé ; undefined si le corps n'est pas du JSON. */
  json: unknown;
}

/** Appel HTTP sans exception sur les statuts 4xx/5xx. */
export async function http(
  baseUrl: string,
  route: string,
  init: RequestInit = {},
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${route}`, { ...init, signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}
