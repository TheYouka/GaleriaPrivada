// Content Security Policy exacta (docs/DESIGN.md §5.3).
// Producción: cabecera HTTP en las respuestas de app://bundle (protocol/app-protocol.ts).
// Desarrollo: se inyecta con webRequest.onHeadersReceived solo en las respuestas del origen de Vite.
// Este es el único archivo con onHeadersReceived (una sesión admite un solo listener por evento).
import type { Session } from 'electron';

const tail =
  "worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; manifest-src 'none'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const PROD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' vault:; media-src vault:; font-src 'self'; connect-src 'self'; " +
  tail;

/** El ws:// de HMR sale del host y el puerto de ELECTRON_RENDERER_URL, no de un literal. */
export function buildDevCsp(devUrl: string): string {
  const { host } = new URL(devUrl);
  return (
    "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    `img-src 'self' vault:; media-src vault:; font-src 'self'; connect-src 'self' ws://${host}; ` +
    tail
  );
}

export function installDevCsp(ses: Session, devUrl: string): void {
  const origin = new URL(devUrl).origin;
  const csp = buildDevCsp(devUrl);
  ses.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
    if (new URL(details.url).origin !== origin) {
      callback({});
      return;
    }
    const responseHeaders: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
      if (name.toLowerCase() !== 'content-security-policy') responseHeaders[name] = value;
    }
    responseHeaders['Content-Security-Policy'] = [csp];
    callback({ responseHeaders });
  });
}
