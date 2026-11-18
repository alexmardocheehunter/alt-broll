import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  RENDER_JOB_RULES,
  RENDER_JOB_SQL,
  RENDER_JOBS_TABLE_SQL,
  type RenderJobStatus,
} from '../../shared/contract.ts';

/*
 * Tests du protocole SQLite backend → worker (shared/contract.ts §6).
 *
 * Le worker n'existe pas encore (renderer/, Codex) : ces tests exécutent les
 * requêtes de référence du contrat sur une base en mémoire. Ils figent le
 * comportement attendu de claimNext / heartbeat / complete / fail / recoverStale
 * pour que le worker de Codex et le backend de Claude soient testés contre la
 * même sémantique, sans lancer FFmpeg ni appeler un service externe.
 */

type Row = Record<string, unknown>;

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(RENDER_JOBS_TABLE_SQL);
});

afterEach(() => {
  db.close();
});

interface InsertOptions {
  id: string;
  status?: RenderJobStatus;
  createdAtMs?: number;
  attempts?: number;
  maxAttempts?: number;
  progress?: number;
  workerId?: string | null;
  leaseExpiresAtMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAtMs?: number | null;
  completedAtMs?: number | null;
}

function insertJob(options: InsertOptions): void {
  const {
    id,
    status = 'queued',
    createdAtMs = 1_000,
    attempts = 0,
    maxAttempts = RENDER_JOB_RULES.maxAttempts,
    progress = 0,
    workerId = null,
    leaseExpiresAtMs = null,
    errorCode = null,
    errorMessage = null,
    startedAtMs = null,
    completedAtMs = null,
  } = options;

  db.prepare(
    `INSERT INTO render_jobs
       (id, project_id, project_revision, status, payload, progress, attempts, max_attempts,
        worker_id, lease_expires_at_ms, error_code, error_message,
        created_at_ms, updated_at_ms, started_at_ms, completed_at_ms)
     VALUES
       (:id, 'projet_qa', 3, :status, '{"schemaVersion":1}', :progress, :attempts, :maxAttempts,
        :workerId, :leaseExpiresAtMs, :errorCode, :errorMessage,
        :createdAtMs, :createdAtMs, :startedAtMs, :completedAtMs)`,
  ).run({
    id,
    status,
    progress,
    attempts,
    maxAttempts,
    workerId,
    leaseExpiresAtMs,
    errorCode,
    errorMessage,
    createdAtMs,
    startedAtMs,
    completedAtMs,
  });
}

function readJob(id: string): Row {
  const row = db.prepare('SELECT * FROM render_jobs WHERE id = ?').get(id);
  assert.ok(row, `job « ${id} » introuvable`);
  return row as Row;
}

function claimNext(
  workerId = 'worker_1',
  nowMs = 10_000,
  maxConcurrentRenders = 1,
  leaseMs = RENDER_JOB_RULES.leaseMs,
): Row | undefined {
  return db
    .prepare(RENDER_JOB_SQL.claimNext)
    .get({ workerId, leaseExpiresAtMs: nowMs + leaseMs, nowMs, maxConcurrentRenders }) as Row | undefined;
}

function run(sql: string, parameters: Record<string, string | number | null>): number {
  const result = db.prepare(sql).run(parameters);
  return Number(result.changes);
}

function heartbeat(jobId: string, workerId: string, progress: number, nowMs = 20_000): number {
  return run(RENDER_JOB_SQL.heartbeat, {
    jobId,
    workerId,
    progress,
    leaseExpiresAtMs: nowMs + RENDER_JOB_RULES.leaseMs,
    nowMs,
  });
}

describe('protocole worker : claimNext', () => {
  it('prend le plus ancien job queued et initialise le bail', () => {
    insertJob({ id: 'job_recent', createdAtMs: 2_000 });
    insertJob({ id: 'job_ancien', createdAtMs: 1_000 });

    const claimed = claimNext('worker_1', 10_000);

    assert.ok(claimed);
    assert.equal(claimed.id, 'job_ancien');
    assert.equal(claimed.status, 'rendering');
    assert.equal(claimed.worker_id, 'worker_1');
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.progress, 0);
    assert.equal(claimed.started_at_ms, 10_000);
    assert.equal(claimed.updated_at_ms, 10_000);
    assert.equal(claimed.lease_expires_at_ms, 10_000 + RENDER_JOB_RULES.leaseMs);
    assert.equal(claimed.error_code, null);
    assert.equal(claimed.error_message, null);

    assert.equal(readJob('job_recent').status, 'queued', 'un seul job doit être pris à la fois');
  });

  it('ne prend jamais un job preparing, completed ou failed', () => {
    insertJob({ id: 'job_preparing', status: 'preparing', createdAtMs: 1 });
    insertJob({ id: 'job_completed', status: 'completed', createdAtMs: 2 });
    insertJob({ id: 'job_failed', status: 'failed', createdAtMs: 3 });

    assert.equal(claimNext(), undefined);
    for (const status of ['preparing', 'completed', 'failed']) {
      assert.equal(readJob(`job_${status}`).status, status);
    }
  });

  it('ne dépasse pas la limite de rendus simultanés avec un bail actif', () => {
    insertJob({
      id: 'job_en_cours',
      status: 'rendering',
      workerId: 'worker_0',
      leaseExpiresAtMs: 50_000,
      attempts: 1,
      startedAtMs: 5_000,
    });
    insertJob({ id: 'job_attente', createdAtMs: 2_000 });

    assert.equal(claimNext('worker_1', 10_000, 1), undefined);

    const second = claimNext('worker_1', 10_000, 2);
    assert.ok(second);
    assert.equal(second.id, 'job_attente');
  });

  it('réinitialise progression et erreur d’un job remis en file', () => {
    insertJob({
      id: 'job_repris',
      status: 'queued',
      progress: 0.42,
      errorCode: 'RENDER_WORKER_LOST',
      errorMessage: 'Ancienne erreur',
      createdAtMs: 1_000,
    });

    const claimed = claimNext();
    assert.ok(claimed);
    assert.equal(claimed.progress, 0);
    assert.equal(claimed.error_code, null);
    assert.equal(claimed.error_message, null);
  });

  it('attribue le job à un seul worker quand deux appels se suivent', () => {
    insertJob({ id: 'job_unique' });

    assert.ok(claimNext('worker_1', 10_000, 1));
    assert.equal(claimNext('worker_2', 10_001, 1), undefined);
    assert.equal(readJob('job_unique').worker_id, 'worker_1');
  });
});

describe('protocole worker : heartbeat', () => {
  it('publie la progression et renouvelle le bail du worker propriétaire', () => {
    insertJob({ id: 'job_heartbeat' });
    assert.ok(claimNext('worker_1', 10_000));

    const changes = heartbeat('job_heartbeat', 'worker_1', 0.35, 20_000);
    assert.equal(changes, 1);

    const job = readJob('job_heartbeat');
    assert.equal(job.progress, 0.35);
    assert.equal(job.lease_expires_at_ms, 20_000 + RENDER_JOB_RULES.leaseMs);
    assert.equal(job.updated_at_ms, 20_000);
    assert.equal(job.status, 'rendering');
  });

  it('ignore un worker qui ne détient pas le job (bail perdu)', () => {
    insertJob({ id: 'job_heartbeat' });
    assert.ok(claimNext('worker_1'));

    assert.equal(heartbeat('job_heartbeat', 'worker_2', 0.9), 0);
    assert.equal(readJob('job_heartbeat').progress, 0);
  });

  it('ignore un job qui n’est plus rendering', () => {
    insertJob({ id: 'job_completed', status: 'completed', progress: 1 });

    assert.equal(heartbeat('job_completed', 'worker_1', 0.5), 0);
    assert.equal(readJob('job_completed').progress, 1);
  });

  it('refuse une progression hors [0, 1] : le worker doit borner avant l’UPDATE', () => {
    insertJob({ id: 'job_bornes' });
    assert.ok(claimNext('worker_1'));

    assert.throws(() => heartbeat('job_bornes', 'worker_1', 1.2), /CHECK constraint failed/);
    assert.throws(() => heartbeat('job_bornes', 'worker_1', -0.1), /CHECK constraint failed/);

    assert.equal(heartbeat('job_bornes', 'worker_1', 0), 1);
    assert.equal(heartbeat('job_bornes', 'worker_1', 1), 1);
  });
});

describe('protocole worker : complete et fail', () => {
  it('termine un rendu seulement pour le worker propriétaire', () => {
    insertJob({ id: 'job_fin' });
    assert.ok(claimNext('worker_1'));
    assert.equal(heartbeat('job_fin', 'worker_1', 0.8), 1);

    const complete = {
      jobId: 'job_fin',
      workerId: 'worker_1',
      outputSizeBytes: 1_234_567,
      outputDurationSeconds: 30.033,
      nowMs: 30_000,
    };

    assert.equal(run(RENDER_JOB_SQL.complete, { ...complete, workerId: 'worker_2' }), 0);
    assert.equal(readJob('job_fin').status, 'rendering');

    assert.equal(run(RENDER_JOB_SQL.complete, complete), 1);
    const job = readJob('job_fin');
    assert.equal(job.status, 'completed');
    assert.equal(job.progress, 1);
    assert.equal(job.output_size_bytes, 1_234_567);
    assert.equal(job.output_duration_seconds, 30.033);
    assert.equal(job.completed_at_ms, 30_000);
    assert.equal(job.lease_expires_at_ms, null);
    assert.equal(heartbeat('job_fin', 'worker_1', 0.9, 31_000), 0, 'un job terminé ne reçoit plus de heartbeat');
  });

  it('ne termine pas un job encore queued', () => {
    insertJob({ id: 'job_attente' });

    assert.equal(
      run(RENDER_JOB_SQL.complete, {
        jobId: 'job_attente',
        workerId: 'worker_1',
        outputSizeBytes: 1,
        outputDurationSeconds: 1,
        nowMs: 1_000,
      }),
      0,
    );
    assert.equal(readJob('job_attente').status, 'queued');
  });

  it('marque un échec définitif avec un message utilisateur', () => {
    insertJob({ id: 'job_echec' });
    assert.ok(claimNext('worker_1'));

    const fail = {
      jobId: 'job_echec',
      workerId: 'worker_1',
      errorCode: 'RENDER_FFMPEG_FAILED',
      errorMessage: "Le rendu a échoué. Vérifiez la vidéo puis relancez l'export.",
      nowMs: 40_000,
    };

    assert.equal(run(RENDER_JOB_SQL.fail, { ...fail, workerId: 'worker_2' }), 0);
    assert.equal(run(RENDER_JOB_SQL.fail, fail), 1);

    const job = readJob('job_echec');
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'RENDER_FFMPEG_FAILED');
    assert.equal(job.error_message, fail.errorMessage);
    assert.equal(job.completed_at_ms, 40_000);
    assert.equal(job.lease_expires_at_ms, null);
    assert.doesNotMatch(String(job.error_message), /[A-Za-z]:\\|\/home\/|\/Users\/|ENOENT|at\s+\S+\.ts/);
  });

  it('ne fait pas échouer un job déjà terminé ou encore queued', () => {
    insertJob({ id: 'job_termine', status: 'completed', progress: 1, completedAtMs: 5_000 });
    insertJob({ id: 'job_attente' });

    const fail = {
      jobId: 'job_termine',
      workerId: 'worker_1',
      errorCode: 'RENDER_FFMPEG_FAILED',
      errorMessage: 'Échec',
      nowMs: 50_000,
    };
    assert.equal(run(RENDER_JOB_SQL.fail, fail), 0);
    assert.equal(run(RENDER_JOB_SQL.fail, { ...fail, jobId: 'job_attente' }), 0);
    assert.equal(readJob('job_termine').status, 'completed');
    assert.equal(readJob('job_attente').status, 'queued');
  });
});

describe('protocole worker : recoverStale (worker perdu)', () => {
  it('remet en file un job expiré s’il reste une tentative', () => {
    insertJob({ id: 'job_perdu' });
    assert.ok(claimNext('worker_1', 10_000));
    assert.equal(heartbeat('job_perdu', 'worker_1', 0.4, 20_000), 1);

    const recovered = run(RENDER_JOB_SQL.recoverStale, { nowMs: 20_000 + RENDER_JOB_RULES.leaseMs + 1 });
    assert.equal(recovered, 1);

    const job = readJob('job_perdu');
    assert.equal(job.status, 'queued');
    assert.equal(job.worker_id, null);
    assert.equal(job.lease_expires_at_ms, null);
    assert.equal(job.error_code, null);
    assert.equal(job.error_message, null);
    assert.equal(job.completed_at_ms, null);

    const reclaimed = claimNext('worker_2', 100_000, 1, 60_000);
    assert.ok(reclaimed);
    assert.equal(reclaimed.attempts, 2);
    assert.equal(reclaimed.progress, 0, 'la progression repart de zéro au nouveau claim');
  });

  it('échoue définitivement après la dernière tentative avec RENDER_WORKER_LOST', () => {
    insertJob({ id: 'job_perdu' });
    assert.ok(claimNext('worker_1', 10_000));
    run(RENDER_JOB_SQL.recoverStale, { nowMs: 80_000 });

    assert.ok(claimNext('worker_2', 100_000));
    assert.equal(readJob('job_perdu').attempts, 2);

    const expiredAt = 100_000 + RENDER_JOB_RULES.leaseMs + 1;
    assert.equal(run(RENDER_JOB_SQL.recoverStale, { nowMs: expiredAt }), 1);

    const job = readJob('job_perdu');
    assert.equal(job.status, 'failed');
    assert.equal(job.error_code, 'RENDER_WORKER_LOST');
    assert.equal(job.completed_at_ms, expiredAt);
    assert.equal(job.worker_id, null);
    assert.equal(job.lease_expires_at_ms, null);
    assert.match(String(job.error_message), /rendu a été interrompu/i);
    assert.doesNotMatch(String(job.error_message), /[A-Za-z]:\\|\/home\/|\/Users\/|ENOENT/);

    assert.equal(claimNext('worker_3', expiredAt + 1), undefined, 'un job épuisé ne doit jamais être repris');
  });

  it('ne touche ni un bail encore valide, ni un job queued, ni un job terminé', () => {
    insertJob({
      id: 'job_actif',
      status: 'rendering',
      workerId: 'worker_1',
      leaseExpiresAtMs: 100_000,
      attempts: 1,
      startedAtMs: 50_000,
    });
    insertJob({ id: 'job_attente', attempts: 0 });
    insertJob({ id: 'job_fini', status: 'completed', progress: 1, completedAtMs: 90_000 });

    assert.equal(run(RENDER_JOB_SQL.recoverStale, { nowMs: 99_000 }), 0);
    assert.equal(readJob('job_actif').status, 'rendering');
    assert.equal(readJob('job_attente').status, 'queued');
    assert.equal(readJob('job_fini').status, 'completed');
  });
});

describe('protocole worker : parcours complet', () => {
  it('queued → rendering → completed conserve l’instantané du payload', () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      source: { file: 'source/source-30s.mp4', durationSeconds: 30, width: 640, height: 360, frameRate: 30, audioPresent: true },
      output: { file: 'output/rendu.mp4', width: 640, height: 360, frameRate: 30 },
      segments: [],
    });
    insertJob({ id: 'job_parcours', createdAtMs: 1_000 });
    db.prepare('UPDATE render_jobs SET payload = ? WHERE id = ?').run(payload, 'job_parcours');

    assert.ok(claimNext('worker_1', 10_000));
    assert.equal(heartbeat('job_parcours', 'worker_1', 0.5), 1);
    assert.equal(
      run(RENDER_JOB_SQL.complete, {
        jobId: 'job_parcours',
        workerId: 'worker_1',
        outputSizeBytes: 2_000_000,
        outputDurationSeconds: 30,
        nowMs: 25_000,
      }),
      1,
    );

    const job = readJob('job_parcours');
    assert.equal(job.status, 'completed');
    assert.equal(job.payload, payload, 'le payload ne doit jamais être réécrit par le worker');
    assert.equal(job.project_revision, 3);
  });
});
