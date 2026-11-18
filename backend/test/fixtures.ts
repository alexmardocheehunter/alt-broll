import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { probeBinary } from '../src/utils/binaries.ts';

const run = promisify(execFile);

export interface VideoFixtureOptions {
  readonly seconds: number;
  readonly width?: number;
  readonly height?: number;
  readonly fps?: number;
  readonly audio?: boolean;
  readonly codec?: 'libx264' | 'libx265';
}

export async function isFfmpegAvailable(): Promise<boolean> {
  const [ffmpeg, ffprobe] = await Promise.all([probeBinary('ffmpeg'), probeBinary('ffprobe')]);
  return ffmpeg.available && ffprobe.available;
}

/** Vidéo synthétique (mire + bip 440 Hz) générée par FFmpeg : aucun média tiers, aucun droit à gérer. */
export async function makeVideo(dir: string, name: string, options: VideoFixtureOptions): Promise<string> {
  const { seconds, width = 320, height = 240, fps = 30, audio = true, codec = 'libx264' } = options;
  const output = path.join(dir, name);
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=${fps}:duration=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${seconds}`);
  args.push('-c:v', codec, '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (codec === 'libx265') args.push('-x265-params', 'log-level=error', '-tag:v', 'hvc1');
  if (audio) args.push('-c:a', 'aac', '-b:a', '64k');
  else args.push('-an');
  args.push(output);
  await run('ffmpeg', args, { windowsHide: true });
  return output;
}

/** Copie de `input` portant une rotation d'affichage, comme une vidéo de téléphone tenu verticalement. */
export async function withRotation(input: string, output: string, degrees: number): Promise<string> {
  await run(
    'ffmpeg',
    ['-y', '-v', 'error', '-display_rotation:v:0', String(degrees), '-i', input, '-c', 'copy', output],
    { windowsHide: true },
  );
  return output;
}
