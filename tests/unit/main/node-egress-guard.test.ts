// Guard de red de Node (docs/DESIGN.md §5.4, punto 10, y [H3-5]). Vitest ejecuta cada archivo en su
// propio proceso (pool: 'forks'), así que instalar el guard aquí no afecta a otros tests.
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installNodeEgressGuard } from '../../../src/main/security/node-egress-guard';

let tcpServer: net.Server;
let udpSocket: dgram.Socket;
let tcpPort = 0;
let udpPort = 0;
let tcpConnections = 0;
let udpDatagrams = 0;

/** Código de error de una llamada que puede lanzar en síncrono o rechazar. */
async function errorCode(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return String((err as { code?: unknown }).code);
  }
  return 'no-error';
}

const UdpSocket = dgram.Socket as unknown as new (type: 'udp4') => dgram.Socket;
const binding = (name: string): unknown =>
  (process as unknown as { binding: (n: string) => unknown }).binding(name);
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  // Los receptores se crean antes del guard: después dgram.createSocket y bind están bloqueados.
  tcpServer = net.createServer((socket) => {
    tcpConnections += 1;
    socket.destroy();
  });
  await new Promise<void>((r) => tcpServer.listen(0, '127.0.0.1', r));
  tcpPort = (tcpServer.address() as AddressInfo).port;

  udpSocket = dgram.createSocket('udp4');
  udpSocket.on('message', () => {
    udpDatagrams += 1;
  });
  await new Promise<void>((r) => udpSocket.bind(0, '127.0.0.1', r));
  udpPort = udpSocket.address().port;

  installNodeEgressGuard();
});

afterAll(async () => {
  udpSocket.close();
  await new Promise<void>((r) => tcpServer.close(() => r()));
});

describe('installNodeEgressGuard', () => {
  it('bloquea fetch, net.connect y DNS con EGALERIA_NET', async () => {
    expect(await errorCode(() => fetch(`http://127.0.0.1:${tcpPort}/`))).toBe('EGALERIA_NET');
    expect(await errorCode(() => net.connect(tcpPort, '127.0.0.1'))).toBe('EGALERIA_NET');
    expect(await errorCode(() => net.createConnection({ port: tcpPort, host: '127.0.0.1' }))).toBe(
      'EGALERIA_NET',
    );
    expect(await errorCode(() => dns.promises.lookup('example.com'))).toBe('EGALERIA_NET');
    expect(await errorCode(() => dns.lookup('example.com', () => undefined))).toBe('EGALERIA_NET');
    expect(await errorCode(() => new dns.Resolver().resolve4('example.com', () => undefined))).toBe(
      'EGALERIA_NET',
    );
    expect(await errorCode(() => new dns.promises.Resolver().resolve4('example.com'))).toBe(
      'EGALERIA_NET',
    );
  });

  it('bloquea dgram.createSocket y los métodos de dgram.Socket [H3-5]', async () => {
    expect(await errorCode(() => dgram.createSocket('udp4'))).toBe('EGALERIA_NET');
    const sock = new UdpSocket('udp4');
    expect(await errorCode(() => sock.send(Buffer.from('x'), udpPort, '127.0.0.1'))).toBe(
      'EGALERIA_NET',
    );
    expect(await errorCode(() => sock.bind(0))).toBe('EGALERIA_NET');
    expect(await errorCode(() => sock.connect(udpPort))).toBe('EGALERIA_NET');
  });

  it('bloquea process.binding de los bindings de red [H3-5]', async () => {
    for (const name of ['tcp_wrap', 'udp_wrap', 'cares_wrap', 'tls_wrap']) {
      expect(await errorCode(() => binding(name))).toBe('EGALERIA_NET');
    }
  });

  it('no llega ninguna conexión TCP ni ningún datagrama UDP', async () => {
    await delay(200);
    expect(tcpConnections).toBe(0);
    expect(udpDatagrams).toBe(0);
  });

  it('sigue permitiendo servidores locales entrantes', async () => {
    const server = net.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    expect((server.address() as AddressInfo).port).toBeGreaterThan(0);
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('sigue permitiendo procesos hijos con stdio en tubería', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ok")']);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    const code = await new Promise<number | null>((r) => child.on('close', r));
    expect(code).toBe(0);
    expect(out).toBe('ok');
  });
});
