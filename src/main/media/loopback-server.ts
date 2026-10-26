// Servidor loopback (docs/DESIGN.md §18.5): la entrada de ffmpeg y ffprobe cuando el origen es un
// objeto cifrado de la bóveda (miniaturas de vídeo, verificación de vídeos importados, fusiones).
// Descifra al vuelo con object-reader; nada descifrado toca el disco.
//
// - `127.0.0.1`, puerto aleatorio del SO (`exclusive`), un servidor por trabajo.
// - Rutas `/<token>/<ref>`: token de 32 bytes en base64url comparado con `timingSafeEqual`; `ref`
//   es una etiqueta corta registrada por el trabajo (`l`, `r`, `src`…).
// - Validación: `Host` exacto `127.0.0.1:<puerto>` (DNS rebinding), GET o HEAD, token y ref.
//   Cualquier fallo → 404 sin cuerpo y socket cerrado.
// - Respuesta: Range y cabeceras como en §11.2/§11.3 (range.ts), sin CORS.
// - Límites: headersTimeout 10 s, requestTimeout 0, keepAliveTimeout 5 s, maxConnections 8.
// - close() (al terminar, cancelar o bloquear; también con el `signal` del trabajo): close() +
//   closeAllConnections() y cierre de los lectores abiertos. No registra las peticiones.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { AppErrorException } from '@shared/errors';
import type { ObjectKind } from '../crypto/file-format';
import type { ObjectReader } from '../crypto/object-reader';
import { contentRange, parseRange, unsatisfiedRange } from '../protocol/range';

export const LOOPBACK_HOST = '127.0.0.1';
export const LOOPBACK_LIMITS = Object.freeze({
  headersTimeout: 10_000,
  requestTimeout: 0,
  keepAliveTimeout: 5000,
  maxConnections: 8,
});
const REF_PATTERN = /^[a-z]{1,8}$/;
const PATH_PATTERN = /^\/([A-Za-z0-9_-]{43})\/([a-z]{1,8})$/;

/** Objeto cifrado que sirve una ref. */
export interface LoopbackTarget {
  path: string;
  fileId: Buffer;
  kind: ObjectKind;
  /** Content-Type; por defecto application/octet-stream. */
  mime?: string;
}

export interface LoopbackOptions {
  /** Abre el objeto con las claves de la sesión (el trabajo lo registra con registerReader). */
  open(target: LoopbackTarget): Promise<ObjectReader>;
  /** Señal del trabajo: al abortar se cierra el servidor. */
  signal?: AbortSignal;
}

export class LoopbackServer {
  private readonly refs = new Map<string, LoopbackTarget>();
  private readonly readers = new Set<ObjectReader>();
  private readonly tokenBytes: Buffer;
  private closing: Promise<void> | null = null;
  private portValue = 0;

  private constructor(
    private readonly server: Server,
    private readonly token: string,
    private readonly opts: LoopbackOptions,
  ) {
    this.tokenBytes = Buffer.from(token, 'utf8');
  }

  /** Arranca en un puerto aleatorio de 127.0.0.1. LOCKED/CANCELLED si la señal ya abortó. */
  static async start(opts: LoopbackOptions): Promise<LoopbackServer> {
    if (opts.signal?.aborted) throw new AppErrorException({ code: 'CANCELLED' });
    const token = randomBytes(32).toString('base64url');
    let self: LoopbackServer | null = null;
    // requireHostHeader: false para que una petición sin Host también reciba el 404 de onRequest.
    const server = createServer({ requireHostHeader: false }, (req, res) => {
      if (self) self.onRequest(req, res);
      else reject404(req, res);
    });
    server.headersTimeout = LOOPBACK_LIMITS.headersTimeout;
    server.requestTimeout = LOOPBACK_LIMITS.requestTimeout;
    server.keepAliveTimeout = LOOPBACK_LIMITS.keepAliveTimeout;
    server.maxConnections = LOOPBACK_LIMITS.maxConnections;
    // HTTP mal formado: se cierra el socket sin responder.
    server.on('clientError', (_err, socket) => socket.destroy());
    self = new LoopbackServer(server, token, opts);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new AppErrorException({ code: 'INTERNAL', details: { reason: 'loopback-address' } });
    }
    self.portValue = address.port;
    const created = self;
    if (opts.signal) {
      if (opts.signal.aborted) await created.close();
      else opts.signal.addEventListener('abort', () => void created.close(), { once: true });
    }
    return created;
  }

  get port(): number {
    return this.portValue;
  }

  get closed(): boolean {
    return this.closing !== null;
  }

  /** Límites aplicados al servidor (§18.5). */
  get limits(): Record<keyof typeof LOOPBACK_LIMITS, number> {
    const s = this.server;
    return {
      headersTimeout: s.headersTimeout,
      requestTimeout: s.requestTimeout,
      keepAliveTimeout: s.keepAliveTimeout,
      maxConnections: s.maxConnections,
    };
  }

  /** Registra `ref` y devuelve su URL (la que recibe ffmpeg con `-i`). */
  register(ref: string, target: LoopbackTarget): string {
    if (!REF_PATTERN.test(ref)) throw new RangeError('ref inválida');
    if (this.closing) throw new AppErrorException({ code: 'CANCELLED' });
    this.refs.set(ref, target);
    return this.url(ref);
  }

  unregister(ref: string): void {
    this.refs.delete(ref);
  }

  url(ref: string): string {
    return `http://${LOOPBACK_HOST}:${this.portValue}/${this.token}/${ref}`;
  }

  /** Cierra el servidor, todas las conexiones y los lectores abiertos. Idempotente. */
  close(): Promise<void> {
    this.closing ??= new Promise<void>((resolve) => {
      this.refs.clear();
      for (const reader of [...this.readers]) void reader.close();
      this.readers.clear();
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
    return this.closing;
  }

  private matchesToken(candidate: string): boolean {
    const bytes = Buffer.from(candidate, 'utf8');
    return bytes.length === this.tokenBytes.length && timingSafeEqual(bytes, this.tokenBytes);
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    if (this.closing) return reject404(req, res);
    if (req.headers.host !== `${LOOPBACK_HOST}:${this.portValue}`) return reject404(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return reject404(req, res);
    const m = PATH_PATTERN.exec(req.url ?? '');
    if (!m || !this.matchesToken(m[1] as string)) return reject404(req, res);
    const target = this.refs.get(m[2] as string);
    if (!target) return reject404(req, res);
    void this.serve(req, res, target);
  }

  private async serve(
    req: IncomingMessage,
    res: ServerResponse,
    target: LoopbackTarget,
  ): Promise<void> {
    let reader: ObjectReader;
    try {
      reader = await this.opts.open(target);
    } catch (err) {
      const code = err instanceof AppErrorException ? err.error.code : 'IO';
      return plainStatus(req, res, code === 'NOT_FOUND' ? 404 : 500);
    }
    if (this.closing) {
      await reader.close();
      return plainStatus(req, res, 500);
    }
    this.readers.add(reader);
    try {
      const size = reader.plaintextSize;
      const range = parseRange(req.headers.range, size);
      const headers: Record<string, string> = {
        'Content-Type': target.mime ?? 'application/octet-stream',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      };
      if (range.kind === 'unsatisfiable') {
        res.writeHead(416, {
          ...headers,
          'Content-Range': unsatisfiedRange(size),
          'Content-Length': '0',
        });
        res.end();
        return;
      }
      const start = range.kind === 'partial' ? range.start : 0;
      const end = range.kind === 'partial' ? range.end : size - 1;
      const length = size === 0 ? 0 : end - start + 1;
      if (range.kind === 'partial') headers['Content-Range'] = contentRange(start, end, size);
      headers['Content-Length'] = String(length);
      res.writeHead(range.kind === 'partial' ? 206 : 200, headers);
      if (req.method === 'HEAD' || length === 0) {
        res.end();
        return;
      }
      await pipeline(reader.createReadStream(start, end), res);
    } catch {
      // Cliente desconectado, bloqueo (LOCKED) o chunk dañado (INTEGRITY): la respuesta se corta.
      res.destroy();
    } finally {
      this.readers.delete(reader);
      await reader.close();
    }
  }
}

function reject404(req: IncomingMessage, res: ServerResponse): void {
  plainStatus(req, res, 404);
}

/** Respuesta sin cuerpo y socket cerrado. */
function plainStatus(req: IncomingMessage, res: ServerResponse, status: number): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.shouldKeepAlive = false;
  res.writeHead(status, { 'Content-Length': '0', Connection: 'close' });
  res.end(() => req.socket.destroy());
}
