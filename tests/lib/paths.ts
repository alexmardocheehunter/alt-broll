import path from 'node:path';

/** Racine du dossier tests/ (ce fichier est dans tests/lib/). */
export const TESTS_DIR = path.resolve(import.meta.dirname, '..');
/** Racine du projet ALT B-ROLL. */
export const PROJECT_ROOT = path.resolve(TESTS_DIR, '..');

export const FIXTURES_DIR = path.join(TESTS_DIR, 'fixtures');
export const MEDIA_DIR = path.join(FIXTURES_DIR, 'media');
export const MANIFEST_PATH = path.join(MEDIA_DIR, 'manifest.json');
export const PROJECTS_DIR = path.join(FIXTURES_DIR, 'projects');
export const JOBS_DIR = path.join(FIXTURES_DIR, 'jobs');
export const REPORTS_DIR = path.join(TESTS_DIR, 'reports');

/** Chemin d'une fixture média, sans autoriser de sortie du dossier. */
export function mediaPath(name: string): string {
  if (name.length === 0 || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(`Nom de fixture invalide : « ${name} »`);
  }
  return path.join(MEDIA_DIR, name);
}

export function projectFixturePath(name: string): string {
  if (name.length === 0 || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(`Nom de fixture projet invalide : « ${name} »`);
  }
  return path.join(PROJECTS_DIR, name);
}

export function jobFixturePath(name: string): string {
  if (name.length === 0 || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(`Nom de fixture job invalide : « ${name} »`);
  }
  return path.join(JOBS_DIR, name);
}
