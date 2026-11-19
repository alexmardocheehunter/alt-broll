import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config/env.ts';
import { STORAGE_LAYOUT, TIMELINE_RULES, type BrollCandidate, type BrollItem } from '../contract.ts';
import { downloadMedia } from '../media/download.ts';
import { runFfmpeg } from '../media/ffmpeg.ts';
import { probeVideo } from '../media/ffprobe.ts';
import { isPixabayUrl } from '../providers/pixabay.provider.ts';
import type { FetchLike } from '../providers/types.ts';
import type { LocalStorage } from '../storage/local-storage.ts';
import { forEachLimited } from '../utils/concurrency.ts';
import type { Logger } from '../utils/logger.ts';
import { isMounted } from './timeline.service.ts';

/** Une vidéo Pixabay en 1080p de 30 s pèse rarement plus de 100 Mo. */
const MAX_BROLL_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const SIMULATED_MEDIA_TIMEOUT_MS = 60_000;
/** Borne la mémoire des fichiers déjà vérifiés (quelques octets chacun). */
const MAX_VERIFIED_ENTRIES = 5_000;
/** Téléchargements simultanés : plus rapide qu'un par un, sans saturer la connexion. */
export const DOWNLOAD_CONCURRENCY = 3;

export interface MediaInfo {
  readonly durationSeconds: number;
  readonly width: number;
  readonly height: number;
}

/** Vidéos B-roll sur le disque du projet : broll/<candidat>.mp4. */
export interface BrollMediaStore {
  /**
   * Fichier prêt et vérifié : réutilisé s'il existe, sinon téléchargé (Pixabay) ou fabriqué
   * (simulation). Un même fichier n'est jamais préparé deux fois en parallèle.
   */
  ensure(projectId: string, candidate: BrollCandidate): Promise<MediaInfo>;
  /**
   * En tâche de fond, télécharge les vidéos Pixabay choisies des B-rolls montés : l'export
   * démarre ensuite sans attendre le réseau. Les médias simulés, fabriqués localement en
   * quelques instants, attendent l'export.
   */
  prefetch(projectId: string, items: readonly BrollItem[]): void;
  /** Projet supprimé : annule ses téléchargements, attend leur fin et refuse les suivants. */
  release(projectId: string): Promise<void>;
  /** Se résout quand plus aucun fichier n'est en préparation. */
  whenIdle(): Promise<void>;
}

export interface BrollMediaStoreDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly storage: LocalStorage;
  readonly fetch?: FetchLike;
}

interface Task {
  readonly projectId: string;
  readonly controller: AbortController;
  readonly promise: Promise<MediaInfo>;
}

export function brollFile(candidate: Pick<BrollCandidate, 'id'>): string {
  return `${STORAGE_LAYOUT.brollDir}/${candidate.id}.mp4`;
}

export function createBrollMediaStore({ config, logger, storage, fetch = globalThis.fetch }: BrollMediaStoreDeps): BrollMediaStore {
  const inFlight = new Map<string, Task>();
  /** Préchargements en cours (chacun enchaîne plusieurs fichiers). */
  const background = new Set<Promise<void>>();
  /** Fichiers déjà mesurés : un enregistrement automatique de l'éditeur ne relance pas ffprobe. */
  const verified = new Map<string, { readonly projectId: string; readonly info: MediaInfo }>();
  const released = new Set<string>();

  function ensure(projectId: string, candidate: BrollCandidate): Promise<MediaInfo> {
    if (released.has(projectId)) return Promise.reject(new Error('projet supprimé'));
    const file = storage.resolveProjectFile(projectId, brollFile(candidate));
    const pending = inFlight.get(file);
    if (pending !== undefined) return pending.promise;

    const controller = new AbortController();
    const promise = prepare(projectId, candidate, file, controller.signal).finally(() => inFlight.delete(file));
    inFlight.set(file, { projectId, controller, promise });
    return promise;
  }

  async function prepare(projectId: string, candidate: BrollCandidate, file: string, signal: AbortSignal): Promise<MediaInfo> {
    const cached = verified.get(file);
    if (cached !== undefined && existsSync(file)) return cached.info;
    verified.delete(file);

    if (existsSync(file)) {
      const known = await inspect(file).catch(() => null);
      if (known !== null) return remember(projectId, file, known);
      await rm(file, { force: true });
    }
    signal.throwIfAborted();
    await mkdir(path.dirname(file), { recursive: true });
    const partial = `${file}.part`;
    try {
      if (candidate.provider === 'simulation') {
        await synthesize(candidate, partial);
      } else {
        await downloadMedia(candidate.downloadUrl, partial, {
          fetch,
          maxBytes: MAX_BROLL_BYTES,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          isAllowedUrl: isPixabayUrl,
          signal,
        });
      }
      const info = await inspect(partial);
      signal.throwIfAborted();
      await rename(partial, file);
      return remember(projectId, file, info);
    } finally {
      await rm(partial, { force: true, maxRetries: 3 });
    }
  }

  function remember(projectId: string, file: string, info: MediaInfo): MediaInfo {
    if (verified.size >= MAX_VERIFIED_ENTRIES) verified.clear();
    verified.set(file, { projectId, info });
    return info;
  }

  /** Vidéo lisible, avec une piste image et au moins la durée minimale d'un B-roll. */
  async function inspect(file: string): Promise<MediaInfo> {
    const probe = await probeVideo(config.binaries.ffprobe, file);
    if (
      probe.video === null ||
      probe.durationSeconds === null ||
      probe.durationSeconds < TIMELINE_RULES.minSegmentSeconds ||
      probe.video.width <= 0 ||
      probe.video.height <= 0
    ) {
      throw new Error("le fichier B-roll n'est pas une vidéo exploitable");
    }
    return { durationSeconds: probe.durationSeconds, width: probe.video.width, height: probe.video.height };
  }

  /** Mode simulation (PROVIDER_MODE=mock) : mire générée localement, aucun accès réseau. */
  async function synthesize(candidate: BrollCandidate, output: string): Promise<void> {
    await runFfmpeg(
      config.binaries.ffmpeg,
      ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${candidate.width}x${candidate.height}:rate=30:duration=${candidate.durationSeconds}`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-f', 'mp4', output],
      SIMULATED_MEDIA_TIMEOUT_MS,
    );
  }

  function prefetch(projectId: string, items: readonly BrollItem[]): void {
    const selected = items
      .filter(isMounted)
      .map((item) => item.candidates.find((candidate) => candidate.id === item.selectedCandidateId))
      .filter((candidate): candidate is BrollCandidate => candidate !== undefined && candidate.provider !== 'simulation');
    if (selected.length === 0 || released.has(projectId)) return;
    const run: Promise<void> = forEachLimited(selected, DOWNLOAD_CONCURRENCY, async (candidate) => {
      if (released.has(projectId)) return;
      try {
        await ensure(projectId, candidate);
      } catch (error) {
        // Sans gravité : l'export retentera et signalera l'erreur s'il le faut.
        if (!released.has(projectId)) logger.warn('broll.prefetch_failed', { projectId, candidateId: candidate.id, err: error });
      }
    }).finally(() => background.delete(run));
    background.add(run);
  }

  async function release(projectId: string): Promise<void> {
    released.add(projectId);
    const tasks = [...inFlight.values()].filter((task) => task.projectId === projectId);
    for (const task of tasks) task.controller.abort();
    await Promise.allSettled(tasks.map((task) => task.promise));
    for (const [file, entry] of verified) if (entry.projectId === projectId) verified.delete(file);
  }

  async function whenIdle(): Promise<void> {
    while (background.size > 0 || inFlight.size > 0) {
      await Promise.allSettled([...background, ...[...inFlight.values()].map((task) => task.promise)]);
    }
  }

  return { ensure, prefetch, release, whenIdle };
}
