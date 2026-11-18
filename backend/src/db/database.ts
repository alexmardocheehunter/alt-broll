import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RENDER_JOBS_TABLE_SQL } from '../contract.ts';

const IN_MEMORY_DATABASE = ':memory:';

/** Attente maximale d'un verrou tenu par l'autre processus (backend ou worker). */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Table propre au backend : le worker n'y accède pas. Le contenu du projet est
 * un document JSON (source, transcription, analyse, B-rolls) ; identité et
 * révision sont en colonnes pour les écritures concurrentes (revision = n).
 */
const PROJECTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id             TEXT    PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  revision       INTEGER NOT NULL DEFAULT 0,
  document       TEXT    NOT NULL,
  created_at_ms  INTEGER NOT NULL,
  updated_at_ms  INTEGER NOT NULL
);
`;

interface Migration {
  readonly version: number;
  readonly description: string;
  readonly sql: string;
}

/** Migrations appliquées dans l'ordre ; ne jamais modifier une migration déjà livrée. */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'projects + render_jobs (contrat v1)',
    sql: PROJECTS_TABLE_SQL + RENDER_JOBS_TABLE_SQL,
  },
];

export const DATABASE_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

/** Ouvre (ou crée) la base SQLite et applique les migrations manquantes. */
export function openDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== IN_MEMORY_DATABASE) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function migrate(db: DatabaseSync): void {
  const current = readSchemaVersion(db);
  if (current > DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `La base SQLite est en version ${current}, plus récente que ce backend (${DATABASE_SCHEMA_VERSION}).`,
    );
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();
  return Number(row?.user_version ?? 0);
}
