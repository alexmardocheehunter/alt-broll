import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { RENDER_JOB_RULES, RENDER_JOB_SQL, RENDER_JOBS_TABLE_SQL, type ErrorCode, type RenderJobPayload, type RenderJobRow } from '../../shared/contract.ts';

const root = path.resolve(import.meta.dirname, '../..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* optional in development */ }
const resolveEnvPath = (value: string) => path.isAbsolute(value) ? value : path.resolve(root, value);
const databasePath = process.env.DATABASE_PATH === ':memory:' ? ':memory:' : resolveEnvPath(process.env.DATABASE_PATH ?? './backend/data/alt-broll.sqlite');
const storageRoot = resolveEnvPath(process.env.STORAGE_ROOT ?? './storage');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const maxConcurrent = Math.max(1, Number(process.env.MAX_CONCURRENT_RENDERS || 1));
const workerId = `${process.pid}-${randomUUID()}`;
const leaseMs = RENDER_JOB_RULES.leaseMs;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const dbDir = path.dirname(databasePath);
if (databasePath !== ':memory:') mkdirSync(dbDir, { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
db.exec(RENDER_JOBS_TABLE_SQL);

function now() { return Date.now(); }
function claim(): RenderJobRow | undefined {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(RENDER_JOB_SQL.recoverStale).run({ nowMs: now() });
    const job = db.prepare(RENDER_JOB_SQL.claimNext).get({ workerId, leaseExpiresAtMs: now() + leaseMs, nowMs: now(), maxConcurrentRenders: maxConcurrent }) as RenderJobRow | undefined;
    db.exec('COMMIT');
    return job;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function heartbeat(jobId: string, progress: number): boolean {
  const r = db.prepare(RENDER_JOB_SQL.heartbeat).run({ jobId, workerId, progress: Math.max(0, Math.min(.99, progress)), leaseExpiresAtMs: now() + leaseMs, nowMs: now() });
  return Number(r.changes) === 1;
}
function absolute(projectId: string, relative: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId) || !/^(source|broll|output)\/[A-Za-z0-9_-]{1,64}\.mp4$/.test(relative)) throw new Error('invalid path');
  const base = path.resolve(storageRoot, 'projects', projectId);
  const file = path.resolve(base, relative);
  if (!file.startsWith(base + path.sep)) throw new Error('path escaped project');
  return file;
}
function assertPayload(p: RenderJobPayload) {
  const finite = (n: number) => Number.isFinite(n) && n >= 0;
  if (p.schemaVersion !== 1 || !p.source.audioPresent || p.segments.length < 1 || p.segments.length > 8) throw new Error('invalid job');
  if (![p.source.durationSeconds, p.source.width, p.source.height, p.source.frameRate, p.output.width, p.output.height, p.output.frameRate].every(finite) || p.output.width % 2 || p.output.height % 2) throw new Error('invalid dimensions');
  let previousEnd = 0;
  for (const s of p.segments) {
    if (!finite(s.startSeconds) || !finite(s.endSeconds) || s.startSeconds < previousEnd || s.endSeconds <= s.startSeconds || s.endSeconds > p.source.durationSeconds + 1 / p.output.frameRate || s.endSeconds - s.startSeconds > s.media.durationSeconds + 1 / p.output.frameRate || !['cover','contain'].includes(s.fit)) throw new Error('invalid segments');
    previousEnd = s.endSeconds;
    absolute('x', s.media.file);
  }
  absolute('x', p.source.file); absolute('x', p.output.file);
}
function run(binary: string, args: string[], signal: AbortSignal, durationSeconds: number, onProgress: (progress: number) => void, timeoutMs = 60 * 60_000): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stderr = '';
    let progressOutput = '';
    proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      progressOutput = (progressOutput + chunk).slice(-4096);
      const matches = progressOutput.match(/out_time_ms=(\d+)/g);
      const latest = matches?.at(-1)?.match(/(\d+)$/)?.[1];
      if (latest) onProgress(Number(latest) / 1_000_000 / durationSeconds);
    });
    proc.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-12000); });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stderr }); });
  });
}
async function probe(file: string) {
  return await new Promise<{ duration: number; width: number; height: number; audio: boolean }>((resolve, reject) => {
    const child = spawn(ffprobe, ['-v','error','-show_entries','format=duration:stream=codec_type,width,height','-of','json',file], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let out = ''; child.stdout.setEncoding('utf8').on('data', (x: string) => out += x);
    child.on('error', reject); child.on('close', (code) => {
      try { if (code !== 0) throw Error(); const j = JSON.parse(out); const v = j.streams.find((s: any) => s.codec_type === 'video'); resolve({ duration: Number(j.format.duration), width: v.width, height: v.height, audio: j.streams.some((s: any) => s.codec_type === 'audio') }); } catch { reject(new Error('probe failed')); }
    });
  });
}
const frameTime = (t: number, fps: number) => Math.round(t * fps) / fps;
function renderArgs(p: RenderJobPayload, inputs: string[], temp: string) {
  const fps = p.output.frameRate;
  const args = ['-hide_banner','-y','-i',inputs[0]];
  for (const f of inputs.slice(1)) args.push('-i', f);
  const filters: string[] = [];
  const pieces: string[] = [];
  let cursor = 0;
  p.segments.forEach((s, i) => {
    const start = frameTime(s.startSeconds, fps), end = frameTime(s.endSeconds, fps), dur = end - start;
    if (start > cursor) {
      const label = `src${i}`;
      filters.push(`[0:v]trim=start=${cursor}:end=${start},setpts=PTS-STARTPTS,fps=${fps},scale=${p.output.width}:${p.output.height}:force_original_aspect_ratio=decrease,pad=${p.output.width}:${p.output.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[${label}]`);
      pieces.push(label);
    }
    const media = `m${i}`;
    filters.push(`[${i+1}:v]fps=${fps},scale=${p.output.width}:${p.output.height}:force_original_aspect_ratio=${s.fit === 'cover' ? 'increase' : 'decrease'},${s.fit === 'cover' ? `crop=${p.output.width}:${p.output.height}` : `pad=${p.output.width}:${p.output.height}:(ow-iw)/2:(oh-ih)/2`},setsar=1,trim=duration=${dur},tpad=stop_mode=clone:stop_duration=${dur},trim=duration=${dur},setpts=PTS-STARTPTS,format=yuv420p[${media}]`);
    pieces.push(media); cursor = end;
  });
  if (cursor < p.source.durationSeconds) {
    filters.push(`[0:v]trim=start=${cursor}:end=${p.source.durationSeconds},setpts=PTS-STARTPTS,fps=${fps},scale=${p.output.width}:${p.output.height}:force_original_aspect_ratio=decrease,pad=${p.output.width}:${p.output.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[srcend]`);
    pieces.push('srcend');
  }
  if (pieces.length === 1) filters.push(`[${pieces[0]}]null[vout]`);
  else filters.push(`${pieces.map(x => `[${x}]`).join('')}concat=n=${pieces.length}:v=1:a=0[vout]`);
  args.push('-filter_complex', filters.join(';'), '-map','[vout]','-map','0:a:0','-c:v','libx264','-preset','veryfast','-crf','21','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-t',String(p.source.durationSeconds),'-movflags','+faststart',temp);
  return args;
}
async function processJob(row: RenderJobRow) {
  let outputTemp = '';
  let progress = 0;
  const controller = new AbortController();
  const timer = setInterval(() => {
    try {
      if (!heartbeat(row.id, progress)) {
        console.error('Job ownership lost; stopping', row.id);
        controller.abort(new Error('lease lost'));
      }
    } catch (error) { console.error('Heartbeat failed; stopping', row.id, error); controller.abort(error); }
  }, RENDER_JOB_RULES.heartbeatMs);
  try {
    const payload: RenderJobPayload = JSON.parse(row.payload); assertPayload(payload);
    const source = absolute(row.project_id, payload.source.file), dest = absolute(row.project_id, payload.output.file);
    outputTemp = dest.replace(/\.mp4$/, `.${row.id}.tmp.mp4`); mkdirSync(path.dirname(dest), { recursive: true });
    if (!existsSync(source)) throw Object.assign(new Error('missing source'), { code: 'RENDER_INPUT_MISSING' });
    const sourceProbe = await probe(source); if (!sourceProbe.audio || Math.abs(sourceProbe.duration - payload.source.durationSeconds) > 2) throw Object.assign(new Error('bad source'), { code: 'RENDER_INPUT_MISSING' });
    const media = payload.segments.map(s => absolute(row.project_id, s.media.file));
    if (media.some(f => !existsSync(f))) throw Object.assign(new Error('missing media'), { code: 'RENDER_INPUT_MISSING' });
    for (const f of media) await probe(f);
    const args = renderArgs(payload, [source, ...media], outputTemp);
    args.splice(1, 0, '-nostats', '-progress', 'pipe:1');
    const result = await run(ffmpeg, args, controller.signal, payload.source.durationSeconds, (value) => { progress = Math.max(progress, Math.min(.99, value)); });
    if (result.code !== 0) { console.error('FFmpeg failed', row.id, result.stderr); throw Object.assign(new Error('encode failed'), { code: 'RENDER_FFMPEG_FAILED' }); }
    const checked = await probe(outputTemp);
    if (!checked.audio || checked.width !== payload.output.width || checked.height !== payload.output.height || Math.abs(checked.duration - payload.source.durationSeconds) > 1 / payload.output.frameRate + .05) throw Object.assign(new Error('invalid output'), { code: 'RENDER_OUTPUT_INVALID' });
    const { renameSync, statSync } = await import('node:fs'); renameSync(outputTemp, dest);
    const update = db.prepare(RENDER_JOB_SQL.complete).run({ jobId: row.id, workerId, outputSizeBytes: statSync(dest).size, outputDurationSeconds: checked.duration, nowMs: now() });
    if (Number(update.changes) !== 1) console.error('Completion rejected; lease lost', row.id);
  } catch (e: any) {
    if (controller.signal.aborted && controller.signal.reason?.message === 'lease lost') return;
    const code: ErrorCode = ['RENDER_INPUT_MISSING','RENDER_FFMPEG_FAILED','RENDER_OUTPUT_INVALID','RENDER_TIMEOUT'].includes(e?.code) ? e.code : e?.message === 'timeout' ? 'RENDER_TIMEOUT' : e?.code === 'ENOENT' ? 'RENDER_FFMPEG_FAILED' : 'RENDER_INVALID_JOB';
    console.error('Render job failed', row.id, e);
    db.prepare(RENDER_JOB_SQL.fail).run({ jobId: row.id, workerId, errorCode: code, errorMessage: code === 'RENDER_FFMPEG_FAILED' ? 'Le rendu vidéo a échoué.' : code === 'RENDER_INPUT_MISSING' ? 'Un fichier nécessaire au rendu est introuvable ou invalide.' : code === 'RENDER_TIMEOUT' ? 'Le rendu a dépassé le délai autorisé.' : 'Les données du rendu sont invalides.', nowMs: now() });
  } finally { clearInterval(timer); if (outputTemp) { try { const { unlinkSync } = await import('node:fs'); unlinkSync(outputTemp); } catch { /* absent */ } } }
}
let stopping = false;
const once = process.argv.includes('--once');
process.on('SIGINT', () => { stopping = true; }); process.on('SIGTERM', () => { stopping = true; });
console.log(`ALT B-ROLL renderer started (${workerId})`);
while (!stopping) {
  const job = claim();
  if (job) {
    await processJob(job);
    if (once) break;
  } else if (once) break;
  else await sleep(1000);
}
db.close();
