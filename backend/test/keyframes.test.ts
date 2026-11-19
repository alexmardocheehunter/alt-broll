import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  KEYFRAME_COUNT,
  chooseKeyframeTimes,
  extractKeyframes,
  parseShowinfoTimes,
  tileSize,
} from '../src/services/keyframes.service.ts';
import { isFfmpegAvailable, makeVideo } from './fixtures.ts';
import { silentLogger } from './helpers.ts';

const ffmpegReady = await isFfmpegAvailable();

describe('choix des images clés', () => {
  it('prend une image par tranche, au milieu sauf changement de scène, sans dépasser la fin', () => {
    const times = chooseKeyframeTimes(12, [4.2], 12);

    assert.equal(times.length, 12);
    assert.equal(times[0], 0.5);
    assert.equal(times[4], 4.3, 'coupe à 4,2 s dans la tranche [4, 5[');
    assert.ok(times.every((time, i) => time >= 0 && time <= 11.95 && (i === 0 || time > (times[i - 1] ?? 0))));
  });

  it('lit les instants des changements de scène dans le journal de showinfo', () => {
    const log = [
      '[Parsed_showinfo_2 @ 0000] n:   0 pts:  12345 pts_time:4.115   duration: 512',
      'autre ligne pts_time:99',
      '[Parsed_showinfo_2 @ 0000] n:   1 pts:  25000 pts_time:8.333333 duration: 512',
    ].join('\n');

    assert.deepEqual(parseShowinfoTimes(log), [4.115, 8.333333]);
  });

  it('garde les proportions de la source dans une vignette de 384 px au plus', () => {
    assert.deepEqual(tileSize(1920, 1080), { width: 384, height: 216 });
    assert.deepEqual(tileSize(1080, 1920), { width: 216, height: 384 });
    assert.deepEqual(tileSize(1280, 1280), { width: 384, height: 384 });
  });
});

describe('planche contact', { skip: ffmpegReady ? false : 'FFmpeg introuvable' }, () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'alt-broll-keyframes-'));
  after(() => rmSync(workDir, { recursive: true, force: true }));

  it('assemble 12 images horodatées en une planche 4 × 3 aux proportions de la vidéo', async () => {
    const source = await makeVideo(workDir, 'source.mp4', { seconds: 6, width: 640, height: 360 });

    const result = await extractKeyframes({
      ffmpegPath: 'ffmpeg',
      fontFile: undefined,
      sourceFile: source,
      durationSeconds: 6,
      width: 640,
      height: 360,
      workDir,
      logger: silentLogger,
    });

    assert.ok(result, 'extraction réussie');
    assert.equal(result.keyframes.length, KEYFRAME_COUNT);
    const dimensions = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', result.contactSheetFile])
      .toString()
      .trim();
    assert.equal(dimensions, '1536,648');
  });

  it("renvoie null au lieu d'échouer si la vidéo est illisible", async () => {
    const result = await extractKeyframes({
      ffmpegPath: 'ffmpeg',
      fontFile: undefined,
      sourceFile: path.join(workDir, 'absente.mp4'),
      durationSeconds: 6,
      width: 640,
      height: 360,
      workDir,
      logger: silentLogger,
    });

    assert.equal(result, null);
  });
});
