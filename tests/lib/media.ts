import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { MANIFEST_PATH } from './paths.ts';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export interface ProbeStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  duration?: string;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
  tags?: Record<string, string>;
}

export interface ProbeResult {
  streams: ProbeStream[];
  format: {
    duration?: string;
    size?: string;
    format_name?: string;
    tags?: Record<string, string>;
  };
}

function run(command: string, args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

export function ffmpegAvailable(): boolean {
  return run(FFMPEG, ['-version']).ok;
}

export function ffprobeAvailable(): boolean {
  return run(FFPROBE, ['-version']).ok;
}

/** ffprobe -show_streams -show_format ; null si le fichier est illisible. */
export function probeMedia(file: string): ProbeResult | null {
  const result = run(FFPROBE, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout) as ProbeResult;
    if (!Array.isArray(parsed.streams) || typeof parsed.format !== 'object' || parsed.format === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function formatDuration(probe: ProbeResult): number | null {
  const value = probe.format.duration;
  if (value === undefined) return null;
  const duration = Number(value);
  return Number.isFinite(duration) ? duration : null;
}

export function streamDuration(stream: ProbeStream): number | null {
  if (stream.duration === undefined) return null;
  const duration = Number(stream.duration);
  return Number.isFinite(duration) ? duration : null;
}

export function frameRate(probe: ProbeResult): number | null {
  const stream = videoStream(probe);
  if (stream?.avg_frame_rate === undefined) return null;
  const [numerator, denominator = '1'] = stream.avg_frame_rate.split('/');
  const fps = Number(numerator) / Number(denominator);
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

export function videoStream(probe: ProbeResult): ProbeStream | null {
  return probe.streams.find((stream) => stream.codec_type === 'video') ?? null;
}

export function audioStream(probe: ProbeResult): ProbeStream | null {
  return probe.streams.find((stream) => stream.codec_type === 'audio') ?? null;
}

/** Rotation lue dans les side_data de la piste vidéo (degrés, peut être négative). */
export function rotationDegrees(stream: ProbeStream | null): number {
  if (stream === null) return 0;
  for (const sideData of stream.side_data_list ?? []) {
    if (typeof sideData.rotation === 'number' && Number.isFinite(sideData.rotation)) {
      return sideData.rotation;
    }
  }
  const tag = stream.tags?.rotate;
  if (typeof tag === 'string') {
    const value = Number(tag);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

/** Dimensions d'affichage : rotation de 90/270 appliquée (comme le fera le backend). */
export function displayDimensions(stream: ProbeStream | null): { width: number; height: number } | null {
  if (stream === null || typeof stream.width !== 'number' || typeof stream.height !== 'number') return null;
  const rotation = Math.abs(rotationDegrees(stream)) % 180;
  return rotation === 90 ? { width: stream.height, height: stream.width } : { width: stream.width, height: stream.height };
}

/**
 * Empreinte MD5 d'une image à un instant donné. Permet de prouver que deux
 * fixtures sont visuellement distinctes (indépendamment d'une comparaison
 * perceptuelle après réencodage, laissée aux tests du renderer).
 */
export function frameHash(file: string, atSeconds: number): string | null {
  const result = run(FFMPEG, [
    '-v',
    'error',
    '-ss',
    atSeconds.toFixed(3),
    '-i',
    file,
    '-frames:v',
    '1',
    '-f',
    'md5',
    '-',
  ]);
  if (!result.ok) return null;
  const match = /MD5=([0-9a-f]{32})/i.exec(result.stdout);
  return match?.[1]?.toLowerCase() ?? null;
}

export interface ManifestEntry {
  name: string;
  sizeBytes: number;
  sha256: string;
}

export interface FixtureManifest {
  note: string;
  generatedBy: string;
  files: ManifestEntry[];
}

export function readManifest(): FixtureManifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;
}
