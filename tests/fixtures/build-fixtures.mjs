#!/usr/bin/env node
/**
 * Génère les fixtures média d'ALT B-ROLL (OpenCode / QA).
 *
 * Toutes les vidéos sont synthétiques (filtres lavfi de FFmpeg) : aucune
 * donnée tierce, aucune vidéo Pixabay, aucun droit à gérer.
 *
 * Usage (depuis tests/) :
 *   npm run fixtures          # ne régénère pas les fichiers existants
 *   npm run fixtures:force    # régénère tout et réécrit le manifeste
 *
 * Prérequis : FFmpeg (PATH ou FFMPEG_PATH) avec libx264, drawtext et aac.
 * Le manifeste media/manifest.json contient taille + SHA-256 de chaque fichier :
 * les tests d'intégrité détectent une fixture remplacée ou modifiée à la main.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HERE = import.meta.dirname;
const MEDIA_DIR = path.join(HERE, 'media');
const FORCE = process.argv.includes('--force');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

/** Polices candidates, par ordre de préférence (copiée localement : pas de « C: » dans le filtre). */
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/arial.ttf',
  'C:/Windows/Fonts/segoeui.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
];

const workDir = mkdtempSync(path.join(tmpdir(), 'alt-broll-fixtures-'));
const fontFile = findFont();
process.on('exit', () => rmSync(workDir, { recursive: true, force: true }));

function findFont() {
  for (const candidate of FONT_CANDIDATES) {
    if (existsSync(candidate)) {
      copyFileSync(candidate, path.join(workDir, 'font.ttf'));
      return 'font.ttf';
    }
  }
  console.warn('[fixtures] Aucune police trouvée : les vidéos seront générées sans incrustation de texte.');
  return null;
}

function ffmpeg(args, label) {
  // cwd = workDir : le chemin de police reste relatif, sans « : » à échapper.
  const result = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    cwd: workDir,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (result.error) throw new Error(`${label} : FFmpeg introuvable (${result.error.message})`);
  if (result.status !== 0) throw new Error(`${label} : FFmpeg a échoué (code ${result.status}).`);
  console.log(`[fixtures] ${label} : OK`);
}

function text(textValue, { size = 26, x = 24, y = 24 } = {}) {
  return fontFile === null
    ? null
    : `drawtext=fontfile=${fontFile}:text='${textValue}':x=${x}:y=${y}:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=8`;
}

function filter(...parts) {
  return parts.filter((part) => part !== null).join(',');
}

const OUT = (name) => path.join(MEDIA_DIR, name);
const exists = (name) => existsSync(OUT(name));

function encode(name, args, label) {
  if (!FORCE && exists(name)) {
    console.log(`[fixtures] ${label} : déjà présent (ignoré, --force pour régénérer).`);
    return;
  }
  ffmpeg([...args, OUT(name)], label);
}

mkdirSync(MEDIA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 1. Vidéo source de référence : 30 s, 640 × 360, 30 i/s, audio AAC.
//    Chaque image est numérotée (« SOURCE n ») pour vérifier un rendu à l'œil.
// ---------------------------------------------------------------------------
encode(
  'source-30s.mp4',
  [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=30',
    '-vf', filter(text('SOURCE %{n}'), text('ALT B-ROLL - FIXTURE 30 S', { size: 18, x: 24, y: 330 })),
    '-af', 'volume=0.12',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-g', '60', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-ar', '48000',
    '-movflags', '+faststart', '-shortest',
  ],
  'source-30s.mp4',
);

// ---------------------------------------------------------------------------
// 2. Source avec métadonnée de rotation (vidéo filmée « verticale ») :
//    640 × 360 codé + rotation 90° => 360 × 640 à l'affichage.
//    Le backend doit appliquer la rotation (contrat, SourceVideo.width/height).
// ---------------------------------------------------------------------------
if (FORCE || !exists('source-rotated-10s.mp4')) {
  const base = path.join(workDir, 'rotated-base.mp4');
  ffmpeg(
    [
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=10',
      '-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=48000:duration=10',
      '-vf', filter(text('ROTATED SRC %{n}')),
      '-af', 'volume=0.12',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
      '-shortest', base,
    ],
    'source-rotated-10s (base)',
  );
  ffmpeg(['-display_rotation', '90', '-i', base, '-c', 'copy', '-movflags', '+faststart', OUT('source-rotated-10s.mp4')], 'source-rotated-10s.mp4');
} else {
  console.log('[fixtures] source-rotated-10s.mp4 : déjà présent.');
}

// ---------------------------------------------------------------------------
// 3. B-rolls de test (muets, comme dans le produit).
// ---------------------------------------------------------------------------
encode(
  'broll-city-8s.mp4',
  [
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=8',
    '-vf', filter(text('BROLL CITY %{n}'), text('MOCK - NOT PIXABAY', { size: 16, x: 24, y: 320 })),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-g', '30', '-sc_threshold', '0',
    '-an', '-movflags', '+faststart',
  ],
  'broll-city-8s.mp4',
);

encode(
  'broll-portrait-6s.mp4',
  [
    '-f', 'lavfi', '-i', 'smptebars=size=360x640:rate=30:duration=6',
    '-vf', filter(text('BROLL PORTRAIT %{n}', { size: 20, y: 24 }), text('MOCK - NOT PIXABAY', { size: 14, x: 20, y: 590 })),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-g', '30',
    '-an', '-movflags', '+faststart',
  ],
  'broll-portrait-6s.mp4',
);

encode(
  'broll-short-4s.mp4',
  [
    '-f', 'lavfi', '-i', 'color=c=0x1E90FF:size=640x360:rate=30:duration=4',
    '-vf', filter(text('BROLL SHORT %{n}'), text('MOCK - NOT PIXABAY', { size: 16, x: 24, y: 320 })),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-an', '-movflags', '+faststart',
  ],
  'broll-short-4s.mp4',
);

// ---------------------------------------------------------------------------
// 4. Cas limites d'import.
// ---------------------------------------------------------------------------
encode(
  'no-audio-10s.mp4',
  [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=10',
    '-vf', filter(text('NO AUDIO %{n}')),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-an', '-movflags', '+faststart',
  ],
  'no-audio-10s.mp4',
);

encode(
  'audio-only-10s.mp4',
  [
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=10',
    '-af', 'volume=0.12',
    '-vn', '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-movflags', '+faststart',
  ],
  'audio-only-10s.mp4',
);

encode(
  'too-short-3s.mp4',
  [
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
    '-vf', filter(text('TOO SHORT %{n}', { size: 20 })),
    '-af', 'volume=0.12',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    '-movflags', '+faststart', '-shortest',
  ],
  'too-short-3s.mp4',
);

encode(
  'too-long-181s.mp4',
  [
    '-f', 'lavfi', '-i', 'color=c=gray:size=160x120:rate=5:duration=181',
    '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=22050:duration=181',
    '-af', 'volume=0.1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '24k', '-ac', '1',
    '-movflags', '+faststart', '-shortest',
  ],
  'too-long-181s.mp4',
);

// Fichiers volontairement invalides (générés, pas binaires versionnés à la main).
if (FORCE || !exists('truncated.mp4')) {
  const source = readFileSync(OUT('source-30s.mp4'));
  writeFileSync(OUT('truncated.mp4'), source.subarray(0, 4096));
  console.log('[fixtures] truncated.mp4 : OK (4 Kio de source-30s.mp4)');
} else {
  console.log('[fixtures] truncated.mp4 : déjà présent.');
}
if (FORCE || !exists('not-a-video.mp4')) {
  writeFileSync(
    OUT('not-a-video.mp4'),
    'Ceci est un fichier texte renommé en .mp4 : il ne contient aucune vidéo.\nALT B-ROLL - fixture QA.\n',
  );
  console.log('[fixtures] not-a-video.mp4 : OK (texte brut)');
} else {
  console.log('[fixtures] not-a-video.mp4 : déjà présent.');
}

// ---------------------------------------------------------------------------
// 5. Manifeste d'intégrité.
// ---------------------------------------------------------------------------
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const files = readdirSync(MEDIA_DIR)
  .filter((name) => name.endsWith('.mp4'))
  .sort()
  .map((name) => {
    const file = path.join(MEDIA_DIR, name);
    const sizeBytes = statSync(file).size;
    // Les fichiers tronqués ne dépassent pas 4 Kio : aucun besoin de les alléger.
    truncateSync(file, sizeBytes);
    return { name, sizeBytes, sha256: sha256(file) };
  });

const manifest = {
  note: 'Fixtures synthétiques générées par tests/fixtures/build-fixtures.mjs (FFmpeg lavfi). Aucune donnée tierce.',
  generatedBy: 'tests/fixtures/build-fixtures.mjs',
  files,
};
writeFileSync(path.join(MEDIA_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
console.log(`[fixtures] ${files.length} fichiers, ${(total / 1024 / 1024).toFixed(2)} Mio, manifeste écrit.`);
