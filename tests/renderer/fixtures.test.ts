import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  audioStream,
  displayDimensions,
  ffmpegAvailable,
  ffprobeAvailable,
  formatDuration,
  frameHash,
  frameRate,
  probeMedia,
  readManifest,
  rotationDegrees,
  videoStream,
  type ProbeResult,
} from '../lib/media.ts';
import { jobFixturePath, mediaPath, MEDIA_DIR, projectFixturePath } from '../lib/paths.ts';

/*
 * Fixtures média : intégrité, nature synthétique et cohérence avec les JSON.
 *
 * Ces tests vérifient que les fichiers binaires livrés dans tests/fixtures/
 * sont bien ceux décrits par le manifeste (SHA-256), qu'ils contiennent les
 * caractéristiques attendues (durée, dimensions, rotation, audio) et que les
 * fixtures JSON ne désignent aucun média absent. Aucun réseau, aucune API.
 */

const toolsAvailable = ffmpegAvailable() && ffprobeAvailable();
const skipReason = toolsAvailable
  ? false
  : 'FFmpeg/ffprobe introuvables : installer FFmpeg ou renseigner FFMPEG_PATH/FFPROBE_PATH.';

function probe(name: string): ProbeResult {
  const result = probeMedia(mediaPath(name));
  assert.ok(result, `ffprobe n’a pas pu lire la fixture « ${name} »`);
  return result;
}

function durationOf(name: string): number {
  const duration = formatDuration(probe(name));
  assert.ok(duration !== null, `durée absente pour « ${name} »`);
  return duration;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

describe('fixtures média : manifeste et intégrité', () => {
  it('le manifeste décrit tous les MP4 présents, sans fichier orphelin', () => {
    const manifest = readManifest();
    assert.ok(manifest.files.length >= 11, `fixtures manquantes : ${manifest.files.length}`);
    assert.match(manifest.note, /synthétiques/i);
    assert.match(manifest.note, /aucune donnée tierce/i);
    assert.equal(manifest.generatedBy, 'tests/fixtures/build-fixtures.mjs');

    const described = new Set(manifest.files.map((entry) => entry.name));
    const present = readdirSync(MEDIA_DIR)
      .filter((name) => name.endsWith('.mp4'))
      .sort();
    assert.deepEqual([...described].sort(), present, 'un MP4 présent n’est pas décrit par le manifeste (ou inversement)');

    const totalBytes = manifest.files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    assert.ok(totalBytes < 10 * 1024 * 1024, `fixtures trop lourdes : ${(totalBytes / 1024 / 1024).toFixed(2)} Mio`);
  });

  it('chaque fichier correspond à sa taille et à son SHA-256', () => {
    for (const entry of readManifest().files) {
      assert.doesNotMatch(entry.name, /[\\/]|\.\./, `nom de fixture suspect : ${entry.name}`);
      const file = mediaPath(entry.name);
      assert.ok(existsSync(file), `fixture absente : ${entry.name}`);
      assert.equal(statSync(file).size, entry.sizeBytes, `taille modifiée : ${entry.name}`);
      assert.match(entry.sha256, /^[0-9a-f]{64}$/);
      assert.equal(sha256(file), entry.sha256, `empreinte modifiée : ${entry.name}`);
    }
  });

  it('les MP4 ne sont pas des médias Pixabay : URLs et métadonnées restent locales', () => {
    for (const entry of readManifest().files) {
      const text = readFileSync(mediaPath(entry.name)).subarray(0, 4096).toString('latin1');
      assert.doesNotMatch(text, /pixabay/i, `métadonnée Pixabay inattendue dans ${entry.name}`);
    }
  });
});

describe('fixtures média : caractéristiques réelles', { skip: skipReason }, () => {
  it('source-30s : 30 s, 640 × 360, 30 i/s, H.264 + AAC', () => {
    const source = probe('source-30s.mp4');
    assert.ok(Math.abs(durationOf('source-30s.mp4') - 30) < 0.1);
    const video = videoStream(source);
    assert.ok(video);
    assert.equal(displayDimensions(video)?.width, 640);
    assert.equal(displayDimensions(video)?.height, 360);
    assert.equal(video.codec_name, 'h264');
    const fps = frameRate(source);
    assert.ok(fps !== null && Math.abs(fps - 30) < 0.01, `30 i/s attendu, reçu ${String(fps)}`);
    const audio = audioStream(source);
    assert.ok(audio, 'la source de référence doit avoir une piste audio');
    assert.equal(audio.codec_name, 'aac');
  });

  it('source-rotated-10s : rotation 90° et dimensions d’affichage 360 × 640', () => {
    const source = probe('source-rotated-10s.mp4');
    const video = videoStream(source);
    assert.ok(video);
    assert.equal(video.width, 640, 'dimensions codées attendues');
    assert.equal(video.height, 360);
    assert.equal(Math.abs(rotationDegrees(video)), 90, 'métadonnée de rotation absente');
    assert.deepEqual(displayDimensions(video), { width: 360, height: 640 });
    assert.ok(Math.abs(durationOf('source-rotated-10s.mp4') - 10) < 0.1);
    assert.ok(audioStream(source), 'la source verticale doit avoir une piste audio');
  });

  it('les B-rolls sont muets, comme dans le produit', () => {
    for (const [name, seconds, width, height] of [
      ['broll-city-8s.mp4', 8, 640, 360],
      ['broll-portrait-6s.mp4', 6, 360, 640],
      ['broll-short-4s.mp4', 4, 640, 360],
    ] as const) {
      const media = probe(name);
      assert.ok(Math.abs(durationOf(name) - seconds) < 0.1, `${name} : durée ${seconds} s attendue`);
      assert.deepEqual(displayDimensions(videoStream(media)), { width, height }, `${name} : dimensions`);
      assert.equal(audioStream(media), null, `${name} : aucune piste audio attendue`);
    }
  });

  it('no-audio-10s n’a pas d’audio et audio-only-10s n’a pas de vidéo', () => {
    const silent = probe('no-audio-10s.mp4');
    assert.ok(videoStream(silent));
    assert.equal(audioStream(silent), null);
    assert.equal(displayDimensions(videoStream(silent))?.width, 640);

    const audioOnly = probe('audio-only-10s.mp4');
    assert.equal(videoStream(audioOnly), null);
    assert.ok(audioStream(audioOnly), 'audio-only doit conserver une piste audio');
    assert.ok(Math.abs(durationOf('audio-only-10s.mp4') - 10) < 0.1);
  });

  it('too-short-3s et too-long-181s encadrent les limites 5 s / 180 s', () => {
    assert.ok(durationOf('too-short-3s.mp4') < 5);
    assert.ok(durationOf('too-long-181s.mp4') > 180);
    assert.ok(durationOf('too-long-181s.mp4') < 182);
  });

  it('truncated.mp4 et not-a-video.mp4 sont illisibles par ffprobe', () => {
    assert.equal(probeMedia(mediaPath('truncated.mp4')), null);
    assert.equal(probeMedia(mediaPath('not-a-video.mp4')), null);
  });

  it('les images des fixtures animées sont réellement différentes', () => {
    const sourceDebut = frameHash(mediaPath('source-30s.mp4'), 1);
    const sourceMilieu = frameHash(mediaPath('source-30s.mp4'), 5);
    assert.ok(sourceDebut && sourceMilieu, 'empreintes d’images non calculées');
    assert.notEqual(sourceDebut, sourceMilieu, 'source-30s semble figée');

    const cityDebut = frameHash(mediaPath('broll-city-8s.mp4'), 1);
    const cityMilieu = frameHash(mediaPath('broll-city-8s.mp4'), 3.5);
    assert.ok(cityDebut && cityMilieu);
    assert.notEqual(cityDebut, cityMilieu, 'broll-city-8s semble figé');
  });
});

describe('fixtures JSON : cohérence avec les médias réels', { skip: skipReason }, () => {
  it('le projet de fixture décrit exactement source-30s.mp4', () => {
    const body = readJson<{
      project: {
        source: {
          storedFileName: string;
          sizeBytes: number;
          durationSeconds: number;
          width: number;
          height: number;
          frameRate: number;
          audioPresent: boolean;
          audioCodec: string | null;
        };
      };
    }>(projectFixturePath('project.fixture.json'));

    const source = body.project.source;
    const manifest = readManifest().files.find((entry) => entry.name === source.storedFileName);
    assert.ok(manifest, 'la source du projet ne correspond à aucune fixture');
    assert.equal(source.sizeBytes, manifest.sizeBytes);

    const media = probe(source.storedFileName);
    assert.ok(Math.abs((formatDuration(media) ?? 0) - source.durationSeconds) < 0.1);
    assert.deepEqual(displayDimensions(videoStream(media)), { width: source.width, height: source.height });
    const fps = frameRate(media);
    assert.ok(fps !== null && Math.abs(fps - source.frameRate) < 0.01);
    assert.equal(source.audioPresent, audioStream(media) !== null);
    assert.equal(source.audioCodec, audioStream(media)?.codec_name ?? null);
  });

  it('chaque candidat de la fixture pointe un média local existant (ou une vignette)', () => {
    const body = readJson<{
      project: {
        brollItems: Array<{
          candidates: Array<{ previewUrl: string; downloadUrl: string; thumbnailUrl: string | null }>;
        }>;
      };
    }>(projectFixturePath('project.fixture.json'));

    const candidates = body.project.brollItems.flatMap((item) => item.candidates);
    assert.ok(candidates.length > 0);
    for (const candidate of candidates) {
      for (const url of [candidate.previewUrl, candidate.downloadUrl]) {
        const parsed = new URL(url);
        assert.equal(parsed.hostname, 'example.com', `URL de fixture non fictive : ${url}`);
        const name = decodeURIComponent(path.posix.basename(parsed.pathname));
        assert.ok(existsSync(mediaPath(name)), `média de fixture absent : ${name}`);
      }
      if (candidate.thumbnailUrl !== null) {
        assert.equal(new URL(candidate.thumbnailUrl).hostname, 'example.com');
      }
    }
  });

  it('les jobs de rendu pointent des médias locaux assez longs et des sorties valides', () => {
    for (const jobName of ['render-job.payload.landscape.json', 'render-job.payload.portrait.json']) {
      const payload = readJson<{
        source: { file: string; durationSeconds: number; width: number; height: number; frameRate: number };
        output: { file: string; width: number; height: number; frameRate: number };
        segments: Array<{
          startSeconds: number;
          endSeconds: number;
          media: { file: string; durationSeconds: number; width: number; height: number };
        }>;
      }>(jobFixturePath(jobName));

      for (const relative of [payload.source.file, payload.output.file, ...payload.segments.map((segment) => segment.media.file)]) {
        assert.doesNotMatch(relative, /^[A-Za-z]:|^\//, `${jobName} : chemin absolu interdit (${relative})`);
      }

      const sourceName = path.posix.basename(payload.source.file);
      const source = probe(sourceName);
      const sourceDuration = formatDuration(source);
      assert.ok(sourceDuration !== null && Math.abs(sourceDuration - payload.source.durationSeconds) < 0.1, `${jobName} : durée source`);
      assert.deepEqual(displayDimensions(videoStream(source)), {
        width: payload.source.width,
        height: payload.source.height,
      });
      const sourceFps = frameRate(source);
      assert.ok(sourceFps !== null && Math.abs(sourceFps - payload.source.frameRate) < 0.01);

      assert.equal(payload.output.width % 2, 0, `${jobName} : largeur impaire`);
      assert.equal(payload.output.height % 2, 0, `${jobName} : hauteur impaire`);
      assert.ok(Math.min(payload.output.width, payload.output.height) <= 1080);
      assert.ok(
        Math.abs(payload.output.width / payload.output.height - payload.source.width / payload.source.height) < 0.01,
        `${jobName} : ratio de sortie différent de la source`,
      );
      assert.ok(Math.abs(payload.output.frameRate - Math.min(payload.source.frameRate, 60)) < 0.001);

      for (const segment of payload.segments) {
        const mediaName = path.posix.basename(segment.media.file);
        const media = probe(mediaName);
        const mediaDuration = formatDuration(media);
        assert.ok(mediaDuration !== null);
        assert.ok(Math.abs(mediaDuration - segment.media.durationSeconds) < 0.1, `${jobName}/${mediaName} : durée déclarée`);
        assert.deepEqual(displayDimensions(videoStream(media)), {
          width: segment.media.width,
          height: segment.media.height,
        });
        const segmentDuration = segment.endSeconds - segment.startSeconds;
        assert.ok(segmentDuration <= segment.media.durationSeconds + 0.05, `${jobName}/${mediaName} : segment trop long`);
      }
    }
  });

  it('aucune fixture JSON ne contient de chemin absolu ni de clé API', () => {
    for (const file of [projectFixturePath('project.fixture.json'), jobFixturePath('render-job.payload.landscape.json'), jobFixturePath('render-job.payload.portrait.json')]) {
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /[A-Za-z]:\\|\/home\/|\/Users\//);
      assert.doesNotMatch(text, /gsk_[A-Za-z0-9]{8,}|sk-or-v1-[A-Za-z0-9]{8,}/);
    }
  });
});
