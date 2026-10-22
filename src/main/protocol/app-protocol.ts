// app://bundle/<ruta> → out/renderer (docs/DESIGN.md §5.5). Evita cargar con file://.
import { readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Session } from 'electron';
import { PROD_CSP } from '../security/csp';

export const APP_HOST = 'bundle';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json',
};

const notFound = (): Response => new Response(null, { status: 404 });

/** Ruta relativa segura dentro del bundle, o null si hay que rechazarla. */
export function resolveBundlePath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const relative = decoded.replace(/^\/+/, '');
  if (relative === '' || /^[a-zA-Z]:/.test(relative)) return null;
  const segments = relative.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  const base = resolve(root);
  const file = resolve(join(base, ...segments));
  return file.startsWith(base + sep) ? file : null;
}

function extensionOf(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? '' : file.slice(dot).toLowerCase();
}

export function registerAppProtocol(ses: Session): void {
  const root = join(__dirname, '../renderer');
  ses.protocol.handle('app', async (request) => {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return notFound();
    const file = resolveBundlePath(root, url.pathname);
    if (!file) return notFound();
    const mime = MIME[extensionOf(file)];
    if (!mime) return notFound();
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      return notFound();
    }
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Security-Policy': PROD_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    });
  });
}
