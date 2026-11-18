import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import {
  BROLL_FITS,
  BROLL_ITEM_STATUSES,
  ID_PATTERN,
  PROJECT_RELATIVE_FILE_PATTERN,
  RENDER_JOB_RULES,
  RENDER_JOB_SQL,
  RENDER_JOB_STATUSES,
  RENDER_JOBS_TABLE_SQL,
  RENDER_STATUSES,
  SCHEMA_VERSION,
  TIMELINE_RULES,
  type RenderJobStatus,
} from '../../shared/contract.ts';

function namedParameters(sql: string): string[] {
  return [...new Set([...sql.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1] ?? ''))].sort();
}

function insertJob(db: DatabaseSync, id: string, status: string, createdAtMs: number, attempts = 0): void {
  db.prepare(
    `INSERT INTO render_jobs
       (id, project_id, project_revision, status, payload, attempts, max_attempts, created_at_ms, updated_at_ms)
     VALUES (:id, 'projet-test', 1, :status, '{}', :attempts, :maxAttempts, :createdAtMs, :createdAtMs)`,
  ).run({ id, status, attempts, maxAttempts: RENDER_JOB_RULES.maxAttempts, createdAtMs });
}

describe('contrat : constantes partagées', () => {
  it('SCHEMA_VERSION vaut 1 et les listes ne contiennent pas de doublon', () => {
    assert.equal(SCHEMA_VERSION, 1);
    for (const list of [BROLL_FITS, BROLL_ITEM_STATUSES, RENDER_JOB_STATUSES, RENDER_STATUSES]) {
      assert.equal(new Set(list).size, list.length, `doublon dans ${list.join(', ')}`);
    }
  });

  it('le statut de rendu exposé = idle + statuts de job', () => {
    assert.equal(RENDER_STATUSES[0], 'idle');
    assert.deepEqual(RENDER_STATUSES.slice(1), RENDER_JOB_STATUSES);
  });

  it('les règles de timeline sont cohérentes', () => {
    assert.ok(TIMELINE_RULES.minSegmentSeconds > 0);
    assert.ok(TIMELINE_RULES.minSegmentSeconds < TIMELINE_RULES.maxSegmentSeconds);
    assert.ok(TIMELINE_RULES.maxCandidatesPerItem >= 1);
    assert.ok(TIMELINE_RULES.maxBrollItems >= 3, 'la bêta promet 3 à 8 suggestions par vidéo');
    assert.ok(TIMELINE_RULES.timePrecisionDecimals >= 3);
  });

  it('les règles de bail laissent au worker le temps de faire un heartbeat', () => {
    assert.ok(RENDER_JOB_RULES.heartbeatMs > 0);
    assert.ok(RENDER_JOB_RULES.heartbeatMs * 2 <= RENDER_JOB_RULES.leaseMs);
    assert.ok(RENDER_JOB_RULES.maxAttempts >= 1);
  });

  it('ID_PATTERN et PROJECT_RELATIVE_FILE_PATTERN refusent les traversées de chemin', () => {
    assert.ok(ID_PATTERN.test('fixture_project_001'));
    assert.ok(ID_PATTERN.test('3b7f9c1e-2a4d-4e8b-9f61-0c5d2e7a8b90'));
    for (const invalid of ['', '../projet', 'a b', 'é', 'a'.repeat(65)]) {
      assert.equal(ID_PATTERN.test(invalid), false, `ID_PATTERN accepte « ${invalid} »`);
    }

    for (const valid of ['source/source-30s.mp4', 'broll/x_1.mp4', 'output/out.mp4']) {
      assert.equal(PROJECT_RELATIVE_FILE_PATTERN.test(valid), true, `chemin refusé à tort : ${valid}`);
    }
    const invalidPaths = [
      '../source/a.mp4',
      'source/../a.mp4',
      'source/sub/a.mp4',
      'work/a.mp4',
      'source/a.mov',
      'source/a.mp4.exe',
      'C:/source/a.mp4',
      'source\\a.mp4',
      'source/.mp4',
      `source/${'a'.repeat(65)}.mp4`,
      'source/a b.mp4',
    ];
    for (const invalid of invalidPaths) {
      assert.equal(PROJECT_RELATIVE_FILE_PATTERN.test(invalid), false, `chemin accepté à tort : ${invalid}`);
    }
  });

  it('les paramètres nommés des requêtes du worker correspondent au protocole documenté', () => {
    assert.deepEqual(namedParameters(RENDER_JOB_SQL.claimNext), ['leaseExpiresAtMs', 'maxConcurrentRenders', 'nowMs', 'workerId'].sort());
    assert.deepEqual(namedParameters(RENDER_JOB_SQL.heartbeat), ['jobId', 'leaseExpiresAtMs', 'nowMs', 'progress', 'workerId'].sort());
    assert.deepEqual(namedParameters(RENDER_JOB_SQL.complete), ['jobId', 'nowMs', 'outputDurationSeconds', 'outputSizeBytes', 'workerId'].sort());
    assert.deepEqual(namedParameters(RENDER_JOB_SQL.fail), ['errorCode', 'errorMessage', 'jobId', 'nowMs', 'workerId'].sort());
    assert.deepEqual(namedParameters(RENDER_JOB_SQL.recoverStale), ['nowMs']);
  });

  it('le schéma SQL accepte exactement les statuts de job du contrat', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(RENDER_JOBS_TABLE_SQL);
      db.exec(RENDER_JOBS_TABLE_SQL); // idempotent

      RENDER_JOB_STATUSES.forEach((status, index) => insertJob(db, `job-${status}`, status, index));
      const rows = db.prepare('SELECT status FROM render_jobs ORDER BY created_at_ms').all();
      assert.deepEqual(
        rows.map((row) => String(row.status)),
        [...RENDER_JOB_STATUSES],
      );

      assert.throws(
        () => insertJob(db, 'job-invalide', 'en_cours', 99),
        /CHECK constraint failed/,
        'un statut hors contrat doit être refusé par SQLite',
      );
    } finally {
      db.close();
    }
  });

  it('le schéma refuse une progression hors [0, 1] (le worker doit borner ses valeurs)', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(RENDER_JOBS_TABLE_SQL);
      assert.throws(
        () => {
          db.prepare(
            `INSERT INTO render_jobs (id, project_id, project_revision, status, payload, progress, created_at_ms, updated_at_ms)
             VALUES ('job-progress', 'projet-test', 1, 'queued', '{}', 1.5, 0, 0)`,
          ).run();
        },
        /CHECK constraint failed/,
      );
    } finally {
      db.close();
    }
  });

  it('les temps du contrat sont arrondis à la milliseconde et alignables sur une frame', () => {
    const fps = 30;
    const align = (seconds: number): number => Math.round(seconds * fps) / fps;
    const oneFrame = 1 / fps;

    assert.ok(Math.abs(oneFrame - 0.0333333) < 1e-6);
    assert.ok(Math.abs(align(6.2) - 6.2) < 1e-9);
    assert.ok(Math.abs(align(6.214) - 6.2) < 1e-9, '6,214 s doit tomber sur la frame 6,2 s à 30 i/s');
    assert.ok(Math.abs(align(6.217) - 6.2333333) < 1e-6);
    for (const value of [0, 1, 5.123, 30]) {
      assert.ok(Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-9);
    }
  });

  it('les types de job couvrent les statuts du contrat (garde-fou TypeScript)', () => {
    const statuses: readonly RenderJobStatus[] = RENDER_JOB_STATUSES;
    assert.deepEqual(statuses, ['preparing', 'queued', 'rendering', 'completed', 'failed']);
  });
});
