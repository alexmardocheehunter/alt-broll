import type { DatabaseSync } from 'node:sqlite';
import type { RenderJobRow } from '../contract.ts';

/** Lecture des jobs de rendu (table render_jobs, écrite aussi par le worker). */
export interface RenderJobRepository {
  latestForProject(projectId: string): RenderJobRow | null;
  /** true si un export est en préparation, en file ou en cours pour ce projet. */
  hasActiveJob(projectId: string): boolean;
}

export function createRenderJobRepository(db: DatabaseSync): RenderJobRepository {
  const latestStatement = db.prepare(
    'SELECT * FROM render_jobs WHERE project_id = ? ORDER BY created_at_ms DESC, id DESC LIMIT 1',
  );
  const activeStatement = db.prepare(
    `SELECT 1 AS active FROM render_jobs
      WHERE project_id = ? AND status IN ('preparing', 'queued', 'rendering')
      LIMIT 1`,
  );

  return {
    latestForProject: (projectId) => (latestStatement.get(projectId) as RenderJobRow | undefined) ?? null,
    hasActiveJob: (projectId) => activeStatement.get(projectId) !== undefined,
  };
}
