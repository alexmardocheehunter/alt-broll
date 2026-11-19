import type { DatabaseSync } from 'node:sqlite';
import {
  SCHEMA_VERSION,
  type Analysis,
  type AnalysisStatus,
  type BrollItem,
  type SchemaVersion,
  type SourceVideo,
  type Transcript,
} from '../contract.ts';
import { ACTIVE_STATUSES } from './job.repository.ts';

/** Contenu stocké dans projects.document ; identité, dates et révision sont en colonnes. */
export interface ProjectDocument {
  source: SourceVideo | null;
  transcript: Transcript | null;
  analysis: Analysis;
  brollItems: BrollItem[];
  /**
   * Compte propriétaire (uid Firebase) quand la connexion Google est activée (AUTH_MODE=firebase).
   * Absent sinon. Jamais renvoyé par l'API.
   */
  ownerId?: string;
}

export type RemoveResult = 'deleted' | 'not_found' | 'render_active';

export interface ProjectRecord {
  readonly id: string;
  readonly schemaVersion: SchemaVersion;
  readonly revision: number;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly document: ProjectDocument;
}

export interface ProjectRepository {
  insert(id: string, document: ProjectDocument, nowMs: number): ProjectRecord;
  findById(id: string): ProjectRecord | null;
  /** Écrit le document si la révision n'a pas changé (revision + 1) ; null sinon (conflit ou projet absent). */
  update(id: string, expectedRevision: number, document: ProjectDocument, nowMs: number): ProjectRecord | null;
  /** Projets dont l'analyse est dans l'un de ces statuts (reprise après un arrêt du serveur). */
  listIdsByAnalysisStatus(statuses: readonly AnalysisStatus[]): string[];
  /**
   * Supprime le projet et l'historique de ses exports, en une transaction. Refusé si un export
   * est en préparation, en file ou en cours : le worker pourrait encore écrire.
   */
  remove(id: string): RemoveResult;
}

type ProjectRow = {
  id: string;
  schema_version: number;
  revision: number;
  document: string;
  created_at_ms: number;
  updated_at_ms: number;
};

export function createProjectRepository(db: DatabaseSync): ProjectRepository {
  const insertStatement = db.prepare(
    `INSERT INTO projects (id, schema_version, revision, document, created_at_ms, updated_at_ms)
     VALUES (:id, :schemaVersion, 0, :document, :nowMs, :nowMs)`,
  );
  const selectStatement = db.prepare('SELECT * FROM projects WHERE id = ?');
  const updateStatement = db.prepare(
    `UPDATE projects
        SET document = :document, revision = revision + 1, updated_at_ms = :nowMs
      WHERE id = :id AND revision = :expectedRevision`,
  );
  const byAnalysisStatusStatement = db.prepare(
    `SELECT id FROM projects
      WHERE json_extract(document, '$.analysis.status') IN (SELECT value FROM json_each(?))
      ORDER BY created_at_ms`,
  );
  const activeRenderStatement = db.prepare(
    `SELECT 1 AS active FROM render_jobs WHERE project_id = ? AND status IN ${ACTIVE_STATUSES} LIMIT 1`,
  );
  const deleteJobsStatement = db.prepare('DELETE FROM render_jobs WHERE project_id = ?');
  const deleteStatement = db.prepare('DELETE FROM projects WHERE id = ?');

  function findById(id: string): ProjectRecord | null {
    const row = selectStatement.get(id) as ProjectRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  return {
    insert(id, document, nowMs) {
      insertStatement.run({ id, schemaVersion: SCHEMA_VERSION, document: JSON.stringify(document), nowMs });
      const record = findById(id);
      if (record === null) throw new Error(`Projet ${id} introuvable juste après sa création.`);
      return record;
    },
    findById,
    update(id, expectedRevision, document, nowMs) {
      const result = updateStatement.run({ id, expectedRevision, document: JSON.stringify(document), nowMs });
      return Number(result.changes) === 1 ? findById(id) : null;
    },
    listIdsByAnalysisStatus(statuses) {
      return byAnalysisStatusStatement.all(JSON.stringify(statuses)).map((row) => String(row.id));
    },
    remove(id) {
      // IMMEDIATE : le worker ne peut pas prendre un job entre la vérification et la suppression.
      db.exec('BEGIN IMMEDIATE');
      try {
        let result: RemoveResult = 'deleted';
        if (activeRenderStatement.get(id) !== undefined) {
          result = 'render_active';
        } else {
          deleteJobsStatement.run(id);
          if (Number(deleteStatement.run(id).changes) !== 1) result = 'not_found';
        }
        db.exec(result === 'deleted' ? 'COMMIT' : 'ROLLBACK');
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function toRecord(row: ProjectRow): ProjectRecord {
  if (row.schema_version !== SCHEMA_VERSION) {
    throw new Error(`Projet ${row.id} : version de schéma ${row.schema_version} non prise en charge.`);
  }
  return {
    id: row.id,
    schemaVersion: SCHEMA_VERSION,
    revision: row.revision,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    document: JSON.parse(row.document) as ProjectDocument,
  };
}
