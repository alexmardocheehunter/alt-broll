import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Keyframe } from '../contract.ts';
import { runFfmpeg } from '../media/ffmpeg.ts';
import type { Logger } from '../utils/logger.ts';

export const KEYFRAME_COUNT = 12;
const SHEET_COLUMNS = 4;
const SHEET_ROWS = 3;
/** Plus grand côté d'une vignette : planche de 1536 × 648 pour une vidéo 16:9. */
const TILE_BOX = 384;
const SCENE_THRESHOLD = 0.3;
const SCENE_TIMEOUT_MS = 60_000;
const FRAME_TIMEOUT_MS = 20_000;
const SHEET_TIMEOUT_MS = 30_000;

/** Polices courantes pour inscrire l'instant sur chaque vignette (FFMPEG_FONT_FILE pour en imposer une). */
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/arial.ttf',
  'C:/Windows/Fonts/segoeui.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
] as const;

export interface KeyframeExtraction {
  readonly keyframes: Keyframe[];
  readonly contactSheetFile: string;
}

export interface ExtractKeyframesOptions {
  readonly ffmpegPath: string;
  readonly fontFile: string | undefined;
  readonly sourceFile: string;
  readonly durationSeconds: number;
  /** Dimensions d'affichage de la source. */
  readonly width: number;
  readonly height: number;
  readonly workDir: string;
  readonly logger: Logger;
}

interface TileSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Douze images, une par tranche de la vidéo (un changement de scène est préféré au
 * milieu de la tranche), assemblées en planche contact 4 × 3 horodatée.
 * null si l'extraction échoue : l'analyse se fait alors sur le texte seul.
 */
export async function extractKeyframes(options: ExtractKeyframesOptions): Promise<KeyframeExtraction | null> {
  const { ffmpegPath, workDir, logger } = options;
  try {
    const sceneTimes = await detectSceneChanges(ffmpegPath, options.sourceFile).catch((error: unknown) => {
      logger.warn('keyframes.scene_detection_failed', { err: error });
      return [];
    });
    const times = chooseKeyframeTimes(options.durationSeconds, sceneTimes, KEYFRAME_COUNT);
    const tile = tileSize(options.width, options.height);
    const font = resolveFontFile(options.fontFile);

    for (const [index, timeSeconds] of times.entries()) {
      await extractFrame({ ...options, timeSeconds, tile, font, output: path.join(workDir, frameName(index)) });
    }

    const contactSheetFile = path.join(workDir, 'contact-sheet.jpg');
    await runFfmpeg(
      ffmpegPath,
      ['-y', '-v', 'error', '-framerate', '1', '-i', path.join(workDir, 'frame_%02d.jpg'), '-vf', `tile=${SHEET_COLUMNS}x${SHEET_ROWS}`, '-frames:v', '1', '-q:v', '3', contactSheetFile],
      SHEET_TIMEOUT_MS,
    );
    return { keyframes: times.map((timeSeconds, index) => ({ index, timeSeconds })), contactSheetFile };
  } catch (error) {
    logger.warn('keyframes.failed', { err: error });
    return null;
  }
}

/** Une image par tranche de durée égale : la première coupe de la tranche si elle existe, sinon le milieu. */
export function chooseKeyframeTimes(durationSeconds: number, sceneTimes: readonly number[], count: number): number[] {
  const slot = durationSeconds / count;
  const latest = Math.max(0, durationSeconds - 0.05);
  return Array.from({ length: count }, (_, index) => {
    const slotStart = index * slot;
    const slotEnd = slotStart + slot;
    const cut = sceneTimes.find((time) => time >= slotStart && time < slotEnd);
    // Juste après la coupe pour montrer la nouvelle scène, sans sortir de la tranche.
    const time = cut === undefined ? slotStart + slot / 2 : Math.min(cut + 0.1, slotEnd - 0.05);
    return Math.round(Math.min(Math.max(time, 0), latest) * 1000) / 1000;
  });
}

/** Coupes détectées sur les seules images clés : rapide, imprécis, d'où le complément par tranches. */
export async function detectSceneChanges(ffmpegPath: string, sourceFile: string): Promise<number[]> {
  const log = await runFfmpeg(
    ffmpegPath,
    ['-nostats', '-loglevel', 'info', '-skip_frame', 'nokey', '-protocol_whitelist', 'file', '-i', sourceFile, '-an', '-vf', `scale=160:-2,select='gt(scene,${SCENE_THRESHOLD})',showinfo`, '-f', 'null', '-'],
    SCENE_TIMEOUT_MS,
  );
  return parseShowinfoTimes(log);
}

export function parseShowinfoTimes(log: string): number[] {
  return [...log.matchAll(/Parsed_showinfo[^\n]*?pts_time:\s*([0-9]+(?:\.[0-9]+)?)/g)]
    .map((match) => Number(match[1]))
    .filter((time) => Number.isFinite(time));
}

/** Vignette tenant dans TILE_BOX, proportions de la source, dimensions paires. */
export function tileSize(width: number, height: number): TileSize {
  const scale = TILE_BOX / Math.max(width, height, 1);
  const even = (value: number): number => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(width * scale), height: even(height * scale) };
}

async function extractFrame(options: {
  readonly ffmpegPath: string;
  readonly sourceFile: string;
  readonly timeSeconds: number;
  readonly tile: TileSize;
  readonly font: string | null;
  readonly output: string;
  readonly logger: Logger;
}): Promise<void> {
  const { ffmpegPath, sourceFile, timeSeconds, tile, font, output } = options;
  const fit = [
    `scale=${tile.width}:${tile.height}:force_original_aspect_ratio=decrease`,
    `pad=${tile.width}:${tile.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
  ];
  const fontSize = Math.round(Math.min(tile.width, tile.height) / 10);
  const label =
    font === null
      ? null
      : `drawtext=fontfile='${escapeFilterValue(font)}':text='${timeSeconds.toFixed(1)} s':x=8:y=8:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4`;
  const run = (filters: readonly string[], at: number): Promise<string> =>
    runFfmpeg(
      ffmpegPath,
      ['-y', '-v', 'error', '-ss', at.toFixed(3), '-protocol_whitelist', 'file', '-i', sourceFile, '-frames:v', '1', '-vf', filters.join(','), '-q:v', '4', output],
      FRAME_TIMEOUT_MS,
    );

  if (label !== null) {
    try {
      await run([...fit, label], timeSeconds);
      return;
    } catch (error) {
      // Police inutilisable : vignette sans horodatage ; les instants restent donnés dans le texte envoyé au modèle.
      options.logger.warn('keyframes.label_failed', { err: error });
    }
  }
  try {
    await run(fit, timeSeconds);
  } catch {
    // Piste vidéo un peu plus courte que le conteneur : on recule d'une seconde.
    await run(fit, Math.max(0, timeSeconds - 1));
  }
}

function resolveFontFile(configured: string | undefined): string | null {
  if (configured !== undefined) return existsSync(configured) ? configured : null;
  return FONT_CANDIDATES.find((font) => existsSync(font)) ?? null;
}

/** Chemin utilisable dans un filtre FFmpeg : séparateurs « / », « : » et « ' » échappés. */
function escapeFilterValue(file: string): string {
  return file.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function frameName(index: number): string {
  return `frame_${String(index).padStart(2, '0')}.jpg`;
}
