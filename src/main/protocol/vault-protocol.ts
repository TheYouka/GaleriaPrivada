// Protocolo vault:// (docs/DESIGN.md §11):
//   vault://media/<mediaId>              objeto almacenado, descifrado al vuelo (requiere desbloqueo)
//   vault://thumb/<mediaId>?rev=<n>      miniatura WebP (se busca thumb_id; requiere desbloqueo)
//   vault://music/<trackId>              F4: hasta entonces 423 bloqueada y 404 abierta
//   vault://avatar/<profileId>?rev=<n>   avatars/<profileId>.webp, en claro, sin desbloqueo
//   vault://avatar/pending/<token>       WebP elegido y aún no guardado (en memoria, 10 min)
//
// media y thumb: fila `ready` en la DB de la sesión, Range de §11.2 (range.ts), cabeceras de §11.3
// (CORS con el origen del renderer) y errores de §11.4 con cuerpo vacío y X-Galeria-Error:
// 423 desde `locking`, 503 BUSY en `maintenance`, 500 INTEGRITY si la cabecera o un tag no validan.
// §11.5: cada stream abierto escucha la señal de la sesión, que se aborta en el paso 2 del bloqueo,
// y termina con controller.error(); el paso 4 pone a cero la DEK de su lector (registerReader).
// Nada descifrado se escribe en disco: los bytes van del lector al ReadableStream de la respuesta.
import { readFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { Session } from 'electron';
import { AVATAR_TOKEN_PATTERN, ID_PATTERN } from '@shared/constants';
import { AppErrorException, type ErrorCode } from '@shared/errors';
import type { Id } from '@shared/types';
import { KIND_MEDIA, KIND_THUMB, type ObjectKind } from '../crypto/file-format';
import { openObject, type ObjectReader } from '../crypto/object-reader';
import { findReady } from '../db/repos/media-repo';
import { log } from '../log';
import type { SessionManager } from '../session/session-manager';
import { fileIdOf } from '../vault/object-store';
import { objectPath, thumbPath } from '../vault/vault-layout';
import { contentRange, parseRange, unsatisfiedRange } from './range';

/** Objeto cifrado que corresponde a una URL media|thumb con fila `ready`. */
export interface VaultObject {
  mediaId: Id;
  path: string;
  fileId: Buffer;
  kind: ObjectKind;
  mime: string;
}

/** Lector abierto con las claves de la sesión y registrado en ella (registerReader). */
export interface OpenedVaultObject {
  reader: ObjectReader;
  /** Señal de la sesión: se aborta en el paso 2 del bloqueo (§11.5). */
  signal: AbortSignal;
  /** Sale del registro de la sesión y cierra el lector. Idempotente. */
  release(): void;
}

/** Acceso a los objetos de la sesión desbloqueada. */
export interface VaultObjectSource {
  /** Fila `ready` (y, para thumb, con thumb_id); null si no existe. LOCKED si se bloqueó. */
  find(host: 'media' | 'thumb', mediaId: Id): VaultObject | null;
  open(object: VaultObject): Promise<OpenedVaultObject>;
}

export interface VaultProtocolDeps {
  /** Ruta de avatars/<profileId>.webp (el id ya está validado). */
  avatarFile(profileId: string): string;
  /** WebP pendiente del token, o null si no existe o caducó. */
  pendingAvatar(token: string): Buffer | null;
  /** app://bundle, o el origen de Vite en desarrollo (CORS, §5.5). */
  rendererOrigin(): string;
  /** Solo `unlocked` (desde `locking` ya es false, §11.5). */
  isUnlocked(): boolean;
  /** Subestado `maintenance` (traslado de la bóveda, §8.7) → 503 BUSY. */
  inMaintenance?(): boolean;
  /** media y thumb. Sin fuente, 404 (solo tests de F1). */
  objects?: VaultObjectSource;
}

const HOSTS: ReadonlySet<string> = new Set(['media', 'thumb', 'music', 'avatar']);
const EXPOSE = 'Content-Range, Content-Length, Accept-Ranges';

function baseHeaders(origin: string): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': origin,
  };
}

function errorResponse(
  status: number,
  code: ErrorCode | null,
  origin: string,
  extra: Record<string, string> = {},
): Response {
  const headers: Record<string, string> = { ...baseHeaders(origin), ...extra };
  if (code) headers['X-Galeria-Error'] = code;
  if (status === 405) headers.Allow = 'GET, HEAD';
  return new Response(null, { status, headers });
}

function okResponse(body: Buffer, method: string, origin: string): Response {
  return new Response(method === 'HEAD' ? null : new Uint8Array(body), {
    status: 200,
    headers: {
      ...baseHeaders(origin),
      'Content-Type': 'image/webp',
      'Content-Length': String(body.length),
      'Access-Control-Expose-Headers': EXPOSE,
    },
  });
}

function codeOf(err: unknown): ErrorCode {
  return err instanceof AppErrorException ? err.error.code : 'IO';
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
}

/**
 * ReadableStream web sobre el stream verificado del lector. Termina con controller.error() si la
 * sesión se bloquea (§11.5) o si un chunk no valida (§11.4); siempre libera el lector al acabar.
 */
function lockableBody(
  node: Readable,
  opened: OpenedVaultObject,
  mediaId: Id,
): ReadableStream<Uint8Array> {
  const it = node[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let finished = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    opened.signal.removeEventListener('abort', onLock);
    node.destroy();
    opened.release();
  };
  const onLock = (): void => {
    if (finished) return;
    controller?.error(new AppErrorException({ code: 'LOCKED' }));
    finish();
  };
  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      if (opened.signal.aborted) onLock();
      else opened.signal.addEventListener('abort', onLock, { once: true });
    },
    async pull(c) {
      try {
        const { value, done } = await it.next();
        if (finished) return;
        if (done) {
          c.close();
          finish();
          return;
        }
        c.enqueue(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      } catch (err) {
        if (finished) return;
        const code = codeOf(err);
        if (code === 'INTEGRITY') log.warn('protocol.integrity', { mediaId, code });
        else if (code !== 'LOCKED') log.error('protocol.io', { errno: errnoOf(err), code });
        c.error(err);
        finish();
      }
    },
    cancel() {
      finish();
    },
  });
}

async function serveObject(
  request: Request,
  host: 'media' | 'thumb',
  mediaId: Id,
  deps: VaultProtocolDeps,
  origin: string,
): Promise<Response> {
  if (!deps.isUnlocked()) return errorResponse(423, 'LOCKED', origin);
  if (deps.inMaintenance?.()) return errorResponse(503, 'BUSY', origin);
  const source = deps.objects;
  if (!source) return errorResponse(404, 'NOT_FOUND', origin);

  let object: VaultObject | null;
  try {
    object = source.find(host, mediaId);
  } catch (err) {
    if (!deps.isUnlocked() || codeOf(err) === 'LOCKED') return errorResponse(423, 'LOCKED', origin);
    log.error('protocol.io', { errno: errnoOf(err), stage: 'lookup' });
    return errorResponse(500, 'INTERNAL', origin);
  }
  if (!object) {
    log.debug('protocol.rejected', { stage: 'not-found' });
    return errorResponse(404, 'NOT_FOUND', origin);
  }

  let opened: OpenedVaultObject;
  try {
    opened = await source.open(object);
  } catch (err) {
    // Un bloqueo durante la apertura pone a cero K_wrap: es LOCKED, no un objeto dañado.
    const code = codeOf(err);
    if (!deps.isUnlocked() || code === 'LOCKED') return errorResponse(423, 'LOCKED', origin);
    if (code === 'NOT_FOUND') {
      log.warn('protocol.not-found', { mediaId }); // existe la fila pero falta el archivo
      return errorResponse(404, 'NOT_FOUND', origin);
    }
    if (code === 'INTEGRITY') {
      log.warn('protocol.integrity', { mediaId, code });
      return errorResponse(500, 'INTEGRITY', origin);
    }
    log.error('protocol.io', { errno: errnoOf(err), code });
    return errorResponse(500, 'IO', origin);
  }
  if (opened.signal.aborted || !deps.isUnlocked()) {
    opened.release();
    return errorResponse(423, 'LOCKED', origin);
  }

  const size = opened.reader.plaintextSize;
  const range = parseRange(request.headers.get('range'), size);
  if (range.kind === 'unsatisfiable') {
    opened.release();
    log.debug('protocol.rejected', { stage: 'range' });
    return errorResponse(416, null, origin, {
      'Content-Range': unsatisfiedRange(size),
      'Access-Control-Expose-Headers': EXPOSE,
    });
  }
  const start = range.kind === 'partial' ? range.start : 0;
  const end = range.kind === 'partial' ? range.end : size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  const headers: Record<string, string> = {
    ...baseHeaders(origin),
    'Content-Type': object.mime,
    'Content-Length': String(length),
    'Accept-Ranges': 'bytes',
    'Access-Control-Expose-Headers': EXPOSE,
  };
  if (range.kind === 'partial') headers['Content-Range'] = contentRange(start, end, size);
  const status = range.kind === 'partial' ? 206 : 200;
  if (request.method === 'HEAD' || length === 0) {
    opened.release();
    return new Response(null, { status, headers });
  }
  let node: Readable;
  try {
    node = opened.reader.createReadStream(start, end);
  } catch {
    opened.release();
    return errorResponse(500, 'INTERNAL', origin);
  }
  return new Response(lockableBody(node, opened, mediaId), { status, headers });
}

/** Manejador puro (se prueba con Request de Node). */
export async function handleVaultRequest(
  request: Request,
  deps: VaultProtocolDeps,
): Promise<Response> {
  const origin = deps.rendererOrigin();
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    log.debug('protocol.rejected', { stage: 'method' });
    return errorResponse(405, null, origin);
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return errorResponse(400, 'VALIDATION', origin);
  }
  if (url.protocol !== 'vault:' || !HOSTS.has(url.host)) {
    log.debug('protocol.rejected', { stage: 'host' });
    return errorResponse(400, 'VALIDATION', origin);
  }
  // La query solo admite rev con dígitos; el resto de claves se ignora.
  const rev = url.searchParams.get('rev');
  if (rev !== null && !/^\d{1,15}$/.test(rev)) return errorResponse(400, 'VALIDATION', origin);
  const segments = url.pathname.split('/').slice(1);

  if (url.host === 'media' || url.host === 'thumb') {
    if (segments.length !== 1 || !ID_PATTERN.test(segments[0] as string)) {
      log.debug('protocol.rejected', { stage: 'id' });
      return errorResponse(400, 'VALIDATION', origin);
    }
    return serveObject(request, url.host, segments[0] as string, deps, origin);
  }

  if (url.host === 'music') {
    // F4.
    if (!deps.isUnlocked()) return errorResponse(423, 'LOCKED', origin);
    return errorResponse(404, 'NOT_FOUND', origin);
  }

  if (segments.length === 2 && segments[0] === 'pending') {
    const token = segments[1] as string;
    if (!AVATAR_TOKEN_PATTERN.test(token)) return errorResponse(400, 'VALIDATION', origin);
    const webp = deps.pendingAvatar(token);
    if (!webp) return errorResponse(404, 'NOT_FOUND', origin);
    return okResponse(webp, request.method, origin);
  }
  if (segments.length !== 1 || !ID_PATTERN.test(segments[0] as string)) {
    return errorResponse(400, 'VALIDATION', origin);
  }
  try {
    const body = await readFile(deps.avatarFile(segments[0] as string));
    return okResponse(body, request.method, origin);
  } catch (err) {
    const errno = (err as { code?: unknown } | null)?.code;
    if (errno === 'ENOENT' || errno === 'EISDIR') return errorResponse(404, 'NOT_FOUND', origin);
    log.error('protocol.io', { errno: typeof errno === 'string' ? errno : undefined });
    return errorResponse(500, 'IO', origin);
  }
}

// ── Fuente de objetos de la sesión ─────────────────────────────────────────────────────────────

type SessionLike = Pick<
  SessionManager,
  'epoch' | 'getDb' | 'getKeyRing' | 'getVaultDir' | 'getSessionSignal' | 'registerReader'
>;

/**
 * Objetos de la sesión actual: la fila con getDb(epoch), las claves con getKeyRing(epoch) y el
 * lector registrado con registerReader(…, epoch), así un bloqueo lo pone a cero en el paso 4.
 */
export function sessionObjectSource(session: SessionLike): VaultObjectSource {
  return {
    find(host, mediaId) {
      const epoch = session.epoch;
      const row = findReady(session.getDb(epoch), mediaId);
      if (!row) return null;
      const vaultDir = session.getVaultDir(epoch);
      if (host === 'media') {
        return {
          mediaId,
          path: objectPath(vaultDir, mediaId),
          fileId: fileIdOf(mediaId),
          kind: KIND_MEDIA,
          mime: row.mime,
        };
      }
      if (!row.thumbId || !ID_PATTERN.test(row.thumbId)) return null;
      return {
        mediaId,
        path: thumbPath(vaultDir, row.thumbId),
        fileId: fileIdOf(row.thumbId),
        kind: KIND_THUMB,
        mime: 'image/webp',
      };
    },
    async open(object) {
      const epoch = session.epoch;
      const keyRing = session.getKeyRing(epoch);
      const signal = session.getSessionSignal(epoch);
      const reader = await openObject(
        object.path,
        { fileId: object.fileId, kind: object.kind },
        keyRing.kWrap,
        keyRing.dekCache,
      );
      let unregister: () => void;
      try {
        unregister = session.registerReader(reader, epoch); // si ya no vive: destroyKeys + LOCKED
      } catch (err) {
        await reader.close();
        throw err;
      }
      let released = false;
      return {
        reader,
        signal,
        release: () => {
          if (released) return;
          released = true;
          unregister();
          void reader.close();
        },
      };
    },
  };
}

/** Solo en la sesión `galeria` (§5.5). */
export function registerVaultProtocol(ses: Session, deps: VaultProtocolDeps): void {
  ses.protocol.handle('vault', (request) => handleVaultRequest(request, deps));
}
