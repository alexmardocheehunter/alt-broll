import type { DatabaseSync } from 'node:sqlite';
import {
  SCHEMA_VERSION,
  type Analysis,
  type BrollItem,
  type SchemaVersion,
  type SourceVideo,
  type Transcript,
} from '../contract.ts';

/** Contenu stocké dans projects.document ; identité, dates et révision sont en colonnes. */
export interface ProjectDocument {
  source: SourceVideo | null;
  transcript: Transcript | null;
  analysis: Analysis;
  brollItems: BrollItem[];
}

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
