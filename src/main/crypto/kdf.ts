// Derivación de la contraseña con Argon2id y calibración por máquina (docs/DESIGN.md §6.1).
//
// La contraseña llega como Uint8Array (NFC + UTF-8, 8–1024 bytes validados en el IPC). Quien llama
// pone a cero la contraseña y la KEK en cuanto dejan de usarse.
//
// Este módulo no importa `electron`: quien lo usa pasa `isPackaged` (así se prueba en Vitest).
import { hashRaw } from '@node-rs/argon2';
import { AppErrorException } from '@shared/errors';
import { log } from '../log';
import { randomOwned, zeroize } from './secure-buffer';

export const SALT_LEN = 16;
export const KEK_LEN = 32;

/** Parámetros de Argon2id guardados en el perfil (§6.1, §8.2). `memoryKiB` es la memoria total. */
export interface KdfParams {
  memoryKiB: number;
  iterations: number;
  parallelism: number;
}

/** Objetivo: m = 256 MiB, t = 3, p = 4. */
export const KDF_TARGET: Readonly<KdfParams> = Object.freeze({
  memoryKiB: 262144,
  iterations: 3,
  parallelism: 4,
});

/** Candidatos más ligeros, en el orden de §6.1. El último es el suelo: nunca se baja de ahí. */
export const KDF_FALLBACKS: readonly Readonly<KdfParams>[] = Object.freeze([
  Object.freeze({ memoryKiB: 262144, iterations: 2, parallelism: 4 }),
  Object.freeze({ memoryKiB: 131072, iterations: 3, parallelism: 4 }),
  Object.freeze({ memoryKiB: 131072, iterations: 2, parallelism: 4 }),
  Object.freeze({ memoryKiB: 65536, iterations: 3, parallelism: 4 }),
]);

/** Solo con GALERIA_TEST_FAST_KDF=1 y sin empaquetar (tests E2E, §23.2). */
export const KDF_FAST_TEST: Readonly<KdfParams> = Object.freeze({
  memoryKiB: 8192,
  iterations: 1,
  parallelism: 1,
});

export const KDF_MAX_ITERATIONS = 8;
/** Más lento que esto: se prueba el siguiente candidato. */
export const KDF_SLOW_MS = 1500;
/** Más rápido que esto (con el objetivo): se sube t. */
export const KDF_FAST_MS = 500;
/** Tiempo objetivo al subir t. */
export const KDF_GOAL_MS = 750;

/** Función hash inyectable (tests con tiempos simulados). Devuelve 32 bytes. */
export type Argon2Hash = (
  password: Uint8Array,
  salt: Uint8Array,
  params: Readonly<KdfParams>,
) => Promise<Buffer>;

/**
 * Argon2id v0x13 con `@node-rs/argon2`. Literales numéricos porque `Algorithm` y `Version` son
 * `const enum` ambientales y no se pueden usar con isolatedModules.
 */
export const argon2idHash: Argon2Hash = (password, salt, params) =>
  hashRaw(password, {
    algorithm: 2, // Argon2id
    version: 1, // 0x13
    memoryCost: params.memoryKiB,
    timeCost: params.iterations,
    parallelism: params.parallelism,
    outputLen: KEK_LEN,
    salt,
  });

/** Sal nueva de 16 bytes (en cada creación de perfil y cada cambio de contraseña). */
export function newSalt(): Buffer {
  return randomOwned(SALT_LEN);
}

/**
 * KEK = Argon2id(contraseña, sal, params). Si Argon2 falla (reserva de memoria), INTERNAL con
 * `details.reason = 'kdf-memory'` y un `error` en el log (§21.1).
 */
export async function deriveKek(
  password: Uint8Array,
  salt: Uint8Array,
  params: Readonly<KdfParams>,
  hash: Argon2Hash = argon2idHash,
): Promise<Buffer> {
  if (salt.length !== SALT_LEN) throw new RangeError('sal de 16 bytes');
  let kek: Buffer;
  try {
    kek = await hash(password, salt, params);
  } catch {
    log.error('kdf.memory', { stage: 'derive' });
    throw new AppErrorException({ code: 'INTERNAL', details: { reason: 'kdf-memory' } });
  }
  if (kek.length !== KEK_LEN) {
    zeroize(kek);
    throw new AppErrorException({ code: 'INTERNAL', details: { reason: 'kdf-output' } });
  }
  return kek;
}

export interface CalibrationDeps {
  hash?: Argon2Hash;
  /** Reloj en milisegundos. */
  now?: () => number;
}

/** Milisegundos de un hash con contraseña y sal aleatorias de prueba, o null si Argon2 falla. */
async function measure(
  params: Readonly<KdfParams>,
  hash: Argon2Hash,
  now: () => number,
): Promise<number | null> {
  const password = randomOwned(16);
  const salt = newSalt();
  const start = now();
  try {
    zeroize(await hash(password, salt, params));
    return now() - start;
  } catch {
    log.warn('kdf.candidate-failed', { bytes: params.memoryKiB * 1024, count: params.iterations });
    return null;
  } finally {
    zeroize(password);
  }
}

/**
 * Calibración de §6.1:
 * 1. mide (256 MiB, t=3, p=4);
 * 2. si tarda más de 1,5 s, prueba los candidatos de KDF_FALLBACKS en orden y se queda con el
 *    primero que baje de 1,5 s; el suelo (64 MiB, t=3) se usa aunque tarde;
 * 3. si tarda menos de 0,5 s, t = min(8, max(3, ceil(3 × 0,75 s / medido_s))), sin cambiar m;
 * si Argon2 falla con un candidato (memoria), pasa al siguiente; si falla también el suelo,
 * INTERNAL { reason: 'kdf-memory' }.
 */
export async function calibrateKdf(deps: CalibrationDeps = {}): Promise<KdfParams> {
  const hash = deps.hash ?? argon2idHash;
  const now = deps.now ?? (() => performance.now());
  const candidates = [KDF_TARGET, ...KDF_FALLBACKS];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i] as Readonly<KdfParams>;
    const ms = await measure(candidate, hash, now);
    if (ms === null) continue;
    let chosen: KdfParams | null = null;
    if (i === 0) {
      if (ms < KDF_FAST_MS) {
        const t = Math.ceil((candidate.iterations * KDF_GOAL_MS) / ms);
        chosen = {
          ...candidate,
          iterations: Math.min(KDF_MAX_ITERATIONS, Math.max(candidate.iterations, t)),
        };
      } else if (ms <= KDF_SLOW_MS) {
        chosen = { ...candidate };
      }
    } else if (ms < KDF_SLOW_MS || i === candidates.length - 1) {
      chosen = { ...candidate };
    }
    if (chosen) {
      log.info('kdf.calibrated', {
        ms: Math.round(ms),
        bytes: chosen.memoryKiB * 1024,
        count: chosen.iterations,
      });
      return chosen;
    }
  }
  log.error('kdf.memory', { stage: 'calibrate' });
  throw new AppErrorException({ code: 'INTERNAL', details: { reason: 'kdf-memory' } });
}

/** Parámetros rápidos solo con GALERIA_TEST_FAST_KDF=1 y sin empaquetar. */
export function fastKdfAllowed(isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return !isPackaged && env.GALERIA_TEST_FAST_KDF === '1';
}

/**
 * Parámetros para crear un perfil o cambiar la contraseña: los rápidos de test (con `warn`) si
 * fastKdfAllowed(); si no, la calibración.
 */
export async function chooseKdfParams(
  options: { isPackaged: boolean; env?: NodeJS.ProcessEnv } & CalibrationDeps,
): Promise<KdfParams> {
  if (fastKdfAllowed(options.isPackaged, options.env)) {
    log.warn('kdf.fast-params');
    return { ...KDF_FAST_TEST };
  }
  return calibrateKdf(options);
}
