import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { ID_PATTERN, PROJECT_RELATIVE_FILE_PATTERN, STORAGE_LAYOUT } from '../contract.ts';

/** Chemin refusé : identifiant ou fichier hors des règles du contrat. Ne doit jamais arriver en usage normal. */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

export interface LocalStorage {
  /** Racine absolue du stockage (STORAGE_ROOT). */
  readonly root: string;
  /** Envois en cours de réception, hors des dossiers de projets. */
  readonly uploadTmpDir: string;
  /** Dossier d'un projet : <root>/projects/<projectId>. */
  projectDir(projectId: string): string;
  /** Chemin absolu d'un fichier du projet ; refuse tout chemin hors des règles du contrat. */
  resolveProjectFile(projectId: string, relativeFile: string): string;
  /** Dossier de travail temporaire du projet : <projet>/work/<name>, name conforme à ID_PATTERN. */
  projectWorkDir(projectId: string, name: string): string;
  ensureBaseDirs(): Promise<void>;
  /** Supprime les envois abandonnés plus anciens que maxAgeMs ; renvoie le nombre de fichiers supprimés. */
  cleanupStaleUploads(maxAgeMs: number, nowMs?: number): Promise<number>;
}

export function createLocalStorage(storageRoot: string): LocalStorage {
  const root = path.resolve(storageRoot);
  const projectsRoot = path.join(root, STORAGE_LAYOUT.projectsDir);
  const uploadTmpDir = path.join(root, 'tmp', 'uploads');

  function projectDir(projectId: string): string {
    if (!ID_PATTERN.test(projectId)) throw new UnsafePathError('Identifiant de projet invalide.');
    return path.join(projectsRoot, projectId);
  }

  function resolveProjectFile(projectId: string, relativeFile: string): string {
    if (!PROJECT_RELATIVE_FILE_PATTERN.test(relativeFile)) throw new UnsafePathError('Chemin de fichier refusé.');
    const dir = projectDir(projectId);
    const resolved = path.resolve(dir, relativeFile);
    if (!isInside(dir, resolved)) throw new UnsafePathError('Chemin hors du dossier du projet.');
    return resolved;
  }

  function projectWorkDir(projectId: string, name: string): string {
    if (!ID_PATTERN.test(name)) throw new UnsafePathError('Nom de dossier de travail invalide.');
    return path.join(projectDir(projectId), STORAGE_LAYOUT.workDir, name);
  }

  async function ensureBaseDirs(): Promise<void> {
    await mkdir(projectsRoot, { recursive: true });
    await mkdir(uploadTmpDir, { recursive: true });
  }

  async function cleanupStaleUploads(maxAgeMs: number, nowMs: number = Date.now()): Promise<number> {
    let names: string[];
    try {
      names = await readdir(uploadTmpDir);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return 0;
      throw error;
    }

    let removed = 0;
    for (const name of names) {
      const file = path.join(uploadTmpDir, name);
      try {
        const info = await stat(file);
        if (!info.isFile() || nowMs - info.mtimeMs < maxAgeMs) continue;
        await rm(file, { force: true });
        removed += 1;
      } catch (error) {
        // Fichier supprimé entre-temps par la requête qui l'utilisait : rien à faire.
        if (!hasErrorCode(error, 'ENOENT')) throw error;
      }
    }
    return removed;
  }

  return { root, uploadTmpDir, projectDir, resolveProjectFile, projectWorkDir, ensureBaseDirs, cleanupStaleUploads };
}

/** true si `child` est strictement à l'intérieur de `parent`. */
export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}
