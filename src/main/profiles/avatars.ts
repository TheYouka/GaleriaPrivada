// Avatares (docs/DESIGN.md §14.4). 12 ilustraciones integradas (el renderer las dibuja) o una foto
// elegida por el usuario, que se guarda SIN CIFRAR en avatars/<profileId>.webp: 256×256, WebP, sin
// metadatos. El archivo elegido nunca se modifica.
//
// profiles:pickAvatarPhoto, en main:
//   1. diálogo nativo (openFile, dontAddToRecent, filtro "Imágenes" sin BMP, HEIC ni RAW);
//   2. lstat: solo un archivo regular, sin enlaces simbólicos ni junctions → si no, UNSUPPORTED_FORMAT;
//   3. ≤ 50 MiB → si no, TOO_LARGE sin leer el contenido;
//   4. lectura a memoria y formato por firma (sniff.ts): JPEG, PNG, WebP, GIF o AVIF;
//   5. sharp con limitInputPixels (≤ 268 MP → si no, TOO_LARGE; cualquier otro error de
//      decodificación → UNSUPPORTED_FORMAT) → autoOrient → 256×256 cover → WebP q85 (sin
//      withMetadata(), así que no se copian metadatos; de un GIF animado, el primer fotograma);
//   6. el WebP queda en memoria con un token aleatorio de 10 min (vault://avatar/pending/<token>);
//   7. errores de E/S → IO. Ningún fallo deja nada en disco. Log `debug` con el código, sin la ruta.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Dialog, OpenDialogOptions } from 'electron';
import { AppErrorException, type ErrorCode } from '@shared/errors';
import {
  AVATAR_DIALOG_EXTENSIONS,
  AVATAR_MAX_BYTES,
  AVATAR_SIZE_PX,
  AVATAR_TOKEN_PATTERN,
  AVATAR_TOKEN_TTL_MS,
  BUILTIN_AVATAR_IDS,
  ID_PATTERN,
  MAX_INPUT_PIXELS,
} from '@shared/constants';
import type { Id } from '@shared/types';
import { sniffBuffer } from '../import/sniff';
import { log } from '../log';
import { getSharp } from '../media/sharp-loader';
import { writeFileAtomic } from '../settings/settings-store';

export const BUILTIN_AVATARS = BUILTIN_AVATAR_IDS;
export const AVATARS_DIR = 'avatars';

export function avatarFilePath(dataRoot: string, profileId: Id): string {
  if (!ID_PATTERN.test(profileId)) throw new RangeError('profileId inválido');
  return join(dataRoot, AVATARS_DIR, `${profileId}.webp`);
}

function fail(code: ErrorCode): never {
  log.debug('avatar.rejected', { code });
  throw new AppErrorException({ code });
}

function isIoError(err: unknown): boolean {
  return !(err instanceof AppErrorException);
}

/**
 * Pasos 2–5 sobre el archivo elegido: devuelve el WebP 256×256 sin metadatos. Lee el archivo una
 * sola vez, a través del mismo descriptor cuyo tamaño e identidad se comprueban.
 */
export async function processAvatarPhoto(path: string): Promise<Buffer> {
  let original: Buffer;
  try {
    // 2. Solo un archivo regular, sin enlaces (en Windows, las junctions salen como enlaces).
    const st = await lstat(path, { bigint: true });
    if (st.isSymbolicLink() || !st.isFile()) fail('UNSUPPORTED_FORMAT');
    // 3. Tamaño antes de leer nada.
    if (st.size > BigInt(AVATAR_MAX_BYTES)) fail('TOO_LARGE');
    const fh = await open(path, 'r');
    try {
      const fst = await fh.stat({ bigint: true });
      if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino) fail('UNSUPPORTED_FORMAT');
      if (fst.size > BigInt(AVATAR_MAX_BYTES)) fail('TOO_LARGE');
      original = await fh.readFile();
    } finally {
      await fh.close().catch(() => undefined);
    }
  } catch (err) {
    if (isIoError(err)) fail('IO');
    throw err;
  }
  if (original.length > AVATAR_MAX_BYTES) fail('TOO_LARGE');

  // 4. Formato por firma: solo las filas de foto.
  if (sniffBuffer(original).kind !== 'photo') fail('UNSUPPORTED_FORMAT');

  // 5. sharp, sin metadatos en la salida.
  const sharp = await getSharp();
  try {
    return await sharp(original, { sequentialRead: true, limitInputPixels: MAX_INPUT_PIXELS })
      .autoOrient()
      .resize(AVATAR_SIZE_PX, AVATAR_SIZE_PX, { fit: 'cover' })
      .webp({ quality: 85 })
      .toBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    fail(/pixel limit/i.test(message) ? 'TOO_LARGE' : 'UNSUPPORTED_FORMAT');
  } finally {
    original.fill(0); // el buffer original se descarta
  }
}

/** WebP pendientes en memoria, cada uno con un token de 32 bytes en base64url y 10 min de vida. */
export class AvatarTokens {
  private readonly entries = new Map<string, { webp: Buffer; expires: number }>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = AVATAR_TOKEN_TTL_MS,
  ) {}

  issue(webp: Buffer): string {
    this.prune();
    const token = randomBytes(32).toString('base64url');
    this.entries.set(token, { webp, expires: this.now() + this.ttlMs });
    return token;
  }

  /** WebP del token si existe y no ha caducado (no lo consume). */
  peek(token: string): Buffer | null {
    if (!AVATAR_TOKEN_PATTERN.test(token)) return null;
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (entry.expires <= this.now()) {
      this.entries.delete(token);
      return null;
    }
    return entry.webp;
  }

  /** Consume el token (al guardar el perfil). */
  take(token: string): Buffer | null {
    const webp = this.peek(token);
    this.entries.delete(token);
    return webp;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expires <= now) this.entries.delete(token);
    }
  }
}

export type ShowOpenDialog = (options: OpenDialogOptions) => ReturnType<Dialog['showOpenDialog']>;

/** profiles:pickAvatarPhoto (pasos 1–7). null si el usuario cancela el diálogo. */
export async function pickAvatarPhoto(
  showOpenDialog: ShowOpenDialog,
  tokens: AvatarTokens,
): Promise<{ token: string } | null> {
  const result = await showOpenDialog({
    properties: ['openFile', 'dontAddToRecent'],
    filters: [{ name: 'Imágenes', extensions: [...AVATAR_DIALOG_EXTENSIONS] }],
  });
  const path = result.filePaths[0];
  if (result.canceled || !path) return null;
  const webp = await processAvatarPhoto(path);
  return { token: tokens.issue(webp) };
}

/** Paso 5 de la creación (y editar): avatars/<id>.webp de forma atómica. */
export async function writeAvatar(dataRoot: string, profileId: Id, webp: Buffer): Promise<void> {
  await mkdir(join(dataRoot, AVATARS_DIR), { recursive: true });
  await writeFileAtomic(avatarFilePath(dataRoot, profileId), webp);
}

export async function removeAvatar(dataRoot: string, profileId: Id): Promise<void> {
  await rm(avatarFilePath(dataRoot, profileId), { force: true });
}
