// Migraciones (docs/DESIGN.md §9.3). Al abrir, si user_version < última:
//   1. checkpoint del WAL;
//   2. copia del archivo cifrado a library.db.bak-v<actual>;
//   3. BEGIN IMMEDIATE, se aplican las pendientes, user_version = n, COMMIT;
//   4. se borra el .bak si todo fue bien.
// Si falla: ROLLBACK, se conserva el .bak, VAULT_CORRUPT { stage: 'migration' } y un `error`.
// Una DB con user_version mayor que la conocida → VAULT_CORRUPT { stage: 'newer-version' } y no
// se toca. Todo es síncrono (better-sqlite3): ninguna transacción abarca un await (§13.3).
import { copyFileSync, rmSync } from 'node:fs';
import { AppErrorException } from '@shared/errors';
import { log } from '../log';
import type { Db } from './database';
import { MIGRATIONS, type Migration } from './migrations';

export function backupPath(dbPath: string, version: number): string {
  return `${dbPath}.bak-v${version}`;
}

export function userVersion(db: Db): number {
  return Number(db.pragma('user_version', { simple: true }));
}

export function latestVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

/** Aplica las migraciones pendientes. `dbPath` es la ruta del archivo de `db` (para el .bak). */
export function migrate(
  db: Db,
  dbPath: string,
  migrations: readonly Migration[] = MIGRATIONS,
): void {
  const latest = latestVersion(migrations);
  const current = userVersion(db);
  if (current > latest) {
    log.error('db.newer-version', { count: current });
    throw new AppErrorException({ code: 'VAULT_CORRUPT', details: { stage: 'newer-version' } });
  }
  if (current === latest) return;

  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
  const bak = backupPath(dbPath, current);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    copyFileSync(dbPath, bak); // ciphertext: la copia tampoco es legible sin K_db
    db.exec('BEGIN IMMEDIATE');
    for (const m of pending) db.exec(m.sql);
    db.pragma(`user_version = ${latest}`);
    db.exec('COMMIT');
  } catch (err) {
    if (db.inTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // la transacción ya no existe
      }
    }
    const errno = (err as { code?: unknown } | null)?.code;
    log.error('db.migration-failed', {
      count: current,
      errno: typeof errno === 'string' ? errno : undefined,
    });
    throw new AppErrorException({ code: 'VAULT_CORRUPT', details: { stage: 'migration' } });
  }
  rmSync(bak, { force: true });
  log.info('db.migrated', { count: latest });
}
