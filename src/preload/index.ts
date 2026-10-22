// Preload con sandbox (docs/DESIGN.md §3 y §10.2). Expone window.galeria con contextBridge.
// [H3-2] Solo importa `electron` y `@shared/*` (que se empaqueta aquí: externalizeDeps: false).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Result } from '@shared/errors';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  type GaleriaApi,
  type PayloadOf,
} from '@shared/ipc-contract';
import type { Id, ThemeId } from '@shared/types';

const invokeAllowlist: ReadonlySet<string> = new Set(INVOKE_CHANNELS);
const eventAllowlist: ReadonlySet<string> = new Set(EVENT_CHANNELS);

// F1 mueve el catálogo a src/shared/themes.ts.
const THEME_IDS: readonly ThemeId[] = ['fotos', 'xbox', 'ps3', 'macos', 'album'];

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function readInitialTheme(): GaleriaApi['initialTheme'] {
  const theme = readArg('galeria-theme');
  const scheme = readArg('galeria-scheme');
  return Object.freeze({
    themeId: THEME_IDS.find((t) => t === theme) ?? 'fotos',
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
  // P14: stub hasta la Fase 2.
  importDropped(): Promise<Result<{ jobId: Id }>> {
    return Promise.resolve({
      ok: false,
      error: { code: 'INTERNAL', details: { reason: 'not-implemented' } },
    });
  },
  initialTheme: readInitialTheme(),
};

contextBridge.exposeInMainWorld('galeria', api);
