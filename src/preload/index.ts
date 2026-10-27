// Preload con sandbox (docs/DESIGN.md §3 y §10.2). Expone window.galeria con contextBridge.
// [H3-2] Solo importa `electron` y `@shared/*` (que se empaqueta aquí: externalizeDeps: false).
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { Result } from '@shared/errors';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type GaleriaApi,
  type PayloadOf,
  type ReqOf,
} from '@shared/ipc-contract';
import { DEFAULT_THEME_ID, isThemeId } from '@shared/themes';
import type { Id } from '@shared/types';

const invokeAllowlist: ReadonlySet<string> = new Set(INVOKE_CHANNELS);
const eventAllowlist: ReadonlySet<string> = new Set(EVENT_CHANNELS);

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function readInitialTheme(): GaleriaApi['initialTheme'] {
  const theme = readArg('galeria-theme');
  const scheme = readArg('galeria-scheme');
  return Object.freeze({
    themeId: isThemeId(theme) ? theme : DEFAULT_THEME_ID,
    scheme: scheme === 'light' ? 'light' : 'dark',
  });
}

const api: GaleriaApi = {
  invoke(channel, ...args) {
    if (!invokeAllowlist.has(channel)) {
      return Promise.reject(new Error('IPC channel not allowed'));
    }
    return ipcRenderer.invoke(channel, args[0]);
  },
  on(event, cb) {
    if (!eventAllowlist.has(event)) throw new Error('IPC event not allowed');
    const listener = (_e: IpcRendererEvent, payload: PayloadOf<typeof event>): void => cb(payload);
    ipcRenderer.on(event, listener);
    return () => {
      ipcRenderer.removeListener(event, listener);
    };
  },
  // §12.2: las rutas salen de webUtils.getPathForFile, nunca del renderer. import:paths no está en
  // la allowlist genérica, así que esta es la única forma de invocarlo [H3-8].
  importDropped(files: File[]): Promise<Result<{ jobId: Id }>> {
    const validation = (reason: string): Promise<Result<{ jobId: Id }>> =>
      Promise.resolve({ ok: false, error: { code: 'VALIDATION', details: { reason } } });
    if (!Array.isArray(files)) return validation('not-files');
    const paths: string[] = [];
    for (const file of files) {
      if (!(file instanceof File)) return validation('not-files');
      // Vacía para un File creado en JS (no viene del disco): se descarta.
      const path = webUtils.getPathForFile(file);
      if (path) paths.push(path);
    }
    if (paths.length === 0) return validation('no-paths');
    const req: ReqOf<'import:paths'> = { paths };
    return ipcRenderer.invoke('import:paths', req) as Promise<Result<{ jobId: Id }>>;
  },
  initialTheme: readInitialTheme(),
  testHooks: readArg('galeria-test-hooks') === '1',
};

contextBridge.exposeInMainWorld('galeria', api);

// §15.4: data-theme y data-scheme en <html> desde el principio, para que no haya un destello con el
// tema equivocado. No pisa lo que ya haya puesto el renderer (ThemeProvider).
function applyInitialTheme(): void {
  const html = document.documentElement;
  if (!html) return;
  if (!html.dataset.theme) html.dataset.theme = api.initialTheme.themeId;
  if (!html.dataset.scheme) html.dataset.scheme = api.initialTheme.scheme;
}
applyInitialTheme();
document.addEventListener('DOMContentLoaded', applyInitialTheme, { once: true });
