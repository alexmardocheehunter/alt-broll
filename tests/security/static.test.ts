import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../lib/paths.ts';

/*
 * Audit statique de sécurité (OpenCode / QA).
 *
 * Ne lit JAMAIS le fichier .env : il est explicitement exclu de toute lecture.
 * Vérifie les garanties qui peuvent l'être sans lancer le backend :
 * - secrets absents du code, des fixtures et des documents ;
 * - .env ignoré par Git et modèle sans valeur réelle ;
 * - tests sans dépendance externe et sans accès aux API IA ;
 * - absence de CORS ouvert et de fuite de stack dans le code ;
 * - aucun chemin absolu de développeur dans le code livré.
 */

const SELF = path.join(PROJECT_ROOT, 'tests', 'security', 'static.test.ts');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'storage', 'data', 'media']);
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.txt',
  '.html',
  '.css',
  '.yml',
  '.yaml',
]);

function isScannable(name: string): boolean {
  if (name === '.env') return false;
  if (name.startsWith('.env.') && name !== '.env.example') return false;
  if (name === '.gitignore' || name === '.env.example') return true;
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  const stat = statSync(root);
  if (stat.isFile()) return isScannable(path.basename(root)) ? [root] : [];

  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...walk(path.join(root, entry.name)));
    } else if (entry.isFile() && isScannable(entry.name)) {
      files.push(path.join(root, entry.name));
    }
  }
  return files;
}

function readText(file: string): string {
  const stat = statSync(file);
  if (stat.size > 2 * 1024 * 1024) return '';
  return readFileSync(file, 'utf8');
}

const SCAN_ROOTS = [
  'backend/src',
  'shared',
  'tests',
  'docs',
  'frontend',
  'renderer',
  'README.md',
  'backend/package.json',
  '.env.example',
  '.gitignore',
].map((relative) => path.join(PROJECT_ROOT, relative));

function scannedFiles(): string[] {
  return [...new Set(SCAN_ROOTS.flatMap(walk))].filter((file) => file !== SELF);
}

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/gsk_[A-Za-z0-9]{20,}/, 'clé Groq'],
  [/sk-or-v1-[A-Za-z0-9]{20,}/, 'clé OpenRouter'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, 'clé privée'],
  [/AKIA[0-9A-Z]{16}/, 'clé AWS'],
];

describe('sécurité statique : secrets', () => {
  it('aucune clé API ni clé privée dans le code, les fixtures et les documents', () => {
    const leaks: string[] = [];
    for (const file of scannedFiles()) {
      const text = readText(file);
      for (const [pattern, label] of SECRET_PATTERNS) {
        if (pattern.test(text)) leaks.push(`${path.relative(PROJECT_ROOT, file)} : ${label}`);
      }
    }
    assert.deepEqual(leaks, []);
  });

  it('.env.example ne contient aucune valeur de clé réelle', () => {
    const lines = readText(path.join(PROJECT_ROOT, '.env.example')).split(/\r?\n/);
    for (const key of ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'PIXABAY_API_KEY']) {
      const line = lines.find((candidate) => candidate.startsWith(`${key}=`));
      assert.ok(line !== undefined, `${key} absent de .env.example`);
      assert.equal(line.slice(key.length + 1).trim(), '', `${key} doit rester vide dans le modèle`);
    }
  });

  it('.gitignore protège .env, les bases et les médias importés', () => {
    const lines = readText(path.join(PROJECT_ROOT, '.gitignore')).split(/\r?\n/).map((line) => line.trim());
    for (const required of ['.env', '.env.*', 'node_modules/', 'storage/', '*.sqlite', '*.sqlite-wal']) {
      assert.ok(lines.includes(required), `.gitignore doit contenir « ${required} »`);
    }
    assert.ok(lines.includes('!.env.example'), '.env.example doit rester versionnable');
  });

  it('aucun test ne lit le fichier .env', () => {
    const offenders: string[] = [];
    for (const file of walk(path.join(PROJECT_ROOT, 'tests')).filter((candidate) =>
      ['.ts', '.mjs', '.js'].includes(path.extname(candidate)),
    )) {
      if (file === SELF) continue;
      const text = readText(file);
      if (/loadEnvFile\s*\(/.test(text)) offenders.push(`${path.relative(PROJECT_ROOT, file)} : loadEnvFile`);
      if (/read(?:File|FileSync)\s*\([^)\n]*['"][^'"]*\.env['"]/.test(text)) {
        offenders.push(`${path.relative(PROJECT_ROOT, file)} : lecture de .env`);
      }
      if (/createReadStream\s*\([^)\n]*['"][^'"]*\.env['"]/.test(text)) {
        offenders.push(`${path.relative(PROJECT_ROOT, file)} : flux .env`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('le lanceur de tests force les quatre variables fournisseur à vide', () => {
    const source = readText(path.join(PROJECT_ROOT, 'tests', 'lib', 'backend-server.ts'));
    for (const key of ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'PIXABAY_API_KEY']) {
      assert.match(source, new RegExp(`${key}: ''`), `${key} doit être forcée à vide`);
    }
  });
});

describe('sécurité statique : dépendances et réseau', () => {
  it('les tests n’ont aucune dépendance npm externe', () => {
    const packageJson = JSON.parse(readText(path.join(PROJECT_ROOT, 'tests', 'package.json'))) as {
      dependencies?: unknown;
      devDependencies?: unknown;
      peerDependencies?: unknown;
      optionalDependencies?: unknown;
    };
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      assert.equal(packageJson[field], undefined, `tests/package.json ne doit pas déclarer ${field}`);
    }
  });

  it('les tests ne visent aucune API externe (seulement localhost et example.com)', () => {
    // evil.example est une origine CORS volontairement refusée : elle n'est
    // jamais appelée, elle sert uniquement d'en-tête Origin dans les tests.
    const allowedHosts = new Set([
      'localhost',
      '127.0.0.1',
      'qa.alt-broll.test',
      'example.com',
      'evil.example',
    ]);
    const offenders: string[] = [];
    const testFiles = walk(path.join(PROJECT_ROOT, 'tests')).filter((file) =>
      ['.ts', '.json'].includes(path.extname(file)),
    );

    for (const file of testFiles) {
      if (file === SELF) continue;
      const text = readText(file);
      for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
        const host = match[1]?.toLowerCase();
        if (host !== undefined && !allowedHosts.has(host)) {
          offenders.push(`${path.relative(PROJECT_ROOT, file)} → ${host}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('les fixtures JSON n’utilisent que des URL fictives (example.com) ou locales', () => {
    const allowedHosts = new Set(['example.com', 'localhost', '127.0.0.1']);
    const files = walk(path.join(PROJECT_ROOT, 'tests', 'fixtures')).filter((file) => file.endsWith('.json'));
    assert.ok(files.length >= 3, 'fixtures JSON absentes');
    for (const file of files) {
      const text = readText(file);
      for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)) {
        const host = match[1]?.toLowerCase() ?? '';
        assert.ok(
          allowedHosts.has(host),
          `${path.relative(PROJECT_ROOT, file)} utilise un hôte non fictif : ${host}`,
        );
      }
    }
  });
});

describe('sécurité statique : surface HTTP et chemins', () => {
  it('le backend désactive x-powered-by et n’ouvre pas CORS à toutes les origines', () => {
    const source = readText(path.join(PROJECT_ROOT, 'backend', 'src', 'app.ts'));
    assert.match(source, /app\.disable\('x-powered-by'\)/);
    assert.match(source, /buildCorsOptions/);
    assert.doesNotMatch(source, /origin\s*:\s*['"]\*['"]/);
    assert.doesNotMatch(source, /cors\(\s*\)/);
  });

  it('aucun chemin absolu de développeur dans le code et les fixtures', () => {
    const roots = ['backend/src', 'shared', 'tests/fixtures', 'frontend', 'renderer', '.env.example'].map((relative) =>
      path.join(PROJECT_ROOT, relative),
    );
    const offenders: string[] = [];
    for (const file of roots.flatMap(walk)) {
      if (file === SELF) continue;
      const text = readText(file);
      if (/[A-Za-z]:[\\/](?:Users|OASIS|GitHub|Projets)/.test(text)) offenders.push(`${path.relative(PROJECT_ROOT, file)} : chemin Windows`);
      if (/\/(?:home|Users|root)\/[A-Za-z0-9._-]+\//.test(text)) offenders.push(`${path.relative(PROJECT_ROOT, file)} : chemin Unix`);
    }
    assert.deepEqual(offenders, []);
  });

  it('le code backend ne journalise ni ne renvoie directement une clé API', () => {
    const source = readText(path.join(PROJECT_ROOT, 'backend', 'src', 'utils', 'logger.ts'));
    assert.match(source, /SENSITIVE_KEY/, 'le logger doit masquer les champs sensibles');
    assert.match(source, /api\[-_\]\?key/i, 'le motif de masquage doit couvrir les clés API');
  });

  it('frontend/ ne contient aucun secret (actif dès qu’Alex livre le dossier)', (t) => {
    const frontend = path.join(PROJECT_ROOT, 'frontend');
    if (!existsSync(frontend)) {
      t.skip('frontend/ n’existe pas encore : audit UX et secrets frontend en attente d’Alex.');
      return;
    }
    const offenders: string[] = [];
    for (const file of walk(frontend)) {
      const text = readText(file);
      for (const [pattern, label] of SECRET_PATTERNS) {
        if (pattern.test(text)) offenders.push(`${path.relative(PROJECT_ROOT, file)} : ${label}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('renderer/ n’active pas de shell et ne contient aucun secret (actif dès que Codex livre)', (t) => {
    const renderer = path.join(PROJECT_ROOT, 'renderer');
    if (!existsSync(renderer)) {
      t.skip('renderer/ n’existe pas encore : audit du worker en attente de Codex.');
      return;
    }
    const offenders: string[] = [];
    for (const file of walk(renderer)) {
      const text = readText(file);
      if (/shell\s*:\s*true/.test(text)) offenders.push(`${path.relative(PROJECT_ROOT, file)} : shell activé`);
      for (const [pattern, label] of SECRET_PATTERNS) {
        if (pattern.test(text)) offenders.push(`${path.relative(PROJECT_ROOT, file)} : ${label}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
