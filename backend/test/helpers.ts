import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import type { Express } from 'express';
import { createApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config/env.ts';
import type { RenderJobStatus } from '../src/contract.ts';
import { openDatabase } from '../src/db/database.ts';
import { createLogger, type Logger } from '../src/utils/logger.ts';

/** Logger muet pour ne pas polluer la sortie des tests. */
export const silentLogger: Logger = createLogger('error', {}, () => {});

/** État déclaré de FFmpeg pour /api/health ; l'import, lui, appelle le vrai ffprobe. */
export const AVAILABLE_BINARIES = {
  ffmpeg: { available: true, version: 'test' },
  ffprobe: { available: true, version: 'test' },
} as const;

/** Configuration de test : base en mémoire, aucune clé fournisseur. */
export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', ...overrides });
}

export interface TestServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** Démarre l'application sur un port libre de 127.0.0.1. */
export async function startTestServer(app: Express): Promise<TestServer> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

export interface TestApp {
  readonly baseUrl: string;
  readonly db: DatabaseSync;
  close(): Promise<void>;
}

/** Application complète sur une base en mémoire. */
export async function startTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const db = openDatabase(':memory:');
  const app = createApp({ config: testConfig(overrides), logger: silentLogger, db, binaries: AVAILABLE_BINARIES });
  const server = await startTestServer(app);
  return {
    baseUrl: server.baseUrl,
    db,
    close: async () => {
      await server.close();
      db.close();
    },
  };
}

export interface RenderJobSeed {
  id: string;
  projectId: string;
  status: RenderJobStatus;
  createdAtMs: number;
  revision?: number;
  outputSizeBytes?: number;
  outputDurationSeconds?: number;
  errorCode?: string;
  errorMessage?: string;
  startedAtMs?: number;
  completedAtMs?: number;
}

/** Écrit un job comme le ferait le worker (table render_jobs du contrat). */
export function insertRenderJob(db: DatabaseSync, seed: RenderJobSeed): void {
  db.prepare(
    `INSERT INTO render_jobs (id, project_id, project_revision, status, payload, output_size_bytes,
       output_duration_seconds, error_code, error_message, created_at_ms, updated_at_ms, started_at_ms, completed_at_ms)
     VALUES (:id, :projectId, :revision, :status, '{}', :outputSizeBytes, :outputDurationSeconds, :errorCode,
       :errorMessage, :createdAtMs, :createdAtMs, :startedAtMs, :completedAtMs)`,
  ).run({
    id: seed.id,
    projectId: seed.projectId,
    revision: seed.revision ?? 0,
    status: seed.status,
    outputSizeBytes: seed.outputSizeBytes ?? null,
    outputDurationSeconds: seed.outputDurationSeconds ?? null,
    errorCode: seed.errorCode ?? null,
    errorMessage: seed.errorMessage ?? null,
    createdAtMs: seed.createdAtMs,
    startedAtMs: seed.startedAtMs ?? null,
    completedAtMs: seed.completedAtMs ?? null,
  });
}
