// Guard por webContents (docs/DESIGN.md §5.4, puntos 3 y 5.2; P11): navegación, ventanas nuevas,
// <webview> y política de IP de WebRTC. Se aplica en app.on('web-contents-created').
import type { WebContents } from 'electron';

/**
 * Origen comparable `esquema://host[:puerto]`. No se usa `URL#origin` porque el URL de Node devuelve
 * "null" para esquemas no especiales como app:// (y también para about:blank), así que dos URLs
 * distintas acabarían comparando igual.
 */
export function originOf(url: string | URL): string {
  const u = typeof url === 'string' ? new URL(url) : url;
  return `${u.protocol}//${u.host}`;
}

function safeOriginOf(url: string): string | null {
  try {
    return originOf(url);
  } catch {
    return null;
  }
}

export function installWebContentsGuards(contents: WebContents, rendererOrigin: string): void {
  const denyForeign = (event: { url: string; preventDefault: () => void }): void => {
    if (safeOriginOf(event.url) !== rendererOrigin) event.preventDefault();
  };
  contents.on('will-navigate', (event) => denyForeign(event));
  contents.on('will-redirect', (event) => denyForeign(event));
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) event.preventDefault(); // los subframes nunca navegan
  });
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  // Sin UDP de WebRTC salvo por un proxy que lo admita; el TCP de ICE va al proxy muerto de la sesión.
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
}
