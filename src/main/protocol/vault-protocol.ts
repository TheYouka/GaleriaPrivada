// Protocolo vault:// (docs/DESIGN.md §11), primera versión (F1): solo los avatares, que van en claro
// y no requieren desbloqueo:
//   vault://avatar/<profileId>?rev=<n>   avatars/<profileId>.webp (rev solo invalida caché)
//   vault://avatar/pending/<token>       WebP elegido y aún no guardado (en memoria, 10 min)
// media, thumb y music llegan en F2/F4: hasta entonces responden 423 con la sesión bloqueada y 404
// con ella abierta. Errores con cuerpo vacío y X-Galeria-Error (§11.4). Sin Range todavía: range.ts
// llega en F2 con media/thumb; un avatar (≤ 256×256) siempre se sirve entero con 200.
import { readFile } from 'node:fs/promises';
import type { Session } from 'electron';
import { AVATAR_TOKEN_PATTERN, ID_PATTERN } from '@shared/constants';
import type { ErrorCode } from '@shared/errors';
import { log } from '../log';

export interface VaultProtocolDeps {
  /** Ruta de avatars/<profileId>.webp (el id ya está validado). */
  avatarFile(profileId: string): string;
  /** WebP pendiente del token, o null si no existe o caducó. */
  pendingAvatar(token: string): Buffer | null;
  /** app://bundle, o el origen de Vite en desarrollo (CORS, §5.5). */
  rendererOrigin(): string;
  isUnlocked(): boolean;
}

const HOSTS: ReadonlySet<string> = new Set(['media', 'thumb', 'music', 'avatar']);

function errorResponse(status: number, code: ErrorCode | null, origin: string): Response {
  const headers: Record<string, string> = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': origin,
  };
  if (code) headers['X-Galeria-Error'] = code;
  if (status === 405) headers.Allow = 'GET, HEAD';
  return new Response(null, { status, headers });
}

function okResponse(body: Buffer, method: string, origin: string): Response {
  return new Response(method === 'HEAD' ? null : new Uint8Array(body), {
    status: 200,
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    },
  });
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

  if (url.host !== 'avatar') {
    // F2/F4: media, thumb y music.
    if (!deps.isUnlocked()) return errorResponse(423, 'LOCKED', origin);
    return errorResponse(404, 'NOT_FOUND', origin);
  }

  const segments = url.pathname.split('/').slice(1);
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

/** Solo en la sesión `galeria` (§5.5). */
export function registerVaultProtocol(ses: Session, deps: VaultProtocolDeps): void {
  ses.protocol.handle('vault', (request) => handleVaultRequest(request, deps));
}
