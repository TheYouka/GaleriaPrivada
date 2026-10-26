// E2E de humo del scaffold (docs/PLAN.md 0.7; docs/DESIGN.md §5.4 "Verificación").
// El proceso del test levanta un servidor HTTP (TCP) y un socket UDP en 127.0.0.1 que cuentan lo
// que reciben: ninguna capa de la app debe dejar pasar nada.
import dgram from 'node:dgram';
import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { GaleriaApi } from '../../src/shared/ipc-contract';
import { PROD_CSP } from '../../src/main/security/csp';
import { launchApp, ROOT, type LaunchedApp } from './helpers/launch';

type Counters = Record<'http' | 'https' | 'ws' | 'wss' | 'file' | 'other', number>;
type GaleriaWindow = Window & { galeria: GaleriaApi };

let launched: LaunchedApp;
let server: http.Server;
let udp: dgram.Socket;
let tcpPort = 0;
let udpPort = 0;
let tcpConnections = 0;
let udpDatagrams = 0;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function blockedCounters(): Promise<Counters> {
  return launched.app.evaluate(() => ({
    ...(globalThis as unknown as { __galeriaNetBlocked: Counters }).__galeriaNetBlocked,
  }));
}

async function expectNothingReceived(): Promise<void> {
  await delay(300);
  expect(tcpConnections).toBe(0);
  expect(udpDatagrams).toBe(0);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  server = http.createServer((_req, res) => res.end('reached'));
  server.on('connection', () => {
    tcpConnections += 1;
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  tcpPort = (server.address() as AddressInfo).port;

  udp = dgram.createSocket('udp4');
  udp.on('message', () => {
    udpDatagrams += 1;
  });
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
  udpPort = udp.address().port;

  launched = await launchApp();
});

test.afterAll(async () => {
  await launched?.close();
  udp?.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
});

test('1. ventana: título visible y webPreferences endurecidas', async () => {
  const { app, page } = launched;
  await expect(page.getByRole('heading', { level: 1, name: 'Galería' })).toBeVisible();
  expect(await page.title()).toBe('Galería');

  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().startsWith('app://bundle/'),
    );
    if (!win) return null;
    // getLastWebPreferences() existe en runtime aunque no esté en electron.d.ts.
    const contents = win.webContents as unknown as {
      getLastWebPreferences: () => Record<string, unknown> | null;
    };
    const p = contents.getLastWebPreferences();
    return (
      p && {
        contextIsolation: p.contextIsolation,
        sandbox: p.sandbox,
        nodeIntegration: p.nodeIntegration,
        nodeIntegrationInSubFrames: p.nodeIntegrationInSubFrames,
        webSecurity: p.webSecurity,
        webviewTag: p.webviewTag,
      }
    );
  });
  expect(prefs).toEqual({
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    webviewTag: false,
  });

  const rendererGlobals = await page.evaluate(() => [typeof require, typeof process]);
  expect(rendererGlobals).toEqual(['undefined', 'undefined']);
});

test('2. preload e IPC: app:getInfo por el preload con sandbox y allowlist [H3-2]', async () => {
  const { app, page } = launched;
  const info = await page.evaluate(() =>
    (window as unknown as GaleriaWindow).galeria.invoke('app:getInfo'),
  );
  // ffmpegAvailable es real desde F2 (§19.4): true si `npm run fetch:ffmpeg` dejó los binarios.
  const ffmpegDir = join(
    ROOT,
    'resources',
    'ffmpeg',
    process.platform === 'win32' ? 'win-x64' : 'linux-x64',
    'bin',
  );
  const exe = process.platform === 'win32' ? '.exe' : '';
  const binariesExist =
    existsSync(join(ffmpegDir, `ffmpeg${exe}`)) && existsSync(join(ffmpegDir, `ffprobe${exe}`));
  expect(info).toEqual({
    ok: true,
    data: { ffmpegAvailable: binariesExist, platform: process.platform, version: '0.0.0' },
  });
  expect(
    await page.evaluate(() => typeof (window as unknown as GaleriaWindow).galeria.importDropped),
  ).toBe('function');

  // Un canal fuera de la allowlist se rechaza en el preload, sin llegar a main.
  await app.evaluate(({ ipcMain }) => {
    Object.assign(globalThis, { __e2eNotAllowedHit: false });
    ipcMain.handle('e2e:notAllowed', () => {
      Object.assign(globalThis, { __e2eNotAllowedHit: true });
      return 'reached-main';
    });
  });
  const outcome = await page.evaluate(() =>
    (window as unknown as { galeria: { invoke: (c: string) => Promise<unknown> } }).galeria
      .invoke('e2e:notAllowed')
      .then(
        () => 'resolved',
        () => 'rejected',
      ),
  );
  const hit = await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('e2e:notAllowed');
    return (globalThis as unknown as { __e2eNotAllowedHit: boolean }).__e2eNotAllowedHit;
  });
  expect(outcome).toBe('rejected');
  expect(hit).toBe(false);
});

test('3. CSP: fetch externo desde el renderer se rechaza', async () => {
  const { page } = launched;
  const result = await page.evaluate(async () => {
    const violation = new Promise<string>((resolve) => {
      document.addEventListener('securitypolicyviolation', (e) => resolve(e.violatedDirective), {
        once: true,
      });
    });
    const outcome = await fetch('https://example.com').then(
      () => 'resolved',
      (e: unknown) => `rejected: ${String(e)}`,
    );
    const directive = await Promise.race([
      violation,
      new Promise<string>((r) => setTimeout(() => r('none'), 2000)),
    ]);
    return { outcome, directive };
  });
  expect(result.outcome).toMatch(/^rejected/);
  expect(result.directive).toBe('connect-src');

  // La CSP exacta de §5.3 llega como cabecera en las respuestas de app://bundle.
  const header = await page.evaluate(() =>
    fetch('app://bundle/index.html').then((r) => r.headers.get('content-security-policy')),
  );
  expect(header).toBe(PROD_CSP);
});

test('4. webRequest aislado: loadURL desde main → ERR_BLOCKED_BY_CLIENT', async () => {
  const before = await blockedCounters();
  const code = await launched.app.evaluate(({ BrowserWindow }, url) => {
    const w = new BrowserWindow({
      show: false,
      webPreferences: { partition: 'galeria', sandbox: true },
    });
    return w
      .loadURL(url)
      .then(
        () => 'loaded',
        (e: { code?: string }) => e.code ?? String(e),
      )
      .finally(() => w.destroy());
  }, `http://127.0.0.1:${tcpPort}/`);
  expect(code).toBe('ERR_BLOCKED_BY_CLIENT');
  const after = await blockedCounters();
  expect(after.http).toBeGreaterThanOrEqual(1);
  expect(after.http).toBeGreaterThan(before.http);
  await expectNothingReceived();
});

test('5. electron.net: net.fetch desde main se rechaza y lo cuenta webRequest', async () => {
  const before = await blockedCounters();
  const outcome = await launched.app.evaluate(
    ({ net }, url) =>
      net.fetch(url).then(
        () => 'resolved',
        (e: unknown) => `rejected: ${String(e)}`,
      ),
    `http://127.0.0.1:${tcpPort}/`,
  );
  expect(outcome).toMatch(/^rejected/);
  const after = await blockedCounters();
  console.log(`[e2e] net.fetch: ${outcome}; http bloqueadas ${before.http} → ${after.http}`);
  expect(after.http).toBeGreaterThan(before.http);
  await expectNothingReceived();
});

test('6. Node en main: fetch, net, dns, dgram y process.binding → EGALERIA_NET', async () => {
  const codes = await launched.app.evaluate(
    async (_electron, ports) => {
      const code = async (fn: () => unknown): Promise<string> => {
        try {
          await fn();
          return 'no-error';
        } catch (e) {
          return String((e as { code?: unknown }).code);
        }
      };
      const net = process.getBuiltinModule('node:net');
      const dns = process.getBuiltinModule('node:dns');
      const dgram = process.getBuiltinModule('node:dgram');
      const UdpSocket = dgram.Socket as unknown as new (type: 'udp4') => {
        send: (msg: Buffer, port: number, host: string) => void;
      };
      const proc = process as unknown as { binding: (name: string) => unknown };
      return {
        fetch: await code(() => fetch(`http://127.0.0.1:${ports.tcp}/`)),
        netConnect: await code(() => net.connect(ports.tcp, '127.0.0.1')),
        dnsLookup: await code(() => dns.promises.lookup('example.com')),
        dgramSend: await code(() =>
          new UdpSocket('udp4').send(Buffer.from('x'), ports.udp, '127.0.0.1'),
        ),
        tcpWrap: await code(() => proc.binding('tcp_wrap')),
      };
    },
    { tcp: tcpPort, udp: udpPort },
  );
  expect(codes).toEqual({
    fetch: 'EGALERIA_NET',
    netConnect: 'EGALERIA_NET',
    dnsLookup: 'EGALERIA_NET',
    dgramSend: 'EGALERIA_NET',
    tcpWrap: 'EGALERIA_NET',
  });
  await expectNothingReceived();
});

test('7. proxy inexistente en la sesión y en la app [H3-5]', async () => {
  const proxies = await launched.app.evaluate(async ({ app, session }) => ({
    galeria: await session.fromPartition('galeria').resolveProxy('https://example.com'),
    defaultSession: await session.defaultSession.resolveProxy('https://example.com'),
    app:
      typeof app.resolveProxy === 'function' ? await app.resolveProxy('https://example.com') : null,
  }));
  console.log(`[e2e] resolveProxy: ${JSON.stringify(proxies)}`);
  const deadProxy = /^SOCKS5? 127\.0\.0\.1:9$/;
  expect(proxies.galeria).toMatch(deadProxy);
  expect(proxies.defaultSession).toMatch(deadProxy);
  expect(proxies.app).toMatch(deadProxy);
});

test('8. WebRTC: sin constructores en el renderer y sin tráfico desde un iframe', async () => {
  const { page } = launched;
  const types = await page.evaluate(() => [
    typeof RTCPeerConnection,
    typeof (window as unknown as { webkitRTCPeerConnection?: unknown }).webkitRTCPeerConnection,
  ]);
  expect(types).toEqual(['undefined', 'undefined']);

  const outcome = await page.evaluate(
    async (ports) => {
      const iframe = document.createElement('iframe');
      document.body.appendChild(iframe);
      const PC = (iframe.contentWindow as (Window & typeof globalThis) | null)?.RTCPeerConnection;
      if (!PC) {
        iframe.remove();
        return 'no-constructor';
      }
      const pc = new PC({
        iceServers: [
          { urls: `turn:127.0.0.1:${ports.tcp}?transport=tcp`, username: 'u', credential: 'p' },
          { urls: `stun:127.0.0.1:${ports.udp}` },
        ],
      });
      pc.createDataChannel('x');
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => setTimeout(r, 5000));
      pc.close();
      iframe.remove();
      return 'ran';
    },
    { tcp: tcpPort, udp: udpPort },
  );
  console.log(`[e2e] WebRTC desde iframe: ${outcome}`);
  expect(['ran', 'no-constructor']).toContain(outcome);
  await expectNothingReceived();
});
