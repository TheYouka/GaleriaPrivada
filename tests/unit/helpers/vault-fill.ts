// Rellena una bóveda real de un banco de pruebas (helpers/import.ts) sin pasar por la importación:
// objetos cifrados con el KeyRing de la sesión y filas de `media` escritas con media-repo. Lo usan
// los tests de la reconciliación (2.10) y del traslado (2.11).
import { randomBytes } from 'node:crypto';
import type { Id } from '@shared/types';
import { KIND_MEDIA, type ObjectKind } from '../../../src/main/crypto/file-format';
import type { Db } from '../../../src/main/db/database';
import { insertPending, markReady, type NewMedia } from '../../../src/main/db/repos/media-repo';
import type { SessionManager } from '../../../src/main/session/session-manager';
import { ObjectStore } from '../../../src/main/vault/object-store';

export const newId = (): Id => randomBytes(16).toString('hex');

/** Id nuevo que empieza por `shard` (2 hex). */
export const idInShard = (shard: string): Id => `${shard}${randomBytes(15).toString('hex')}`;

export function storeOf(session: SessionManager): ObjectStore {
  return new ObjectStore(session.getVaultDir(session.epoch));
}

/** Cifra `data` en tmp/<id>.part (como el paso 2 de la importación) y lo cierra con finish(). */
export async function writePart(
  session: SessionManager,
  id: Id,
  kind: ObjectKind,
  data: Buffer,
): Promise<void> {
  const store = storeOf(session);
  const writer = store.createWriter({
    id,
    kind,
    kWrap: session.getKeyRing(session.epoch).kWrap,
  });
  await writer.write(data);
  await writer.finish();
}

/** Objeto final cifrado en objects|thumbs/<aa>/<id>. */
export async function writeObject(
  session: SessionManager,
  id: Id,
  kind: ObjectKind,
  data: Buffer,
): Promise<void> {
  await writePart(session, id, kind, data);
  await storeOf(session).promote(id, kind);
}

export function mediaRow(overrides: Partial<NewMedia> & { id: Id }): NewMedia {
  return {
    kind: 'photo',
    source: 'import',
    name: `foto-${overrides.id.slice(0, 6)}`,
    originalExt: 'png',
    mime: 'image/png',
    sizeBytes: 10,
    originalSizeBytes: 10,
    width: 4,
    height: 4,
    durationMs: null,
    fps: null,
    hasAudio: null,
    videoCodec: null,
    audioCodec: null,
    converted: false,
    capturedAt: 1_700_000_000_000,
    capturedAtSource: 'file_mtime',
    importedAt: 1_700_000_000_000,
    contentHmac: randomBytes(32),
    thumbId: null,
    ...overrides,
  };
}

/** Fila `pending` (y `ready` con `ready: true`). */
export function insertRow(
  db: Db,
  overrides: Partial<NewMedia> & { id: Id },
  opts: { ready?: boolean } = {},
): NewMedia {
  const media = mediaRow(overrides);
  insertPending(db, media);
  if (opts.ready) markReady(db, media.id);
  return media;
}

/** Medio `ready` con su objeto y su miniatura cifrados. */
export async function addReadyMedia(
  session: SessionManager,
  data: Buffer = randomBytes(5000),
): Promise<{ id: Id; thumbId: Id }> {
  const id = newId();
  const thumbId = newId();
  await writeObject(session, id, KIND_MEDIA, data);
  await writeObject(session, thumbId, 2, randomBytes(300));
  insertRow(session.getDb(session.epoch), { id, thumbId, sizeBytes: data.length }, { ready: true });
  return { id, thumbId };
}
