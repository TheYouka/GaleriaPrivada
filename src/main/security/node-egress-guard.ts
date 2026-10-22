// Bloqueo en tiempo de ejecución de la red de Node en el proceso main (docs/DESIGN.md §5.4, punto 10,
// y [H3-5]). Es la primera sentencia de src/main/index.ts.
//
// Cubre los usos accidentales de red en el código de las dependencias. No protege frente a una
// dependencia maliciosa de main, que tiene todos los privilegios de Node (`child_process`, addons
// nativos); eso queda fuera del modelo (§5.1).
//
// Falla cerrado: ninguna asignación va en `try`. Si alguna lanzara (por ejemplo, una propiedad no
// configurable en otra versión de Node), la app no arranca.
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';

export const EGRESS_ERROR_CODE = 'EGALERIA_NET';

const egressError = (): Error =>
  Object.assign(new Error('network disabled'), { code: EGRESS_ERROR_CODE });

// Bindings internos de Node que abren sockets TCP/UDP/TLS o consultas DNS de c-ares (P10).
const BLOCKED_BINDINGS = new Set(['tcp_wrap', 'udp_wrap', 'cares_wrap', 'tls_wrap']);

// Destino de Socket#connect: Node llama a connect() con los argumentos ya normalizados
// (un array [opts, cb]) desde net.connect(), o con (opts) / (path) / (port, host) directamente.
function connectPath(args: unknown[]): string | undefined {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (first && typeof first === 'object') {
    const p = (first as { path?: unknown }).path;
    return typeof p === 'string' ? p : undefined;
  }
  return typeof first === 'string' && !/^\d+$/.test(first) ? first : undefined;
}

const isDnsQuery = (k: string): boolean =>
  k === 'lookup' || k === 'lookupService' || k === 'reverse' || k.startsWith('resolve');

export function installNodeEgressGuard(): void {
  const deny = (): never => {
    throw egressError();
  };
  const denyAsync = (): Promise<never> => Promise.reject(egressError());

  // fetch, WebSocket y EventSource globales (undici).
  globalThis.fetch = (() => Promise.reject(egressError())) as typeof fetch;
  for (const k of ['WebSocket', 'EventSource'] as const) {
    Object.defineProperty(globalThis, k, {
      value: undefined,
      configurable: false,
      writable: false,
    });
  }

  // TCP: tls.connect, http.request, http2.connect y undici acaban en Socket#connect.
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    if (connectPath(args) !== undefined) return connect.apply(this, args as never); // solo pipe/socket unix local
    throw egressError(); // ninguna conexión TCP
  } as typeof connect;

  // UDP: createSocket y también los métodos del prototipo, por si alguien usa `new dgram.Socket()`.
  dgram.createSocket = deny as never;
  for (const k of ['bind', 'connect', 'send'] as const) {
    dgram.Socket.prototype[k] = deny as never;
  }

  // DNS: c-ares abre sus propios sockets sin pasar por dgram.
  // Excepción: lookup() de un literal IP. Node lo resuelve sin red (isIP) y lo necesita
  // net.Server#listen(port, '127.0.0.1'), que siempre pasa por dns.lookup (servidor loopback, §18).
  const lookup = dns.lookup;
  const lookupPromise = dns.promises.lookup;
  const dnsModule = dns as unknown as Record<string, unknown>;
  for (const k of Object.keys(dns)) {
    if (isDnsQuery(k)) dnsModule[k] = deny;
  }
  dnsModule.lookup = function (this: unknown, hostname: unknown, ...rest: unknown[]): unknown {
    if (typeof hostname !== 'string' || net.isIP(hostname) === 0) throw egressError();
    return (lookup as (...a: unknown[]) => unknown).call(this, hostname, ...rest);
  };
  const dnsPromises = dns.promises as unknown as Record<string, unknown>;
  for (const k of Object.keys(dns.promises)) {
    if (isDnsQuery(k)) dnsPromises[k] = denyAsync;
  }
  dnsPromises.lookup = function (this: unknown, hostname: unknown, ...rest: unknown[]): unknown {
    if (typeof hostname !== 'string' || net.isIP(hostname) === 0) return denyAsync();
    return (lookupPromise as (...a: unknown[]) => unknown).call(this, hostname, ...rest);
  };
  for (const proto of [dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    const resolver = proto as unknown as Record<string, unknown>;
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (k === 'reverse' || k.startsWith('resolve')) resolver[k] = deny;
    }
  }

  // process.binding (obsoleto, pero sigue dando acceso a los bindings de red) [H3-5].
  const proc = process as unknown as { binding: (name: string) => unknown };
  const binding = proc.binding;
  proc.binding = function (this: unknown, name: string): unknown {
    if (BLOCKED_BINDINGS.has(name)) throw egressError();
    return binding.call(this, name);
  };
}
