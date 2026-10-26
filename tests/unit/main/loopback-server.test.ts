// media/loopback-server.ts (docs/DESIGN.md §18.5): token, Host, refs, Range sobre un objeto
// cifrado, HEAD y cierre al abortar.
import { randomBytes, randomInt } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHUNK, KIND_MEDIA } from '../../../src/main/crypto/file-format';
import { openObject, type ObjectReader } from '../../../src/main/crypto/object-reader';
import {
  LOOPBACK_LIMITS,
  LoopbackServer,
  type LoopbackTarget,
} from '../../../src/main/media/loopback-server';
import { collect, randomKey, writeObject, type WrittenObject } from '../helpers/crypto';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function request(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
        agent: false,
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Petición cruda con keep-alive: devuelve la respuesta y si el servidor cerró el socket. */
function rawRequest(
  port: number,
  lines: string[],
  waitMs = 500,
): Promise<{ text: string; closedByServer: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let text = '';
    let closed = false;
    socket.setEncoding('latin1');
    socket.on('data', (d: string) => {
      text += d;
    });
    const timer = setTimeout(() => {
      const result = { text, closedByServer: closed };
      socket.destroy();
      resolve(result);
    }, waitMs);
    socket.on('close', () => {
      closed = true;
      clearTimeout(timer);
      resolve({ text, closedByServer: true });
    });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${lines.join('\r\n')}\r\n\r\n`));
  });
}

const dir = makeTmpDir('loopback');
const kWrap = randomKey();
const plaintext = randomBytes(3 * CHUNK + 1234);
let object: WrittenObject;
let empty: WrittenObject;
let opened: ObjectReader[] = [];

const open = async (t: LoopbackTarget): Promise<ObjectReader> => {
  const reader = await openObject(t.path, { fileId: t.fileId, kind: t.kind }, kWrap);
  opened.push(reader);
  return reader;
};

beforeAll(async () => {
  object = await writeObject(dir, plaintext, kWrap);
  empty = await writeObject(dir, Buffer.alloc(0), kWrap);
});

afterAll(() => removeTmpDir(dir));

async function startWithSrc(): Promise<{ server: LoopbackServer; path: string; host: string }> {
  const server = await LoopbackServer.start({ open });
  const url = server.register('src', {
    path: object.path,
    fileId: object.fileId,
    kind: KIND_MEDIA,
    mime: 'video/mp4',
  });
  const u = new URL(url);
  return { server, path: u.pathname, host: u.host };
}

describe('LoopbackServer', () => {
  it('escucha en 127.0.0.1, puerto aleatorio, con los límites de §18.5', async () => {
    const { server, host } = await startWithSrc();
    expect(host).toBe(`127.0.0.1:${server.port}`);
    expect(server.port).toBeGreaterThan(0);
    expect(server.limits).toEqual(LOOPBACK_LIMITS);
    expect(server.url('src')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]{43}\/src$/);
    await server.close();
  });

  it('GET sin Range → 200 con el plaintext exacto y sin CORS', async () => {
    const { server, path } = await startWithSrc();
    const res = await request(server.port, path);
    expect(res.status).toBe(200);
    expect(res.body.equals(plaintext)).toBe(true);
    expect(res.headers['content-length']).toBe(String(plaintext.length));
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    await server.close();
  });

  it('Range sobre el objeto cifrado devuelve los bytes exactos (bordes de chunk y aleatorios)', async () => {
    const { server, path } = await startWithSrc();
    const P = plaintext.length;
    const ranges: [number, number][] = [
      [0, 0],
      [CHUNK - 1, CHUNK],
      [CHUNK, 2 * CHUNK - 1],
      [P - 1, P - 1],
      [0, P - 1],
    ];
    for (let i = 0; i < 20; i += 1) {
      const a = randomInt(0, P);
      ranges.push([a, randomInt(a, P)]);
    }
    for (const [a, b] of ranges) {
      const res = await request(server.port, path, { headers: { Range: `bytes=${a}-${b}` } });
      expect(res.status).toBe(206);
      expect(res.headers['content-range']).toBe(`bytes ${a}-${b}/${P}`);
      expect(res.headers['content-length']).toBe(String(b - a + 1));
      expect(res.body.equals(plaintext.subarray(a, b + 1))).toBe(true);
    }
    const tail = await request(server.port, path, { headers: { Range: 'bytes=-10' } });
    expect(tail.body.equals(plaintext.subarray(P - 10))).toBe(true);
    const unsat = await request(server.port, path, { headers: { Range: `bytes=${P}-` } });
    expect(unsat.status).toBe(416);
    expect(unsat.headers['content-range']).toBe(`bytes */${P}`);
    const many = await request(server.port, path, { headers: { Range: 'bytes=0-1,4-5' } });
    expect(many.status).toBe(200);
    expect(many.body.length).toBe(P);
    await server.close();
  });

  it('HEAD con Range → 206 con las cabeceras del GET y sin cuerpo', async () => {
    const { server, path } = await startWithSrc();
    const res = await request(server.port, path, {
      method: 'HEAD',
      headers: { Range: 'bytes=5-9' },
    });
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 5-9/${plaintext.length}`);
    expect(res.headers['content-length']).toBe('5');
    expect(res.body.length).toBe(0);
    await server.close();
  });

  it('objeto vacío: 200 vacío sin Range y 416 con Range', async () => {
    const server = await LoopbackServer.start({ open });
    const url = new URL(
      server.register('e', { path: empty.path, fileId: empty.fileId, kind: KIND_MEDIA }),
    );
    const full = await request(server.port, url.pathname);
    expect(full.status).toBe(200);
    expect(full.body.length).toBe(0);
    const ranged = await request(server.port, url.pathname, { headers: { Range: 'bytes=0-' } });
    expect(ranged.status).toBe(416);
    expect(ranged.headers['content-range']).toBe('bytes */0');
    await server.close();
  });

  it('token incorrecto, Host distinto, ref desconocida o método → 404 sin cuerpo y socket cerrado', async () => {
    const { server, path, host } = await startWithSrc();
    const token = path.split('/')[1] as string;
    const badToken = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const cases: string[][] = [
      [`GET /${badToken}/src HTTP/1.1`, `Host: ${host}`],
      [`GET ${path} HTTP/1.1`, `Host: localhost:${server.port}`],
      [`GET ${path} HTTP/1.1`, 'Host: evil.example'],
      [`GET ${path} HTTP/1.1`],
      [`GET /${token}/nada HTTP/1.1`, `Host: ${host}`],
      [`GET /${token}/src/ HTTP/1.1`, `Host: ${host}`],
      [`GET /${token} HTTP/1.1`, `Host: ${host}`],
      [`POST ${path} HTTP/1.1`, `Host: ${host}`, 'Content-Length: 0'],
      [`DELETE ${path} HTTP/1.1`, `Host: ${host}`],
    ];
    for (const lines of cases) {
      const res = await rawRequest(server.port, [...lines, 'Connection: keep-alive']);
      expect(res.text, lines.join(' | ')).toMatch(/^HTTP\/1\.1 404 /);
      expect(res.text).toMatch(/content-length: 0\r\n/i);
      expect(res.text.endsWith('\r\n\r\n')).toBe(true);
      expect(res.closedByServer, lines.join(' | ')).toBe(true);
    }
    // Control: una petición válida con keep-alive no cierra el socket.
    const ok = await rawRequest(server.port, [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      'Range: bytes=0-3',
      'Connection: keep-alive',
    ]);
    expect(ok.text).toMatch(/^HTTP\/1\.1 206 /);
    expect(ok.closedByServer).toBe(false);
    await server.close();
  });

  it('una ref anulada deja de servirse', async () => {
    const { server, path } = await startWithSrc();
    server.unregister('src');
    const res = await request(server.port, path);
    expect(res.status).toBe(404);
    await server.close();
  });

  it('tras abortar: cierra la respuesta en curso, los lectores y no acepta conexiones', async () => {
    opened = [];
    const big = await writeObject(dir, randomBytes(8 * 1024 * 1024), kWrap);
    const ac = new AbortController();
    const server = await LoopbackServer.start({ open, signal: ac.signal });
    const url = new URL(
      server.register('src', { path: big.path, fileId: big.fileId, kind: KIND_MEDIA }),
    );
    // El cliente recibe el primer trozo y entonces se aborta el trabajo: la respuesta se corta.
    const received = await new Promise<number>((resolve) => {
      let total = 0;
      const req = http.request(
        { host: '127.0.0.1', port: server.port, path: url.pathname, agent: false },
        (res) => {
          res.on('data', (c: Buffer) => {
            if (total === 0) ac.abort();
            total += c.length;
          });
          res.on('error', () => resolve(total));
          res.on('close', () => resolve(total));
          res.on('end', () => resolve(total));
        },
      );
      req.on('error', () => resolve(total));
      req.end();
    });
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThan(big.result.plaintextSize);
    await server.close();
    expect(server.closed).toBe(true);
    expect(opened.length).toBeGreaterThan(0);
    // Los lectores abiertos quedaron sin DEK: leer falla con LOCKED.
    for (const r of opened) {
      await expect(collect(r.createReadStream(0, 0))).rejects.toMatchObject({
        error: { code: 'LOCKED' },
      });
    }
    const refused = await new Promise<string>((resolve) => {
      const s = net.connect(server.port, '127.0.0.1');
      s.on('connect', () => {
        s.destroy();
        resolve('connected');
      });
      s.on('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    });
    expect(refused).toBe('ECONNREFUSED');
    expect(() =>
      server.register('x', { path: object.path, fileId: object.fileId, kind: KIND_MEDIA }),
    ).toThrow();
  });

  it('con la señal ya abortada no arranca', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(LoopbackServer.start({ open, signal: ac.signal })).rejects.toMatchObject({
      error: { code: 'CANCELLED' },
    });
  });

  it('ref con formato inválido es un error de programación', async () => {
    const server = await LoopbackServer.start({ open });
    for (const ref of ['', 'SRC', 'a/b', 'abcdefghi', '../x']) {
      expect(() =>
        server.register(ref, { path: object.path, fileId: object.fileId, kind: KIND_MEDIA }),
      ).toThrow(RangeError);
    }
    await server.close();
  });
});
