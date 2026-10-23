// Guard de red por sesión (docs/DESIGN.md §5.4, puntos 1, 4, 5.3 y 6; P11).
// Este es el único archivo con webRequest.onBeforeRequest: en Electron, un segundo listener en la
// misma sesión sustituye al primero sin avisar.
import { app, type ProxyConfig, type Session } from 'electron';
import { log } from '../log';
import { originOf } from './navigation-guard';

export interface BlockedCounters {
  http: number;
  https: number;
  ws: number;
  wss: number;
  file: number;
  other: number;
}

const counters: BlockedCounters = { http: 0, https: 0, ws: 0, wss: 0, file: 0, other: 0 };

/** Contadores de peticiones canceladas por esquema (nunca se guarda la URL). */
export function getBlockedCounters(): BlockedCounters {
  return counters;
}

function countBlocked(scheme: string): void {
  const key: keyof BlockedCounters = Object.hasOwn(counters, scheme)
    ? (scheme as keyof BlockedCounters)
    : 'other';
  counters[key] += 1;
  log.warn('net.blocked', { scheme: key }); // el esquema, nunca la URL (§5.4)
}

/**
 * Proxy inexistente: el puerto 9 ("discard") no escucha. Sin servidor de desarrollo, `<-loopback>`
 * quita la excepción implícita de loopback, así que ni siquiera 127.0.0.1 va directo.
 */
export function deadProxyConfig(devUrl: string | undefined): ProxyConfig {
  return {
    mode: 'fixed_servers',
    proxyRules: 'socks5://127.0.0.1:9',
    proxyBypassRules: devUrl ? '' : '<-loopback>',
  };
}

export interface SessionGuardOptions {
  /** ELECTRON_RENDERER_URL, solo sin empaquetar. */
  devUrl: string | undefined;
}

// Una promesa por sesión: installSessionGuards es idempotente y quien la llame otra vez espera
// a la misma instalación (session-created puede coincidir con la llamada explícita del arranque).
const installed = new WeakMap<Session, Promise<void>>();

export function installSessionGuards(ses: Session, options: SessionGuardOptions): Promise<void> {
  let pending = installed.get(ses);
  if (!pending) {
    pending = install(ses, options);
    installed.set(ses, pending);
  }
  return pending;
}

function install(ses: Session, { devUrl }: SessionGuardOptions): Promise<void> {
  const devOrigins = devUrl ? [originOf(devUrl), `ws://${new URL(devUrl).host}`] : [];

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !isAllowed(details.url, devOrigins) });
  });

  ses.on('will-download', (event) => {
    event.preventDefault();
    log.warn('download.blocked');
  });

  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === 'fullscreen');
  });
  ses.setPermissionCheckHandler((_contents, permission) => permission === 'fullscreen');
  ses.setDisplayMediaRequestHandler((_request, callback) => callback(null));

  // Con el corrector activo, Chromium descargaría diccionarios Hunspell en Linux.
  ses.setSpellCheckerEnabled(false);

  return ses.setProxy(deadProxyConfig(devUrl));
}

function isAllowed(rawUrl: string, devOrigins: string[]): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    countBlocked('other');
    return false;
  }
  const scheme = url.protocol.slice(0, -1);
  if (scheme === 'app' || scheme === 'vault') return true;
  if (scheme === 'devtools' && !app.isPackaged) return true;
  if (devOrigins.length > 0 && devOrigins.includes(originOf(url))) return true;
  countBlocked(scheme);
  return false;
}
