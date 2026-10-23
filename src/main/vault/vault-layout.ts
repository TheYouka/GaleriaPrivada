// Layout de una bóveda (docs/DESIGN.md §8.5) y removeVaultDir() (§8.5.1).
//
//   <vaultDir>/vault.json                { formatVersion: 1, profileId, createdAt } (en claro)
//   <vaultDir>/library.db (+ -wal, -shm) SQLCipher; library.db.bak-v<n> solo durante una migración
//   <vaultDir>/objects/<aa>/<mediaId>    originales cifrados (aa = 2 primeros hex del id)
//   <vaultDir>/thumbs/<aa>/<thumbId>     miniaturas cifradas
//   <vaultDir>/tmp/<32 hex>.part         solo ciphertext en curso
//   <vaultDir>/music/<trackId>.<ext>     música en claro
//
// removeVaultDir es la ÚNICA función que borra una bóveda o una carpeta de bóveda a medio crear o a
// medio copiar. Nunca sigue enlaces, exige una prueba de identidad y solo borra entradas conocidas:
// `vault.path` no está autenticado (profiles.json va en claro), así que nunca se borra
// recursivamente una ruta sin pasar por aquí.
import { lstat, readdir, readFile, realpath, rm, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { ID_PATTERN } from '@shared/constants';
import type { Id } from '@shared/types';
import { log } from '../log';

export const VAULTS_DIR = 'vaults';
export const VAULT_JSON = 'vault.json';
export const CREATING_SUFFIX = '.creating';
export const VAULT_SUBDIRS = ['objects', 'thumbs', 'tmp', 'music'] as const;

export const VAULT_JSON_SCHEMA = z.strictObject({
  formatVersion: z.literal(1),
  profileId: z.string().regex(ID_PATTERN),
  createdAt: z.iso.datetime(),
});

export type VaultJson = z.infer<typeof VAULT_JSON_SCHEMA>;

// ── Rutas ──────────────────────────────────────────────────────────────────────────────────────

/** GaleriaData/vaults/<profileId> (ubicación por defecto, §8.1). */
export function defaultVaultDir(dataRoot: string, profileId: Id): string {
  return join(dataRoot, VAULTS_DIR, profileId);
}

/** GaleriaData/vaults/<profileId>.creating (solo mientras se crea el perfil, §14.4). */
export function creatingVaultDir(dataRoot: string, profileId: Id): string {
  return `${defaultVaultDir(dataRoot, profileId)}${CREATING_SUFFIX}`;
}

export interface VaultPaths {
  root: string;
  vaultJson: string;
  db: string;
  objects: string;
  thumbs: string;
  tmp: string;
  music: string;
}

export function vaultPaths(vaultDir: string): VaultPaths {
  return {
    root: vaultDir,
    vaultJson: join(vaultDir, VAULT_JSON),
    db: join(vaultDir, 'library.db'),
    objects: join(vaultDir, 'objects'),
    thumbs: join(vaultDir, 'thumbs'),
    tmp: join(vaultDir, 'tmp'),
    music: join(vaultDir, 'music'),
  };
}

/** Subcarpeta de sharding: los 2 primeros hex del id (256 carpetas). */
export function shardOf(id: Id): string {
  if (!ID_PATTERN.test(id)) throw new RangeError('id inválido');
  return id.slice(0, 2);
}

export function objectPath(vaultDir: string, mediaId: Id): string {
  return join(vaultDir, 'objects', shardOf(mediaId), mediaId);
}

export function thumbPath(vaultDir: string, thumbId: Id): string {
  return join(vaultDir, 'thumbs', shardOf(thumbId), thumbId);
}

export function tmpPartPath(vaultDir: string, id: Id): string {
  shardOf(id); // valida el id
  return join(vaultDir, 'tmp', `${id}.part`);
}

/** Contenido de vault.json, o null si falta, es un enlace o no valida. */
export async function readVaultJson(vaultDir: string): Promise<VaultJson | null> {
  const file = join(vaultDir, VAULT_JSON);
  try {
    const st = await lstat(file);
    if (!st.isFile()) return null;
    const parsed = VAULT_JSON_SCHEMA.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ── removeVaultDir (§8.5.1) ────────────────────────────────────────────────────────────────────

export type RemoveVaultMode = 'vault' | 'creating' | 'relocate-partial';

export interface RemoveVaultOptions {
  /**
   * Bóveda actual del perfil según profiles.json (paso 3): nunca se borra. El borrado de un perfil
   * pasa null porque ya quitó la entrada antes (§14.4).
   */
  currentVaultDir?: string | null;
  /** 'relocate-partial': id del trabajo cuyo marcador `.galeria-relocate-<jobId>` se exige. */
  relocateJobId?: Id;
}

export interface RemoveVaultResult {
  /** La carpeta ya no existe. */
  removed: boolean;
  /** Carpeta que queda (entradas desconocidas o prueba de identidad fallida), o null. */
  leftoverPath: string | null;
}

const RELOCATE_MARKER_PREFIX = '.galeria-relocate-';
const TMP_JSON = /^vault\.json\.tmp-[0-9a-f]{8}$/;

/** Entradas de primer nivel que pertenecen a una bóveda (paso 4). */
function isKnownEntry(name: string): boolean {
  return (
    name === VAULT_JSON ||
    TMP_JSON.test(name) ||
    name === 'library.db' ||
    name === 'library.db-wal' ||
    name === 'library.db-shm' ||
    /^library\.db\.bak-v\d+$/.test(name) ||
    (VAULT_SUBDIRS as readonly string[]).includes(name) ||
    name.startsWith(RELOCATE_MARKER_PREFIX)
  );
}

/**
 * Ni enlace simbólico ni junction: en Windows, Node expone las junctions (reparse points) como
 * enlaces simbólicos en lstat.
 */
async function lstatPlain(path: string): Promise<'dir' | 'file' | 'link' | 'other' | 'missing'> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) return 'link';
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
    return 'other';
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'ENOENT') return 'missing';
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function isCurrentVault(dir: string, current: string | null | undefined): Promise<boolean> {
  if (!current) return false;
  const realDir = await realpath(dir).catch(() => resolve(dir));
  const realCurrent = await realpath(current).catch(() => resolve(current));
  return samePath(realDir, realCurrent);
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

const refused = (dir: string): RemoveVaultResult => ({ removed: false, leftoverPath: dir });

/** Borra una entrada conocida de primer nivel sin seguir enlaces. false si se deja. */
async function removeEntry(path: string): Promise<boolean> {
  const kind = await lstatPlain(path);
  if (kind === 'missing') return true;
  if (kind === 'link' || kind === 'other') return false; // nunca a través de un enlace
  try {
    if (kind === 'dir') {
      await rm(path, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
    } else {
      await unlink(path);
    }
    return true;
  } catch (err) {
    log.warn('vault.remove.leftover', { errno: errnoOf(err), stage: 'entry' });
    return false;
  }
}

/** Modo 'creating' sin vault.json: solo subcarpetas vacías y vault.json.tmp-*. */
async function removeCreatingWithoutIdentity(dir: string, names: string[]): Promise<void> {
  for (const name of names) {
    const path = join(dir, name);
    const kind = await lstatPlain(path);
    if (TMP_JSON.test(name) && kind === 'file') {
      await unlink(path).catch(() => undefined);
    } else if ((VAULT_SUBDIRS as readonly string[]).includes(name) && kind === 'dir') {
      await rmdir(path).catch(() => undefined); // no recursivo: solo si está vacía
    }
  }
}

/**
 * Borra una carpeta de bóveda (§8.5.1):
 * 1. `dir` tiene que ser un directorio, no un enlace ni una junction;
 * 2. prueba de identidad por vault.json (o el marcador de traslado);
 * 3. nunca la bóveda actual del perfil;
 * 4. solo las entradas conocidas, repitiendo el lstat antes de cada una;
 * 5. rmdir no recursivo: si quedan entradas desconocidas, se dejan y se devuelve leftoverPath.
 * Nunca lanza por un fallo de E/S: lo que no se puede borrar queda en leftoverPath.
 */
export async function removeVaultDir(
  dir: string,
  profileId: Id,
  mode: RemoveVaultMode = 'vault',
  options: RemoveVaultOptions = {},
): Promise<RemoveVaultResult> {
  if (!ID_PATTERN.test(profileId)) throw new RangeError('profileId inválido');

  // 1. Directorio real.
  let kind: Awaited<ReturnType<typeof lstatPlain>>;
  try {
    kind = await lstatPlain(dir);
  } catch (err) {
    log.warn('vault.remove.refused', { errno: errnoOf(err), stage: 'lstat' });
    return refused(dir);
  }
  if (kind === 'missing') {
    // Si tampoco existe la carpeta padre (disco desconectado), la bóveda puede seguir en ese disco.
    return (await exists(dirname(dir)))
      ? { removed: true, leftoverPath: null }
      : { removed: false, leftoverPath: dir };
  }
  if (kind !== 'dir') {
    log.warn('vault.remove.refused', { stage: 'not-a-directory' });
    return refused(dir);
  }

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    log.warn('vault.remove.refused', { errno: errnoOf(err), stage: 'readdir' });
    return refused(dir);
  }

  // 2. Prueba de identidad.
  const vaultJson = names.includes(VAULT_JSON) ? await readVaultJson(dir) : null;
  if (mode === 'relocate-partial') {
    const marker = options.relocateJobId
      ? `${RELOCATE_MARKER_PREFIX}${options.relocateJobId}`
      : null;
    const markerOk = marker !== null && (await lstatPlain(join(dir, marker))) === 'file';
    const jsonOk = !names.includes(VAULT_JSON) || vaultJson?.profileId === profileId;
    if (!markerOk || !jsonOk) {
      log.warn('vault.remove.refused', { stage: 'identity' });
      return refused(dir);
    }
  } else if (vaultJson?.profileId !== profileId) {
    if (mode === 'creating' && !names.includes(VAULT_JSON)) {
      // El flujo de creación escribe vault.json antes que nada: sin él solo puede haber
      // subcarpetas vacías y temporales de vault.json.
      await removeCreatingWithoutIdentity(dir, names);
      try {
        await rmdir(dir);
        return { removed: true, leftoverPath: null };
      } catch {
        log.warn('vault.remove.leftover', { stage: 'creating' });
        return refused(dir);
      }
    }
    log.warn('vault.remove.refused', { stage: 'identity' });
    return refused(dir);
  }

  // 3. Nunca la bóveda actual del perfil.
  if (await isCurrentVault(dir, options.currentVaultDir)) {
    log.warn('vault.remove.refused', { stage: 'current-vault' });
    return refused(dir);
  }

  // 4. Solo las entradas conocidas. vault.json va la última: mientras quede algo, la carpeta sigue
  //    identificándose como bóveda de este perfil y se puede reintentar.
  const known = names.filter(isKnownEntry).sort((a, b) => {
    if (a === VAULT_JSON) return 1;
    if (b === VAULT_JSON) return -1;
    return 0;
  });
  let allRemoved = true;
  for (const name of known) {
    if (name === VAULT_JSON && !allRemoved) break;
    if (!(await removeEntry(join(dir, name)))) allRemoved = false;
  }

  // 5. rmdir no recursivo.
  try {
    await rmdir(dir);
    return { removed: true, leftoverPath: null };
  } catch (err) {
    log.warn('vault.remove.leftover', { errno: errnoOf(err), stage: 'rmdir' });
    return { removed: false, leftoverPath: dir };
  }
}
