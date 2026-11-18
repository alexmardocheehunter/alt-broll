import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { UnsafePathError, createLocalStorage, isInside } from '../src/storage/local-storage.ts';

const root = mkdtempSync(path.join(tmpdir(), 'alt-broll-storage-'));
after(() => rmSync(root, { recursive: true, force: true }));

const storage = createLocalStorage(root);
const projectId = '3b7f9c1e-2a4d-4e8b-9f61-0c5d2e7a8b90';
const ONE_HOUR_MS = 60 * 60 * 1000;

describe('stockage local', () => {
  it('place les fichiers dans le dossier du projet', () => {
    assert.equal(
      storage.resolveProjectFile(projectId, 'source/abc-123.mp4'),
      path.join(root, 'projects', projectId, 'source', 'abc-123.mp4'),
    );
    assert.equal(
      storage.resolveProjectFile(projectId, 'output/job_1.mp4'),
      path.join(root, 'projects', projectId, 'output', 'job_1.mp4'),
    );
  });

  it('refuse les traversées de chemin, les chemins absolus et les fichiers hors contrat', () => {
    const refused = [
      '../x.mp4',
      'source/../../x.mp4',
      'source/..\\x.mp4',
      'source\\x.mp4',
      '/etc/passwd',
      'C:\\Windows\\x.mp4',
      'source/x.mp4.exe',
      'source/x.MP4',
      'source/x y.mp4',
      'tmp/x.mp4',
      'source/',
      '',
    ];
    for (const file of refused) {
      assert.throws(() => storage.resolveProjectFile(projectId, file), UnsafePathError, file);
    }
  });

  it('refuse un identifiant de projet dangereux', () => {
    for (const id of ['..', '../x', 'a/b', 'a\\b', '', 'x'.repeat(65), 'é']) {
      assert.throws(() => storage.projectDir(id), UnsafePathError, id);
    }
  });

  it('ne considère comme contenus que les chemins strictement à l’intérieur du dossier', () => {
    const parent = path.join(root, 'p');

    assert.equal(isInside(parent, path.join(parent, 'a.mp4')), true);
    assert.equal(isInside(parent, parent), false);
    assert.equal(isInside(parent, path.join(root, 'p2', 'a.mp4')), false);
    assert.equal(isInside(parent, path.join(parent, '..', 'a.mp4')), false);
  });

  it('supprime les envois abandonnés anciens et conserve les récents', async () => {
    await storage.ensureBaseDirs();
    const oldFile = path.join(storage.uploadTmpDir, 'ancien.upload');
    writeFileSync(oldFile, 'x');
    writeFileSync(path.join(storage.uploadTmpDir, 'recent.upload'), 'y');
    const twoHoursAgo = new Date(Date.now() - 2 * ONE_HOUR_MS);
    utimesSync(oldFile, twoHoursAgo, twoHoursAgo);

    const removed = await storage.cleanupStaleUploads(ONE_HOUR_MS);

    assert.equal(removed, 1);
    assert.deepEqual(readdirSync(storage.uploadTmpDir), ['recent.upload']);
  });
});
