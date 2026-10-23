// profiles.json y profiles.json.bak (docs/DESIGN.md §8.2 y §8.3). En claro: nombre, avatar, KDF,
// sal y MK envuelta. Nunca la preferencia de tema ni datos de uso (van en prefs/).
//
// Escritura: writeJsonAtomic sobre profiles.json y después, con exactamente el mismo contenido,
// sobre profiles.json.bak, así el .bak nunca contiene envolturas antiguas (§6.6, paso 4).
// Lectura (tres reglas de §8.3):
//   - si profiles.json es inválido (o falta y el .bak es válido), se usa el .bak y se reescribe el
//     principal, con un `warn`;
//   - si los dos son inválidos, VAULT_CORRUPT y no se escribe nada (para no destruir información
//     que se pueda recuperar a mano);
//   - si no existe ninguno, es el primer arranque y la lista está vacía.
// Si el principal es válido y el .bak no coincide (caída entre las dos escrituras), se reescribe
// el .bak para que no conserve una envoltura antigua.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AppErrorException } from '@shared/errors';
import { BUILTIN_AVATAR_IDS, ID_PATTERN, MAX_PROFILES, PROFILE_NAME_MAX } from '@shared/constants';
import type { Id } from '@shared/types';
import type { KdfParams } from '../crypto/kdf';
import type { MasterKeyWrap } from '../crypto/keys';
import { log } from '../log';
import { readJsonFile, writeJsonAtomic, type AtomicIo } from '../settings/settings-store';
import { defaultVaultDir } from '../vault/vault-layout';

export const PROFILES_FILE = 'profiles.json';
export const PROFILES_BAK = 'profiles.json.bak';

/** base64 estándar que decodifica exactamente a `bytes` bytes. */
function base64Bytes(bytes: number) {
  return z
    .string()
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((s) => Buffer.from(s, 'base64').length === bytes && s.length % 4 === 0, {
      message: `base64 de ${bytes} bytes`,
    });
}

const absolutePath = z
  .string()
  .min(1)
  .refine((p) => !p.includes('\0'));

const vaultLocationSchema = z.discriminatedUnion('location', [
  z.strictObject({
    location: z.literal('default'),
    pendingCleanup: absolutePath.optional(),
  }),
  z.strictObject({
    location: z.literal('custom'),
    path: absolutePath,
    pendingCleanup: absolutePath.optional(),
  }),
]);

/** Nombre guardado: 1–40 code points, NFC, sin caracteres de control (§8.2). */
const storedName = z
  .string()
  .refine((s) => s === s.normalize('NFC'), { message: 'NFC' })
  .refine((s) => !/\p{Cc}/u.test(s), { message: 'control' })
  .refine((s) => [...s].length >= 1 && [...s].length <= PROFILE_NAME_MAX, { message: 'length' });

export const STORED_PROFILE_SCHEMA = z.strictObject({
  id: z.string().regex(ID_PATTERN),
  name: storedName,
  avatar: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('builtin'), id: z.enum(BUILTIN_AVATAR_IDS) }),
    z.strictObject({ type: z.literal('custom'), rev: z.number().int().min(0) }),
  ]),
  createdAt: z.iso.datetime(),
  vault: vaultLocationSchema,
  kdf: z.strictObject({
    alg: z.literal('argon2id'),
    version: z.literal(19),
    memoryKiB: z.number().int().min(8192).max(1048576),
    iterations: z.number().int().min(1).max(8),
    parallelism: z.number().int().min(1).max(4),
    salt: base64Bytes(16),
  }),
  masterKeyWrap: z.strictObject({
    alg: z.literal('A256GCM'),
    nonce: base64Bytes(12),
    ciphertext: base64Bytes(32),
    tag: base64Bytes(16),
  }),
});

/** Nombre plegado (sin mayúsculas ni diacríticos): la unicidad se comprueba sobre esto. */
export function foldName(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().normalize('NFC');
}

export const PROFILES_SCHEMA = z
  .strictObject({
    formatVersion: z.literal(1),
    profiles: z.array(STORED_PROFILE_SCHEMA).max(MAX_PROFILES),
  })
  .refine((f) => new Set(f.profiles.map((p) => p.id)).size === f.profiles.length, {
    message: 'ids duplicados',
  })
  .refine((f) => new Set(f.profiles.map((p) => foldName(p.name))).size === f.profiles.length, {
    message: 'nombres duplicados',
  });

export type StoredProfile = z.infer<typeof STORED_PROFILE_SCHEMA>;
export type ProfilesFile = z.infer<typeof PROFILES_SCHEMA>;

// ── Conversión a claves y rutas ────────────────────────────────────────────────────────────────

export function kdfParamsOf(profile: StoredProfile): KdfParams {
  const { memoryKiB, iterations, parallelism } = profile.kdf;
  return { memoryKiB, iterations, parallelism };
}

/** Sal de 16 bytes en un búfer propio. */
export function saltOf(profile: StoredProfile): Buffer {
  return Buffer.from(profile.kdf.salt, 'base64');
}

export function masterKeyWrapOf(profile: StoredProfile): MasterKeyWrap {
  const w = profile.masterKeyWrap;
  return {
    nonce: Buffer.from(w.nonce, 'base64'),
    ciphertext: Buffer.from(w.ciphertext, 'base64'),
    tag: Buffer.from(w.tag, 'base64'),
  };
}

export function encodeMasterKeyWrap(wrap: MasterKeyWrap): StoredProfile['masterKeyWrap'] {
  return {
    alg: 'A256GCM',
    nonce: wrap.nonce.toString('base64'),
    ciphertext: wrap.ciphertext.toString('base64'),
    tag: wrap.tag.toString('base64'),
  };
}

export function encodeKdf(params: KdfParams, salt: Buffer): StoredProfile['kdf'] {
  return {
    alg: 'argon2id',
    version: 19,
    memoryKiB: params.memoryKiB,
    iterations: params.iterations,
    parallelism: params.parallelism,
    salt: salt.toString('base64'),
  };
}

/** Carpeta que contiene vault.json: GaleriaData/vaults/<id> o `vault.path` (§8.2). */
export function vaultDirOf(dataRoot: string, profile: StoredProfile): string {
  return profile.vault.location === 'custom'
    ? profile.vault.path
    : defaultVaultDir(dataRoot, profile.id);
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export class ProfileStore {
  readonly path: string;
  readonly bakPath: string;

  constructor(
    dataRoot: string,
    private readonly io?: AtomicIo,
  ) {
    this.path = join(dataRoot, PROFILES_FILE);
    this.bakPath = join(dataRoot, PROFILES_BAK);
  }

  /** Lista de perfiles con las tres reglas de §8.3. Los dos inválidos → VAULT_CORRUPT. */
  async read(): Promise<ProfilesFile> {
    const main = readJsonFile(this.path, PROFILES_SCHEMA);
    const bak = readJsonFile(this.bakPath, PROFILES_SCHEMA);
    if (main.kind === 'ok') {
      if (bak.kind !== 'ok' || readRaw(this.path) !== readRaw(this.bakPath)) {
        await this.writeOne(this.bakPath, main.value).catch(() => undefined);
      }
      return main.value;
    }
    if (bak.kind === 'ok') {
      log.warn('profiles.restored-backup');
      await this.writeOne(this.path, bak.value).catch(() => undefined);
      return bak.value;
    }
    if (main.kind === 'missing' && bak.kind === 'missing') {
      return { formatVersion: 1, profiles: [] };
    }
    log.error('profiles.corrupt');
    throw new AppErrorException({ code: 'VAULT_CORRUPT', details: { stage: 'profiles' } });
  }

  /**
   * Escribe profiles.json y después el .bak con el mismo contenido. El principal es el punto de
   * confirmación: si falla, lanza y nada cambia. Si solo falla el .bak, la operación ya está
   * confirmada; se registra el error y la siguiente lectura lo reescribe (no coincide).
   */
  async write(file: ProfilesFile): Promise<void> {
    await this.writeOne(this.path, file);
    await this.writeOne(this.bakPath, file).catch(() => undefined);
  }

  async find(profileId: Id): Promise<StoredProfile | null> {
    const file = await this.read();
    return file.profiles.find((p) => p.id === profileId) ?? null;
  }

  private async writeOne(path: string, file: ProfilesFile): Promise<void> {
    try {
      await writeJsonAtomic(path, file, PROFILES_SCHEMA, this.io);
    } catch (err) {
      log.error('profiles.write-failed', {
        code: err instanceof AppErrorException ? err.error.code : 'IO',
      });
      throw err;
    }
  }
}
