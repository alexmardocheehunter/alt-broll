import { createServer } from 'node:http';
import { createApp } from './app.ts';
import { ConfigError, configuredProviders, loadConfig, loadDotEnvFile } from './config/env.ts';
import { openDatabase } from './db/database.ts';
import { createLocalStorage } from './storage/local-storage.ts';
import { probeBinary } from './utils/binaries.ts';
import { createLogger } from './utils/logger.ts';

/** Délai accordé aux requêtes en cours lors d'un arrêt. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const envFile = loadDotEnvFile();
  const config = loadConfig();
  const logger = createLogger(config.logLevel, { service: 'backend' });

  const storage = createLocalStorage(config.paths.storageRoot);
  await storage.ensureBaseDirs();
  try {
    // Au démarrage, aucun envoi n'est en cours : tout fichier temporaire restant est abandonné.
    const removed = await storage.cleanupStaleUploads(0);
    if (removed > 0) logger.info('startup.stale_uploads_removed', { count: removed });
  } catch (error) {
    logger.warn('startup.stale_uploads_cleanup_failed', { err: error });
  }

  const db = openDatabase(config.paths.databasePath);

  const [ffmpeg, ffprobe] = await Promise.all([
    probeBinary(config.binaries.ffmpeg),
    probeBinary(config.binaries.ffprobe),
  ]);
  for (const [binary, status] of [['ffmpeg', ffmpeg], ['ffprobe', ffprobe]] as const) {
    if (!status.available) {
      logger.warn('startup.binary_missing', {
        binary,
        hint: 'Installer FFmpeg ou renseigner FFMPEG_PATH / FFPROBE_PATH dans .env',
      });
    }
  }
  if (config.nodeEnv === 'production' && !(ffmpeg.available && ffprobe.available)) {
    db.close();
    throw new Error('FFmpeg ou ffprobe introuvable : démarrage refusé en production.');
  }

  const app = createApp({ config, logger, db, binaries: { ffmpeg, ffprobe } });
  const server = createServer(app);

  server.on('error', (error: NodeJS.ErrnoException) => {
    logger.error('server.error', {
      err: error,
      hint:
        error.code === 'EADDRINUSE'
          ? `Le port ${config.port} est déjà utilisé : changer PORT dans .env ou arrêter l'autre processus.`
          : undefined,
    });
    db.close();
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    logger.info('server.started', {
      url: `http://${config.host}:${config.port}`,
      nodeEnv: config.nodeEnv,
      envFile: envFile === null ? 'absent : valeurs par défaut' : '.env',
      ffmpeg: ffmpeg.version,
      ffprobe: ffprobe.version,
      providers: configuredProviders(config),
    });
  });

  let stopping = false;
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    logger.info('server.stopping', { signal });
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    server.close(() => {
      db.close();
      logger.info('server.stopped');
      process.exit(0);
    });
    server.closeIdleConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  const message =
    error instanceof ConfigError
      ? error.message
      : `Échec du démarrage du backend : ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
