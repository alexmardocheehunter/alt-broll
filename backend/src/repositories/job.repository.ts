import type { DatabaseSync } from 'node:sqlite';
import type { ErrorCode, RenderJobRow } from '../contract.ts';

export interface NewRenderJob {
  readonly id: string;
  readonly projectId: string;
  readonly projectRevision: number;
  /** JSON d'un RenderJobPayload. */
  readonly payload: string;
  readonly maxAttempts: number;
  readonly nowMs: number;
}

/**
 * Table render_jobs : le backend crée les jobs et gère l'étape « preparing » ;
 * le worker prend la suite à partir de « queued » (requêtes RENDER_JOB_SQL du contrat).
 */
export interface RenderJobRepository {
  latestForProject(projectId: string): RenderJobRow | null;
  findById(jobId: string): RenderJobRow | null;
  /** true si un export est en préparation, en file ou en cours pour ce projet. */
  hasActiveJob(projectId: string): boolean;
  /** Crée le job en « preparing » seulement si aucun autre export n'est actif ; false sinon. */
  insertPreparing(job: NewRenderJob): boolean;
  /** B-rolls prêts : payload définitif et passage en « queued » pour le worker. */
  markQueued(jobId: string, payload: string, nowMs: number): boolean;
  markPreparationFailed(jobId: string, code: ErrorCode, message: string, nowMs: number): boolean;
  /** Préparations interrompues par un arrêt du serveur ; renvoie leur nombre. */
  failInterruptedPreparations(message: string, nowMs: number): number;
}

/** Statuts d'un export en cours, pour les clauses `status IN …`. */
export const ACTIVE_STATUSES = "('preparing', 'queued', 'rendering')";

export function createRenderJobRepository(db: DatabaseSync): RenderJobRepository {
  const latestStatement = db.prepare(
    'SELECT * FROM render_jobs WHERE project_id = ? ORDER BY created_at_ms DESC, id DESC LIMIT 1',
  );
  const byIdStatement = db.prepare('SELECT * FROM render_jobs WHERE id = ?');
  const activeStatement = db.prepare(
    `SELECT 1 AS active FROM render_jobs WHERE project_id = ? AND status IN ${ACTIVE_STATUSES} LIMIT 1`,
  );
  const insertStatement = db.prepare(
    `INSERT INTO render_jobs (id, project_id, project_revision, status, payload, max_attempts, created_at_ms, updated_at_ms)
     SELECT :id, :projectId, :projectRevision, 'preparing', :payload, :maxAttempts, :nowMs, :nowMs
      WHERE NOT EXISTS (SELECT 1 FROM render_jobs WHERE project_id = :projectId AND status IN ${ACTIVE_STATUSES})`,
  );
  const queuedStatement = db.prepare(
    `UPDATE render_jobs SET status = 'queued', payload = :payload, updated_at_ms = :nowMs
      WHERE id = :jobId AND status = 'preparing'`,
  );
  const failedStatement = db.prepare(
    `UPDATE render_jobs
        SET status = 'failed', error_code = :errorCode, error_message = :errorMessage,
            completed_at_ms = :nowMs, updated_at_ms = :nowMs
      WHERE id = :jobId AND status = 'preparing'`,
  );
  const interruptedStatement = db.prepare(
    `UPDATE render_jobs
        SET status = 'failed', error_code = 'RENDER_INTERRUPTED', error_message = :errorMessage,
            completed_at_ms = :nowMs, updated_at_ms = :nowMs
      WHERE status = 'preparing'`,
  );

  return {
    latestForProject: (projectId) => (latestStatement.get(projectId) as RenderJobRow | undefined) ?? null,
    findById: (jobId) => (byIdStatement.get(jobId) as RenderJobRow | undefined) ?? null,
    hasActiveJob: (projectId) => activeStatement.get(projectId) !== undefined,
    insertPreparing: (job) =>
      Number(
        insertStatement.run({
          id: job.id,
          projectId: job.projectId,
          projectRevision: job.projectRevision,
          payload: job.payload,
          maxAttempts: job.maxAttempts,
          nowMs: job.nowMs,
        }).changes,
      ) === 1,
    markQueued: (jobId, payload, nowMs) => Number(queuedStatement.run({ jobId, payload, nowMs }).changes) === 1,
    markPreparationFailed: (jobId, errorCode, errorMessage, nowMs) =>
      Number(failedStatement.run({ jobId, errorCode, errorMessage, nowMs }).changes) === 1,
    failInterruptedPreparations: (errorMessage, nowMs) => Number(interruptedStatement.run({ errorMessage, nowMs }).changes),
  };
}
