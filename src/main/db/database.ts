// Apertura de la DB cifrada con SQLCipher (docs/DESIGN.md §9.1), con better-sqlite3-multiple-ciphers.
//
// - Esquema `sqlcipher` en modo `legacy = 4` (AES-256-CBC + HMAC-SHA512 por página, page_size 4096).
// - Clave cruda: rawKeyArg() escribe x'<64 hex>' directamente en un Buffer con una tabla de
//   búsqueda, sin crear ningún string con la clave, y se pone a cero justo después de db.key().
//   Al ser cruda no se ejecuta el KDF de SQLCipher. El spike confirmó que db.key(Buffer) acepta esta
//   forma (R5 resuelto), así que el plan B de §9.1 no hace falta.
// - temp_store = MEMORY: ningún temporal de SQLite en disco sin cifrar. El WAL también va cifrado.
//
// K_db pertenece al KeyRing: este módulo no la pone a cero.
import Database from 'better-sqlite3-multiple-ciphers';
import { AppErrorException } from '@shared/errors';
import { log } from '../log';
import { KEY_LEN, zeroize } from '../crypto/secure-buffer';

export type Db = Database.Database;

export const DB_FILE_NAME = 'library.db';
/** Longitud de x'<64 hex>'. */
export const RAW_KEY_ARG_LEN = 3 + 2 * KEY_LEN;

const HEX = Buffer.from('0123456789abcdef', 'latin1');

/** Buffer ASCII de 67 bytes `x'<64 hex>'`, construido byte a byte (sin strings con la clave). */
export function rawKeyArg(kDb: Buffer): Buffer {
  if (kDb.length !== KEY_LEN) throw new RangeError('K_db de 32 bytes');
  const out = Buffer.alloc(RAW_KEY_ARG_LEN);
  out[0] = 0x78; // x
  out[1] = 0x27; // '
  for (let i = 0; i < KEY_LEN; i += 1) {
    const byte = kDb[i] as number;
    out[2 + 2 * i] = HEX[byte >> 4] as number;
    out[3 + 2 * i] = HEX[byte & 0x0f] as number;
  }
  out[RAW_KEY_ARG_LEN - 1] = 0x27; // '
  return out;
}

function sqliteCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Abre (o crea, con `creating`) la DB de la bóveda con la clave cruda K_db.
 * Errores: clave incorrecta o archivo que no es una DB SQLCipher (SQLITE_NOTADB, SQLITE_CORRUPT)
 * → VAULT_CORRUPT { stage: 'open' }; cualquier otro (no existe, E/S) → IO. Se registra un `error`
 * con el código de SQLite; nunca el mensaje (lleva rutas).
 */
export function openDatabase(path: string, kDb: Buffer, options: { creating: boolean }): Db {
  let db: Db | null = null;
  try {
    db = new Database(path, { fileMustExist: !options.creating });
    db.pragma("cipher = 'sqlcipher'");
    db.pragma('legacy = 4');
    const keyArg = rawKeyArg(kDb);
    try {
      db.key(keyArg);
    } finally {
      zeroize(keyArg);
    }
    db.prepare('SELECT count(*) FROM sqlite_master').get(); // clave incorrecta → SQLITE_NOTADB
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
    db.pragma('foreign_keys = ON');
    db.pragma('temp_store = MEMORY');
    db.pragma('secure_delete = ON');
    db.pragma('busy_timeout = 5000');
    return db;
  } catch (err) {
    try {
      db?.close();
    } catch {
      // ya cerrada
    }
    const errno = sqliteCode(err);
    log.error('db.open-failed', { errno, stage: 'open' });
    if (errno === 'SQLITE_NOTADB' || errno === 'SQLITE_CORRUPT') {
      throw new AppErrorException({ code: 'VAULT_CORRUPT', details: { stage: 'open' } });
    }
    throw new AppErrorException({ code: 'IO' });
  }
}

/** Cierra sin lanzar (bloqueo, §13.3 paso 4: SQLite3MultipleCiphers limpia su contexto de clave). */
export function closeDatabase(db: Db | null | undefined): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // ya cerrada
  }
}
