import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import type { AppConfig } from '../../backend/src/config/env.ts';
import { loadConfig } from '../../backend/src/config/env.ts';
import { openDatabase } from '../../backend/src/db/database.ts';
import { interpretProbeOutput, parseFrameRate } from '../../backend/src/media/ffprobe.ts';
import { createRenderJobRepository } from '../../backend/src/repositories/job.repository.ts';
import { createProjectRepository, type ProjectDocument } from '../../backend/src/repositories/project.repository.ts';
import { createProjectService } from '../../backend/src/services/project.service.ts';
import { isErrorCode, toRenderState } from '../../backend/src/services/render-state.ts';
import { buildTimeline } from '../../backend/src/services/timeline.service.ts';
import { describeDuration, sanitizeOriginalName } from '../../backend/src/services/upload.service.ts';
import { createLocalStorage, isInside, UnsafePathError } from '../../backend/src/storage/local-storage.ts';
import type { RenderJobRow } from '../../shared/contract.ts';
import { projectFixturePath } from '../lib/paths.ts';
import { validateProject, validateRenderState } from '../lib/validation/project.ts';

/*
 * Tests des services backend livrés par Claude, avant leur branchement HTTP.
 *
 * Ils importent directement les modules backend et les exercent sur une base
 * SQLite en mémoire ou un dossier temporaire. Aucun réseau, aucun .env.
 * Objectif : détecter tôt les écarts entre le contrat et le code, et donner à
 * Claude un retour précis avant l'ouverture des routes.
 */

const config: AppConfig = loadConfig({
  NODE_ENV: 'test',
  APP_BASE_URL: 'http://localhost:3999',
  DATABASE_PATH: ':memory:',
  STORAGE_ROOT: './storage',
});

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

function createStack(): {
  db: DatabaseSync;
  service: ReturnType<typeof createProjectService>;
} {
  const db = openDatabase(':memory:');
  openDatabases.push(db);
  const projects = createProjectRepository(db);
  const renderJobs = createRenderJobRepository(db);
  return { db, service: createProjectService({ config, projects, renderJobs, now: () => Date.parse('2026-11-18T10:00:00.000Z') }) };
}

function fixtureDocument(): ProjectDocument {
  const body = JSON.parse(readFileSync(projectFixturePath('project.fixture.json'), 'utf8')) as {
    project: {
      source: ProjectDocument['source'];
      transcript: ProjectDocument['transcript'];
      analysis: ProjectDocument['analysis'];
      brollItems: ProjectDocument['brollItems'];
    };
  };
  return {
    source: body.project.source,
    transcript: body.project.transcript,
    analysis: body.project.analysis,
    brollItems: body.project.brollItems,
  };
}

describe('services backend : projets et révisions', () => {
  it('crée un projet vide conforme au contrat', () => {
    const { service } = createStack();
    const project = service.create();
    assert.deepEqual(validateProject(project), []);
    assert.equal(project.revision, 0);
    assert.equal(project.source, null);
    assert.equal(project.analysis.status, 'idle');
    assert.equal(project.render.status, 'idle');
    assert.deepEqual(project.urls, { source: null, download: null });
  });

  it('enregistre un document complet et le relit sans perte', () => {
    const { service } = createStack();
    const created = service.create();
    const saved = service.save(service.requireRecord(created.id), fixtureDocument());
    const project = service.toProject(saved);

    assert.deepEqual(validateProject(project), []);
    assert.equal(project.revision, 1);
    assert.equal(project.source?.storedFileName, 'source-30s.mp4');
    assert.deepEqual(
      project.timeline.segments.map((segment) => segment.brollItemId),
      ['br_fix_01', 'br_fix_02'],
      'la timeline du backend doit appliquer la règle d’inclusion D-06',
    );
    assert.ok(project.urls.source, 'URL de lecture absente');
    const sourceUrl = new URL(project.urls.source);
    assert.equal(sourceUrl.pathname, `/api/projects/${project.id}/media/source`);
    assert.equal(project.urls.download, null);
  });

  it('refuse une écriture fondée sur une révision périmée (409 REVISION_CONFLICT)', () => {
    const { service } = createStack();
    const created = service.create();
    const stale = service.requireRecord(created.id);
    service.save(stale, fixtureDocument());

    assert.throws(
      () => service.save(stale, fixtureDocument()),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        (error as { code: string }).code === 'REVISION_CONFLICT' &&
        'httpStatus' in error &&
        (error as { httpStatus: number }).httpStatus === 409,
    );
    assert.equal(service.requireRecord(created.id).revision, 1);
  });

  it('renvoie 404 sans requête SQL pour un identifiant mal formé ou inconnu', () => {
    const { service } = createStack();
    for (const id of ['inconnu', '../projet', 'a b', 'é', '']) {
      assert.throws(
        () => service.requireRecord(id),
        (error: unknown) => error instanceof Error && 'code' in error && (error as { code: string }).code === 'NOT_FOUND',
        `identifiant « ${id} » accepté à tort`,
      );
    }
  });

  it('status et suggestions restent cohérents avec le projet', () => {
    const { service } = createStack();
    const created = service.create();
    const record = service.requireRecord(created.id);
    const status = service.status(record);
    assert.equal(status.projectId, created.id);
    assert.equal(status.sourceUploaded, false);
    assert.equal(status.analysis.status, 'idle');
    assert.equal(status.render.status, 'idle');

    const suggestions = service.suggestions(record);
    assert.equal(suggestions.projectId, created.id);
    assert.deepEqual(suggestions.brollItems, []);
    assert.deepEqual(suggestions.timeline, { segments: [] });
  });
});

describe('services backend : timeline', () => {
  it('monte exactement les éléments actifs, non refusés et avec candidat', () => {
    const document = fixtureDocument();
    const timeline = buildTimeline(document.brollItems);
    assert.deepEqual(
      timeline.segments.map((segment) => segment.brollItemId),
      ['br_fix_01', 'br_fix_02'],
    );
    assert.deepEqual(
      timeline.segments.map((segment) => segment.candidateId),
      ['cand_fix_01a', 'cand_fix_02a'],
    );
  });

  it('trie les segments par instant de début, même si la source est désordonnée', () => {
    const document = fixtureDocument();
    const reversed = [...document.brollItems].reverse();
    const timeline = buildTimeline(reversed);
    assert.deepEqual(
      timeline.segments.map((segment) => segment.startSeconds),
      [5, 15],
    );
  });
});

describe('services backend : état de rendu', () => {
  const baseRow: RenderJobRow = {
    id: 'job_qa',
    project_id: 'projet_qa',
    project_revision: 3,
    status: 'rendering',
    payload: '{}',
    progress: 0.42,
    attempts: 1,
    max_attempts: 2,
    worker_id: 'worker_qa',
    lease_expires_at_ms: 1_000,
    output_size_bytes: null,
    output_duration_seconds: null,
    error_code: null,
    error_message: null,
    created_at_ms: 1_000,
    updated_at_ms: 2_000,
    started_at_ms: 1_500,
    completed_at_ms: null,
  };

  it('aucun job = idle conforme', () => {
    const state = toRenderState(null);
    assert.deepEqual(state, {
      status: 'idle',
      jobId: null,
      revision: null,
      progress: 0,
      outputFile: null,
      startedAt: null,
      completedAt: null,
      error: null,
    });
    assert.deepEqual(validateRenderState(state), []);
  });

  it('un job rendering expose progression et dates, sans chemin', () => {
    const state = toRenderState(baseRow);
    assert.deepEqual(validateRenderState(state), []);
    assert.equal(state.status, 'rendering');
    assert.equal(state.progress, 0.42);
    assert.equal(state.startedAt, new Date(1_500).toISOString());
    assert.equal(state.outputFile, null);
  });

  it('borne la progression et normalise un code d’erreur inconnu', () => {
    const running = toRenderState({ ...baseRow, progress: 1.7 });
    assert.equal(running.progress, 1);

    const failed = toRenderState({
      ...baseRow,
      status: 'failed',
      progress: 0.6,
      error_code: 'CODE_INVENTE' as RenderJobRow['error_code'],
      error_message: 'Échec du rendu.',
      completed_at_ms: 3_000,
      started_at_ms: 1_500,
    });
    assert.deepEqual(validateRenderState(failed), []);
    assert.equal(failed.error?.code, 'INTERNAL_ERROR');
    assert.equal(failed.error?.message, 'Échec du rendu.');
    assert.equal(isErrorCode('RENDER_FFMPEG_FAILED'), true);
    assert.equal(isErrorCode('CODE_INVENTE'), false);
  });

  it('un job completed expose le fichier validé et une progression à 1', () => {
    const state = toRenderState({
      ...baseRow,
      status: 'completed',
      progress: 0.8,
      output_size_bytes: 1_000_000,
      output_duration_seconds: 30,
      completed_at_ms: 4_000,
    });

    assert.equal(state.status, 'completed');
    assert.deepEqual(state.outputFile, { sizeBytes: 1_000_000, durationSeconds: 30 });
    assert.equal(state.completedAt, new Date(4_000).toISOString());
    assert.deepEqual(validateRenderState(state), []);
    assert.equal(state.progress, 1, 'un export terminé doit afficher 100 %');
  });

  it('un job remis en file affiche une progression à zéro', () => {
    for (const status of ['preparing', 'queued'] as const) {
      const state = toRenderState({ ...baseRow, status, progress: 0.4 });
      assert.equal(state.progress, 0, `${status} ne doit pas afficher l’ancienne progression`);
      assert.deepEqual(validateRenderState(state), []);
    }
  });
});

describe('services backend : noms de fichiers et stockage', () => {
  it('sanitizeOriginalName retire dossiers et caractères de contrôle', () => {
    assert.equal(sanitizeOriginalName('C:\\Users\\alex\\..\\evil.mp4'), 'evil.mp4');
    assert.equal(sanitizeOriginalName('/home/alex/vidéo.mp4'), 'vidéo.mp4');
    assert.equal(sanitizeOriginalName('nom\u0000avec\u001fcontrôle.mp4'), 'nomaveccontrôle.mp4');
    assert.equal(sanitizeOriginalName('   '), 'video.mp4');
    assert.equal(sanitizeOriginalName('a'.repeat(250)), 'a'.repeat(200));
  });

  it('describeDuration produit un message français lisible', () => {
    assert.equal(describeDuration(30, 5), '30 s');
    assert.equal(describeDuration(252, 180), '4 min 12 s');
    assert.equal(describeDuration(180.4, 180), '180,4 s');
  });

  it('resolveProjectFile refuse toute sortie du dossier du projet', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'alt-broll-storage-'));
    try {
      const storage = createLocalStorage(root);
      const file = storage.resolveProjectFile('projet_qa', 'source/video.mp4');
      assert.ok(path.isAbsolute(file));
      assert.ok(isInside(storage.root, file));

      for (const relative of ['../source/x.mp4', 'source/../x.mp4', 'source\\x.mp4', 'source/x.mov', 'output/x.mp4.exe']) {
        assert.throws(
          () => storage.resolveProjectFile('projet_qa', relative),
          UnsafePathError,
          `chemin accepté à tort : ${relative}`,
        );
      }
      for (const projectId of ['../projet', 'a b', 'é', '']) {
        assert.throws(() => storage.resolveProjectFile(projectId, 'source/x.mp4'), UnsafePathError);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleanupStaleUploads ne supprime que les fichiers anciens du dossier temporaire', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'alt-broll-storage-'));
    try {
      const storage = createLocalStorage(root);
      await storage.ensureBaseDirs();
      const oldFile = path.join(storage.uploadTmpDir, 'ancien.upload');
      const recentFile = path.join(storage.uploadTmpDir, 'recent.upload');
      writeFileSync(oldFile, 'x');
      writeFileSync(recentFile, 'x');
      const now = Date.now();
      utimesSync(oldFile, new Date(now - 10_000), new Date(now - 10_000));
      utimesSync(recentFile, new Date(now), new Date(now));

      assert.equal(await storage.cleanupStaleUploads(5_000, now), 1);
      assert.equal(await storage.cleanupStaleUploads(5_000, now), 0);
      assert.ok(exists(recentFile));
      assert.equal(exists(oldFile), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function exists(file: string): boolean {
  return existsSync(file);
}

describe('services backend : interprétation ffprobe', () => {
  it('applique la rotation et choisit la première vraie piste vidéo', () => {
    const probe = interpretProbeOutput({
      streams: [
        { codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, disposition: { attached_pic: 1 } },
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 640,
          height: 360,
          avg_frame_rate: '30000/1001',
          duration: '10.5',
          side_data_list: [{ rotation: -90 }],
        },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10.52' },
    });

    assert.equal(probe.formatName.includes('mp4'), true);
    assert.equal(probe.durationSeconds, 10.52);
    assert.deepEqual(probe.video, { codec: 'h264', width: 360, height: 640, frameRate: 29.97 });
    assert.deepEqual(probe.audio, { codec: 'aac' });
  });

  it('gère l’absence de durée, de vidéo et d’audio', () => {
    const probe = interpretProbeOutput({ streams: [], format: { format_name: 'mp4' } });
    assert.equal(probe.durationSeconds, null);
    assert.equal(probe.video, null);
    assert.equal(probe.audio, null);
  });

  it('parseFrameRate refuse les valeurs nulles ou invalides', () => {
    assert.equal(parseFrameRate('30000/1001'), 29.97);
    assert.equal(parseFrameRate('30/1'), 30);
    assert.equal(parseFrameRate('0/0'), null);
    assert.equal(parseFrameRate('abc'), null);
    assert.equal(parseFrameRate(undefined), null);
  });
});
