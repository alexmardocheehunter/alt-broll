import { execFile } from 'node:child_process';
import { z } from 'zod';

const FFPROBE_TIMEOUT_MS = 20_000;
const FFPROBE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_DETAIL_LENGTH = 500;

export interface VideoStreamInfo {
  readonly codec: string;
  /** Dimensions d'affichage : rotation des métadonnées appliquée. */
  readonly width: number;
  readonly height: number;
  /** 0 si ffprobe ne donne aucune cadence exploitable. */
  readonly frameRate: number;
}

export interface VideoProbe {
  /** Formats reconnus par ffprobe, ex. "mov,mp4,m4a,3gp,3g2,mj2". */
  readonly formatName: string;
  readonly durationSeconds: number | null;
  /** Première piste vidéo, hors pochette d'album. */
  readonly video: VideoStreamInfo | null;
  readonly audio: { readonly codec: string } | null;
}

/** ffprobe absent ou non exécutable : problème d'installation du serveur. */
export class FfprobeUnavailableError extends Error {
  constructor(command: string, options?: ErrorOptions) {
    super(`ffprobe introuvable (${command}).`, options);
    this.name = 'FfprobeUnavailableError';
  }
}

/** ffprobe n'a pas pu lire le fichier (fichier endommagé ou non vidéo). */
export class FfprobeFailedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FfprobeFailedError';
  }
}

/** Lit les métadonnées d'un fichier local, sans shell et en refusant tout protocole autre que « file ». */
export async function probeVideo(ffprobePath: string, filePath: string): Promise<VideoProbe> {
  const stdout = await runFfprobe(ffprobePath, [
    '-v',
    'error',
    '-protocol_whitelist',
    'file',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-i',
    filePath,
  ]);

  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch (error) {
    throw new FfprobeFailedError('Sortie ffprobe illisible.', { cause: error });
  }
  try {
    return interpretProbeOutput(raw);
  } catch (error) {
    throw new FfprobeFailedError('Sortie ffprobe inattendue.', { cause: error });
  }
}

const streamSchema = z.object({
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  duration: z.string().optional(),
  disposition: z.object({ attached_pic: z.number().optional() }).optional(),
  tags: z.record(z.string(), z.unknown()).optional(),
  side_data_list: z.array(z.object({ rotation: z.union([z.number(), z.string()]).optional() })).optional(),
});
type ProbeStream = z.infer<typeof streamSchema>;

const outputSchema = z.object({
  streams: z.array(streamSchema).default([]),
  format: z.object({ format_name: z.string().optional(), duration: z.string().optional() }).optional(),
});

/** Interprète la sortie JSON de ffprobe (fonction pure, testable sans FFmpeg). */
export function interpretProbeOutput(raw: unknown): VideoProbe {
  const { streams, format } = outputSchema.parse(raw);
  const videoStream = streams.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
  const audioStream = streams.find((stream) => stream.codec_type === 'audio');

  return {
    formatName: format?.format_name ?? '',
    durationSeconds: parsePositive(format?.duration) ?? parsePositive(videoStream?.duration),
    video: videoStream === undefined ? null : toVideoInfo(videoStream),
    audio: audioStream === undefined ? null : { codec: audioStream.codec_name ?? 'inconnu' },
  };
}

/** "30000/1001" → 29.97 ; "0/0" ou valeur invalide → null. */
export function parseFrameRate(value: string | undefined): number | null {
  if (value === undefined) return null;
  const [numerator, denominator = '1'] = value.split('/');
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? roundToMillis(rate) : null;
}

function toVideoInfo(stream: ProbeStream): VideoStreamInfo {
  const width = stream.width ?? 0;
  const height = stream.height ?? 0;
  const quarterTurn = Math.abs(readRotation(stream)) % 180 === 90;
  return {
    codec: stream.codec_name ?? 'inconnu',
    width: quarterTurn ? height : width,
    height: quarterTurn ? width : height,
    frameRate: parseFrameRate(stream.avg_frame_rate) ?? parseFrameRate(stream.r_frame_rate) ?? 0,
  };
}

/** Rotation en degrés : matrice d'affichage (FFmpeg récent) ou ancienne étiquette « rotate ». */
function readRotation(stream: ProbeStream): number {
  for (const sideData of stream.side_data_list ?? []) {
    if (sideData.rotation === undefined) continue;
    const rotation = Number(sideData.rotation);
    if (Number.isFinite(rotation)) return rotation;
  }
  const tag = Number(stream.tags?.rotate);
  return Number.isFinite(tag) ? tag : 0;
}

function parsePositive(value: string | undefined): number | null {
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? roundToMillis(number) : null;
}

function roundToMillis(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function runFfprobe(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: FFPROBE_MAX_OUTPUT_BYTES, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new FfprobeUnavailableError(command, { cause: error }));
          return;
        }
        const detail = stderr.trim().slice(0, MAX_ERROR_DETAIL_LENGTH) || error.message;
        reject(new FfprobeFailedError(detail, { cause: error }));
      },
    );
  });
}
