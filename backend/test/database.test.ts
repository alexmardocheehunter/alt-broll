import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import {
  RENDER_JOB_RULES,
  RENDER_JOB_SQL,
  RENDER_JOB_STATUSES,
  type RenderJobRow,
  type RenderJobStatus,
} from '../src/contract.ts';
import { DATABASE_SCHEMA_VERSION, openDatabase, readSchemaVersion } from '../src/db/database.ts';

const tempDir = mkdtempSync(path.join(tmpdir(), 'alt-broll-db-'));
after(() => rmSync(tempDir, { recursive: true, force: true }));

function insertJob(db: DatabaseSync, id: string, status: RenderJobStatus, createdAtMs: number): void {
  db.prepare(
    `INSERT INTO render_jobs (id, project_id, project_revision, status, payload, max_attempts, created_at_ms, updated_at_ms)
     VALUES (:id, 'projet-test', 1, :status, '{}', :maxAttempts, :createdAtMs, :createdAtMs)`,
  ).run({ id, status, maxAttempts: RENDER_JOB_RULES.maxAttempts, createdAtMs });
}

/** Prise atomique telle que le worker doit la faire (BEGIN IMMEDIATE … COMMIT). */
function claimNext(db: DatabaseSync, workerId: string, nowMs: number, maxConcurrentRenders = 1): RenderJobRow | undefined {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare(RENDER_JOB_SQL.claimNext).get({
      workerId,
      nowMs,
      leaseExpiresAtMs: nowMs + RENDER_JOB_RULES.leaseMs,
      maxConcurrentRenders,
    }) as RenderJobRow | undefined;
    db.exec('COMMIT');
    return row;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function getJob(db: DatabaseSync, id: string): RenderJobRow {
  const row = db.prepare('SELECT * FROM render_jobs WHERE id = ?').get(id) as RenderJobRow | undefined;
  assert.ok(row, `job ${id} introuvable`);
  return row;
}

function changes(result: { changes: number | bigint }): number {
  return Number(result.changes);
}

describe('openDatabase', () => {
  it('crée les tables projects et render_jobs, en WAL, et enregistre la version du schéma', () => {
    const db = openDatabase(path.join(tempDir, 'schema.sqlite'));
    try {
      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all()
        .map((row) => String(row.name));
      const journalMode = db.prepare('PRAGMA journal_mode').get();

      assert.deepEqual(tables, ['projects', 'render_jobs']);
      assert.equal(readSchemaVersion(db), DATABASE_SCHEMA_VERSION);
      assert.equal(String(journalMode?.journal_mode), 'wal');
    } finally {
      db.close();
    }
  });

  it('se rouvre sans erreur ni nouvelle migration', () => {
    const file = path.join(tempDir, 'reopen.sqlite');
    openDatabase(file).close();
    const db = openDatabase(file);
    try {
      assert.equal(readSchemaVersion(db), DATABASE_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('accepte tous les statuts de job du contrat et refuse les autres', () => {
    const db = openDatabase(':memory:');
    try {
      RENDER_JOB_STATUSES.forEach((status, index) => insertJob(db, `job-${status}`, status, index));

      assert.throws(() => insertJob(db, 'job-invalide', 'en_cours' as RenderJobStatus, 99), /CHECK constraint failed/);
    } finally {
      db.close();
    }
  });
});

describe('protocole render_jobs du contrat', () => {
  it('claimNext attribue le plus ancien job en file, une seule fois, et ignore les jobs en préparation', () => {
    const db = openDatabase(':memory:');
    try {
      insertJob(db, 'job-recent', 'queued', 2_000);
      insertJob(db, 'job-ancien', 'queued', 1_000);
      insertJob(db, 'job-prepa', 'preparing', 500);

      const first = claimNext(db, 'worker-1', 10_000, 2);
      const second = claimNext(db, 'worker-2', 10_000, 2);
      const third = claimNext(db, 'worker-3', 10_000, 2);

      assert.equal(first?.id, 'job-ancien');
      assert.equal(first?.status, 'rendering');
      assert.equal(first?.worker_id, 'worker-1');
      assert.equal(first?.attempts, 1);
      assert.equal(second?.id, 'job-recent');
      assert.equal(third, undefined);
    } finally {
      db.close();
    }
  });

  it('claimNext respecte la limite de rendus simultanés', () => {
    const db = openDatabase(':memory:');
    try {
      insertJob(db, 'job-a', 'queued', 1_000);
      insertJob(db, 'job-b', 'queued', 2_000);

      assert.equal(claimNext(db, 'worker-1', 10_000)?.id, 'job-a');
      assert.equal(claimNext(db, 'worker-2', 10_000), undefined);

      db.prepare(RENDER_JOB_SQL.complete).run({
        jobId: 'job-a',
        workerId: 'worker-1',
        outputSizeBytes: 1_024,
        outputDurationSeconds: 30,
        nowMs: 20_000,
      });
      assert.equal(claimNext(db, 'worker-2', 20_000)?.id, 'job-b');
    } finally {
      db.close();
    }
  });

  it('seul le worker détenteur publie la progression et termine le job', () => {
    const db = openDatabase(':memory:');
    try {
      insertJob(db, 'job-a', 'queued', 1_000);
      claimNext(db, 'worker-1', 10_000);
      const heartbeat = (workerId: string) =>
        changes(
          db.prepare(RENDER_JOB_SQL.heartbeat).run({
            jobId: 'job-a',
            workerId,
            progress: 0.5,
            leaseExpiresAtMs: 70_000,
            nowMs: 12_000,
          }),
        );

      assert.equal(heartbeat('worker-intrus'), 0);
      assert.equal(heartbeat('worker-1'), 1);

      const completed = changes(
        db.prepare(RENDER_JOB_SQL.complete).run({
          jobId: 'job-a',
          workerId: 'worker-1',
          outputSizeBytes: 5_000_000,
          outputDurationSeconds: 30.03,
          nowMs: 15_000,
        }),
      );
      const job = getJob(db, 'job-a');

      assert.equal(completed, 1);
      assert.equal(job.status, 'completed');
      assert.equal(job.progress, 1);
      assert.equal(job.output_size_bytes, 5_000_000);
      assert.equal(job.completed_at_ms, 15_000);
    } finally {
      db.close();
    }
  });

  it("fail enregistre un code et un message d'erreur sans nouvelle tentative", () => {
    const db = openDatabase(':memory:');
    try {
      insertJob(db, 'job-a', 'queued', 1_000);
      claimNext(db, 'worker-1', 10_000);

      db.prepare(RENDER_JOB_SQL.fail).run({
        jobId: 'job-a',
        workerId: 'worker-1',
        errorCode: 'RENDER_FFMPEG_FAILED',
        errorMessage: "L'export a échoué pendant le montage vidéo.",
        nowMs: 11_000,
      });
      const job = getJob(db, 'job-a');

      assert.equal(job.status, 'failed');
      assert.equal(job.error_code, 'RENDER_FFMPEG_FAILED');
      assert.equal(claimNext(db, 'worker-1', 12_000), undefined);
    } finally {
      db.close();
    }
  });

  it('recoverStale remet en file un job abandonné, puis le passe en échec après le nombre maximal de tentatives', () => {
    const db = openDatabase(':memory:');
    try {
      insertJob(db, 'job-a', 'queued', 1_000);
      const recover = (nowMs: number) => changes(db.prepare(RENDER_JOB_SQL.recoverStale).run({ nowMs }));

      claimNext(db, 'worker-1', 0);
      assert.equal(recover(30_000), 0, 'bail encore valide');
      assert.equal(recover(RENDER_JOB_RULES.leaseMs + 1), 1);
      assert.equal(getJob(db, 'job-a').status, 'queued');
      assert.equal(getJob(db, 'job-a').worker_id, null);

      const retried = claimNext(db, 'worker-2', RENDER_JOB_RULES.leaseMs + 1);
      assert.equal(retried?.attempts, 2);
      assert.equal(recover(3 * RENDER_JOB_RULES.leaseMs), 1);

      const job = getJob(db, 'job-a');
      assert.equal(job.status, 'failed');
      assert.equal(job.error_code, 'RENDER_WORKER_LOST');
      assert.ok(job.error_message);
    } finally {
      db.close();
    }
  });
});
