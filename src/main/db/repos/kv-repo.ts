// Pares clave/valor cifrados de la tabla `kv` (docs/DESIGN.md §9.2). Las claves son cerradas y cada
// valor se valida con zod al escribir y al leer. P6: funciones con `db` como primer parámetro
// (SessionManager.getDb(epoch) es el único sitio que entrega la DB).
import { z } from 'zod';
import { AppErrorException } from '@shared/errors';
import { ID_PATTERN, PRESENTATION_LIMITS } from '@shared/constants';
import type { Id } from '@shared/types';
import { log } from '../../log';
import type { Db } from '../database';

export const KV_DEFAULT_TRACKS = 'presentation.defaultTracks';
export const KV_IMPORT_REPLACE_PREFIX = 'import.replace.';

export type KvKey = typeof KV_DEFAULT_TRACKS | `${typeof KV_IMPORT_REPLACE_PREFIX}${string}`;

/** Sustitución de un duplicado dañado entre sus dos transacciones (§12.7, punto 3). */
export interface ImportReplaceValue {
  old: Id;
  /** 64 hex en minúsculas (la transacción A escribe lower(hex(:hmac))). */
  hmac: string;
}

export type KvValue<K extends KvKey> = K extends typeof KV_DEFAULT_TRACKS
  ? Id[]
  : ImportReplaceValue;

const idSchema = z.string().regex(ID_PATTERN);

const DEFAULT_TRACKS_SCHEMA = z
  .array(idSchema)
  .max(PRESENTATION_LIMITS.trackIdsMax)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'duplicados' });

const IMPORT_REPLACE_SCHEMA = z.strictObject({
  old: idSchema,
  hmac: z.string().regex(/^[0-9a-f]{64}$/),
});

const IMPORT_REPLACE_KEY = /^import\.replace\.[0-9a-f]{32}$/;

function schemaFor(key: string): z.ZodType | null {
  if (key === KV_DEFAULT_TRACKS) return DEFAULT_TRACKS_SCHEMA;
  if (IMPORT_REPLACE_KEY.test(key)) return IMPORT_REPLACE_SCHEMA;
  return null;
}

function requireSchema(key: string): z.ZodType {
  const schema = schemaFor(key);
  if (!schema) throw new AppErrorException({ code: 'VALIDATION', details: { reason: 'kv-key' } });
  return schema;
}

export function isKvKey(key: string): key is KvKey {
  return schemaFor(key) !== null;
}

export function importReplaceKey(newId: Id): KvKey {
  const key = `${KV_IMPORT_REPLACE_PREFIX}${newId}`;
  requireSchema(key);
  return key as KvKey;
}

/** Valor guardado, o null si no existe. Un valor guardado que no valida se trata como ausente. */
export function kvGet<K extends KvKey>(db: Db, key: K): KvValue<K> | null {
  const schema = requireSchema(key);
  const row = db.prepare('SELECT value_json FROM kv WHERE key = ?').get(key) as
    { value_json: string } | undefined;
  if (!row) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value_json);
  } catch {
    log.warn('kv.invalid-value');
    return null;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    log.warn('kv.invalid-value');
    return null;
  }
  return result.data as KvValue<K>;
}

/** Inserta o sustituye. Clave desconocida o valor que no valida → VALIDATION, sin escribir. */
export function kvSet<K extends KvKey>(db: Db, key: K, value: KvValue<K>): void {
  const schema = requireSchema(key);
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppErrorException({ code: 'VALIDATION', details: { reason: 'kv-value' } });
  }
  db.prepare(
    'INSERT INTO kv (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  ).run(key, JSON.stringify(result.data));
}

export function kvDelete(db: Db, key: KvKey): boolean {
  requireSchema(key);
  return db.prepare('DELETE FROM kv WHERE key = ?').run(key).changes > 0;
}
