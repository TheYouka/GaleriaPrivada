// Jerarquía de claves (docs/DESIGN.md §6.2–§6.7):
//
//   contraseña ──Argon2id──▶ KEK ──AES-GCM unwrap──▶ MK (32 B aleatoria, no cambia nunca)
//   MK ──HKDF-SHA256(salt = profileId 16 B)──▶ K_db, K_wrap, K_dedup
//   Por objeto: DEK aleatoria envuelta con K_wrap en la cabecera (§7.2)
//
// Siempre AES-256-GCM con nonce de 12 bytes y authTagLength: 16 al cifrar y al descifrar (DEP0182:
// un tag truncado nunca valida). Las claves viven en búferes propios (secure-buffer.ts) y se ponen
// a cero en cuanto dejan de usarse, también en las rutas de error.
import { createCipheriv, createDecipheriv, hkdfSync } from 'node:crypto';
import { AppErrorException } from '@shared/errors';
import { ID_BYTES, ID_PATTERN } from '@shared/constants';
import { DEK_LEN, NONCE_LEN, TAG } from './file-format';
import { SALT_LEN, type KdfParams } from './kdf';
import { KEY_LEN, randomOwned, takeOwned, zeroize } from './secure-buffer';

export const GCM = 'aes-256-gcm';
export const AUTH_TAG_LENGTH = TAG;

/** masterKeyWrap de profiles.json (§6.2), con los bytes ya decodificados de base64. */
export interface MasterKeyWrap {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

export const HKDF_INFO = Object.freeze({
  db: 'galeria/v1/db',
  wrap: 'galeria/v1/file-wrap',
  dedup: 'galeria/v1/dedup',
});

const MK_WRAP_LABEL = 'galeria/v1/mk-wrap';

// ── AES-256-GCM de una clave de 32 bytes ───────────────────────────────────────────────────────

interface Wrapped {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function gcmWrapKey(kek: Buffer, key: Buffer, aad: Buffer): Wrapped {
  if (kek.length !== KEY_LEN || key.length !== KEY_LEN) throw new RangeError('clave de 32 bytes');
  const nonce = randomOwned(NONCE_LEN);
  const cipher = createCipheriv(GCM, kek, nonce, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  return { nonce, ciphertext, tag: cipher.getAuthTag() };
}

/** Devuelve la clave en un búfer propio, o null si el tag no valida (o las longitudes no cuadran). */
function gcmUnwrapKey(kek: Buffer, w: Wrapped, aad: Buffer): Buffer | null {
  if (kek.length !== KEY_LEN) throw new RangeError('clave de 32 bytes');
  if (w.nonce.length !== NONCE_LEN || w.ciphertext.length !== KEY_LEN || w.tag.length !== TAG) {
    return null;
  }
  const decipher = createDecipheriv(GCM, kek, w.nonce, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(aad);
  decipher.setAuthTag(w.tag);
  // §6.7: la salida de update se copia a un búfer propio y se pone a cero; final() no da bytes.
  const out = takeOwned(decipher.update(w.ciphertext));
  try {
    decipher.final();
    return out;
  } catch {
    zeroize(out);
    return null;
  }
}

// ── Clave maestra (§6.2) ───────────────────────────────────────────────────────────────────────

/** profileId de 32 hex → 16 bytes crudos. */
export function profileIdBytes(profileId: string): Buffer {
  if (!ID_PATTERN.test(profileId)) throw new RangeError('profileId inválido');
  const out = Buffer.alloc(ID_BYTES);
  out.write(profileId, 'hex');
  return out;
}

/**
 * AAD_mk = utf8("galeria/v1/mk-wrap") ‖ 0x00 ‖ profileId (16 B)
 *          ‖ utf8("argon2id$v=19$m=<m>,t=<t>,p=<p>") ‖ 0x00 ‖ salt (16 B)
 */
export function mkWrapAad(profileId: string, params: KdfParams, salt: Buffer): Buffer {
  for (const v of [params.memoryKiB, params.iterations, params.parallelism]) {
    if (!Number.isSafeInteger(v) || v < 1) throw new RangeError('parámetros KDF inválidos');
  }
  if (salt.length !== SALT_LEN) throw new RangeError('sal de 16 bytes');
  const ascii = (s: string): Buffer => Buffer.alloc(s.length, s, 'latin1');
  return Buffer.concat([
    ascii(MK_WRAP_LABEL),
    Buffer.alloc(1),
    profileIdBytes(profileId),
    ascii(`argon2id$v=19$m=${params.memoryKiB},t=${params.iterations},p=${params.parallelism}`),
    Buffer.alloc(1),
    salt,
  ]);
}

/** MK nueva: 32 bytes aleatorios con memoria propia. */
export function generateMasterKey(): Buffer {
  return randomOwned(KEY_LEN);
}

export function wrapMasterKey(
  mk: Buffer,
  kek: Buffer,
  profileId: string,
  params: KdfParams,
  salt: Buffer,
): MasterKeyWrap {
  return gcmWrapKey(kek, mk, mkWrapAad(profileId, params, salt));
}

/**
 * La contraseña es correcta si y solo si el tag valida (§6.5): si no, WRONG_PASSWORD. Una envoltura
 * copiada de otro perfil o con los parámetros o la sal editados tampoco valida (AAD).
 */
export function unwrapMasterKey(
  wrap: MasterKeyWrap,
  kek: Buffer,
  profileId: string,
  params: KdfParams,
  salt: Buffer,
): Buffer {
  const mk = gcmUnwrapKey(kek, wrap, mkWrapAad(profileId, params, salt));
  if (!mk) throw new AppErrorException({ code: 'WRONG_PASSWORD' });
  return mk;
}

/**
 * Cambio de contraseña al nivel de claves (§6.6): desenvuelve la MK con la KEK actual y la vuelve a
 * envolver con la nueva (nonce nuevo; la sal y los parámetros nuevos van en la AAD). La MK no
 * cambia, así que la DB y los objetos no se tocan. La MK intermedia se pone a cero; las KEK son del
 * llamador.
 */
export function rewrapMasterKey(
  profileId: string,
  current: { wrap: MasterKeyWrap; kek: Buffer; params: KdfParams; salt: Buffer },
  next: { kek: Buffer; params: KdfParams; salt: Buffer },
): MasterKeyWrap {
  const mk = unwrapMasterKey(current.wrap, current.kek, profileId, current.params, current.salt);
  try {
    return wrapMasterKey(mk, next.kek, profileId, next.params, next.salt);
  } finally {
    zeroize(mk);
  }
}

// ── Claves derivadas (§6.3) ────────────────────────────────────────────────────────────────────

export interface DerivedKeys {
  kDb: Buffer;
  kWrap: Buffer;
  kDedup: Buffer;
}

function hkdf(mk: Buffer, salt: Buffer, info: string): Buffer {
  // hkdfSync devuelve un ArrayBuffer propio y Buffer.from(arrayBuffer) lo envuelve sin copiar: fill(0)
  // borra la única copia que maneja JS (§6.7).
  return Buffer.from(hkdfSync('sha256', mk, salt, info, KEY_LEN));
}

export function deriveKeys(mk: Buffer, profileId: string): DerivedKeys {
  if (mk.length !== KEY_LEN) throw new RangeError('MK de 32 bytes');
  const salt = profileIdBytes(profileId);
  return {
    kDb: hkdf(mk, salt, HKDF_INFO.db),
    kWrap: hkdf(mk, salt, HKDF_INFO.wrap),
    kDedup: hkdf(mk, salt, HKDF_INFO.dedup),
  };
}

// ── DEK de cada objeto (§7.2) ──────────────────────────────────────────────────────────────────

export interface WrappedDek {
  wrapNonce: Buffer;
  wrappedDek: Buffer;
  wrapTag: Buffer;
}

/** AES-256-GCM(K_wrap, wrapNonce aleatorio, DEK, AAD = header[0, 48)). */
export function wrapDek(dek: Buffer, kWrap: Buffer, headerAad: Buffer): WrappedDek {
  if (dek.length !== DEK_LEN) throw new RangeError('DEK de 32 bytes');
  const w = gcmWrapKey(kWrap, dek, headerAad);
  return { wrapNonce: w.nonce, wrappedDek: w.ciphertext, wrapTag: w.tag };
}

/** DEK en un búfer propio, o INTEGRITY si la cabecera fue manipulada o la K_wrap es otra. */
export function unwrapDek(w: WrappedDek, kWrap: Buffer, headerAad: Buffer): Buffer {
  const dek = gcmUnwrapKey(
    kWrap,
    { nonce: w.wrapNonce, ciphertext: w.wrappedDek, tag: w.wrapTag },
    headerAad,
  );
  if (!dek) throw new AppErrorException({ code: 'INTEGRITY', details: { reason: 'wrap' } });
  return dek;
}

// ── Caché de DEKs (§6.7) ───────────────────────────────────────────────────────────────────────

interface DekEntry {
  dek: Buffer;
  /** Cabecera completa ya autenticada con esta DEK. */
  header: Buffer;
}

/**
 * LRU de DEKs desenvueltas (máximo 64) que usan el protocolo y el loopback. Pone a cero la DEK que
 * expulsa o sustituye y todas al vaciarse. Cada entrada guarda la cabecera de 108 bytes con la que
 * se autenticó: un acierto solo vale si la cabecera del archivo es idéntica byte a byte, así que una
 * cabecera manipulada nunca se salta el desenvolvimiento. `set` toma posesión del búfer que recibe;
 * `get` devuelve una copia propia (quien la recibe la pone a cero sin afectar a la caché, y una
 * expulsión no le afecta).
 */
export class DekCache {
  readonly max: number;
  private readonly entries = new Map<string, DekEntry>();

  constructor(max = 64) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('max ≥ 1');
    this.max = max;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Copia de la DEK si la cabecera coincide; null si no está o la cabecera es distinta. */
  get(fileId: Buffer, header: Buffer): Buffer | null {
    const key = fileId.toString('hex');
    const entry = this.entries.get(key);
    if (!entry || !entry.header.equals(header)) return null;
    // Más reciente al final.
    this.entries.delete(key);
    this.entries.set(key, entry);
    const copy = Buffer.alloc(DEK_LEN);
    entry.dek.copy(copy);
    return copy;
  }

  /**
   * Toma posesión de `dek` (no la uses ni la pongas a cero desde fuera); expulsa y pone a cero la
   * menos usada si hace falta.
   */
  set(fileId: Buffer, header: Buffer, dek: Buffer): void {
    if (dek.length !== DEK_LEN) throw new RangeError('DEK de 32 bytes');
    const key = fileId.toString('hex');
    const previous = this.entries.get(key);
    if (previous) {
      if (previous.dek !== dek) zeroize(previous.dek);
      this.entries.delete(key);
    }
    this.entries.set(key, { dek, header: Buffer.from(header) });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      zeroize(this.entries.get(oldest)?.dek);
      this.entries.delete(oldest);
    }
  }

  delete(fileId: Buffer): void {
    const key = fileId.toString('hex');
    zeroize(this.entries.get(key)?.dek);
    this.entries.delete(key);
  }

  /** Pone a cero todas las DEKs y suelta las referencias. */
  clear(): void {
    for (const entry of this.entries.values()) zeroize(entry.dek);
    this.entries.clear();
  }
}

// ── KeyRing (§6.7) ─────────────────────────────────────────────────────────────────────────────

/**
 * MK, K_db, K_wrap y K_dedup de la sesión, más la caché de DEKs. Vive solo en SessionManager.
 * zeroize() es síncrono: pone a cero las cuatro claves y todas las DEKs de la caché y suelta las
 * referencias; después, cualquier acceso lanza LOCKED.
 */
export class KeyRing {
  readonly profileId: string;
  readonly dekCache: DekCache;
  private keys: { mk: Buffer; kDb: Buffer; kWrap: Buffer; kDedup: Buffer } | null;

  /** Toma posesión de `mk`: no la uses ni la pongas a cero desde fuera. */
  constructor(mk: Buffer, profileId: string, dekCacheSize = 64) {
    let derived: DerivedKeys;
    try {
      derived = deriveKeys(mk, profileId);
    } catch (err) {
      zeroize(mk); // también en la ruta de error (§6.7)
      throw err;
    }
    this.profileId = profileId;
    this.keys = { mk, ...derived };
    this.dekCache = new DekCache(dekCacheSize);
  }

  get zeroized(): boolean {
    return this.keys === null;
  }

  private get live(): NonNullable<KeyRing['keys']> {
    if (!this.keys) throw new AppErrorException({ code: 'LOCKED' });
    return this.keys;
  }

  get mk(): Buffer {
    return this.live.mk;
  }

  get kDb(): Buffer {
    return this.live.kDb;
  }

  get kWrap(): Buffer {
    return this.live.kWrap;
  }

  get kDedup(): Buffer {
    return this.live.kDedup;
  }

  zeroize(): void {
    const k = this.keys;
    this.keys = null;
    if (k) zeroize(k.mk, k.kDb, k.kWrap, k.kDedup);
    this.dekCache.clear();
  }
}
