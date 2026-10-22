// Contrato IPC (docs/DESIGN.md §10.2). [H3-2] Solo tipos y arrays `as const`: este archivo lo
// empaquetan el preload y el renderer, así que no importa ningún paquete de `dependencies`.
// Los esquemas zod viven en src/main/ipc/schemas.ts.
import type { Result } from './errors';
import type { AppInfo, Id, ThemeId } from './types';

export const INVOKE_CHANNELS = ['app:getInfo'] as const;
export const EVENT_CHANNELS = [] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export type EventChannel = (typeof EVENT_CHANNELS)[number];

interface InvokeMap {
  'app:getInfo': { req: undefined; res: AppInfo };
}

type EventMap = { [E in EventChannel]: never };

export type ReqOf<C extends InvokeChannel> = InvokeMap[C]['req'];
export type ResOf<C extends InvokeChannel> = InvokeMap[C]['res'];
export type PayloadOf<E extends EventChannel> = EventMap[E];

/** Argumentos de invoke después del canal: se puede omitir la petición si es `undefined`. */
export type InvokeArgs<C extends InvokeChannel> =
  ReqOf<C> extends undefined ? [req?: undefined] : [req: ReqOf<C>];

export interface GaleriaApi {
  /** Rechaza los canales fuera de la allowlist sin llegar a main. */
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<Result<ResOf<C>>>;
  /** Devuelve la función para darse de baja. */
  on<E extends EventChannel>(event: E, cb: (payload: PayloadOf<E>) => void): () => void;
  /** Fase 0: stub (P14). La Fase 2 resuelve las rutas con webUtils.getPathForFile e invoca import:paths. */
  importDropped(files: File[]): Promise<Result<{ jobId: Id }>>;
  /** Leído de process.argv (--galeria-theme, --galeria-scheme). */
  readonly initialTheme: { themeId: ThemeId; scheme: 'light' | 'dark' };
}
