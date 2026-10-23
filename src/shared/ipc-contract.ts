// Contrato IPC (docs/DESIGN.md §10.2). [H3-2] Solo tipos y arrays `as const`: este archivo lo
// empaquetan el preload y el renderer, así que no importa ningún paquete de `dependencies`.
// Los esquemas zod viven en src/main/ipc/schemas.ts.
//
// Invariante de §22: ninguna respuesta ni ningún evento lleva bytes (Buffer/Uint8Array), así que el
// renderer nunca recibe claves. Lo comprueba tests/unit/shared/ipc-contract.test.ts.
import type { Result } from './errors';
import type {
  AppInfo,
  AvatarInput,
  GlobalSettings,
  Id,
  LockReason,
  ProfilePrefs,
  ProfileSummary,
  SessionState,
  ThemeId,
  WindowState,
} from './types';

/**
 * Allowlist genérica del preload (§5.6). `import:paths` (F2) NO está aquí a propósito: solo se
 * invoca desde `importDropped`, así que el renderer no puede inventar rutas para borrar.
 */
export const INVOKE_CHANNELS = [
  'app:getInfo',
  'window:minimize',
  'window:toggleMaximize',
  'window:close',
  'window:setFullScreen',
  'window:getState',
  'settings:get',
  'settings:set',
  'profiles:list',
  'profiles:pickAvatarPhoto',
  'profiles:create',
  'profiles:update',
  'profiles:changePassword',
  'profiles:delete',
  'session:unlock',
  'session:lock',
  'session:getState',
  'session:activity',
  'session:setPlayback',
  'prefs:get',
  'prefs:set',
] as const;

export const EVENT_CHANNELS = ['session:locking', 'session:locked', 'window:state'] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export type EventChannel = (typeof EVENT_CHANNELS)[number];

/** Petición y respuesta de cada canal. Los canales "U" de §10.2 los marca main al registrarlos. */
interface InvokeMap {
  'app:getInfo': { req: undefined; res: AppInfo };

  'window:minimize': { req: undefined; res: void };
  'window:toggleMaximize': { req: undefined; res: void };
  'window:close': { req: undefined; res: void };
  'window:setFullScreen': { req: { on: boolean }; res: void };
  'window:getState': { req: undefined; res: WindowState };

  'settings:get': { req: undefined; res: GlobalSettings };
  'settings:set': { req: Partial<GlobalSettings>; res: GlobalSettings };

  'profiles:list': { req: undefined; res: ProfileSummary[] };
  /** Diálogo nativo; null si se cancela. Errores UNSUPPORTED_FORMAT, TOO_LARGE, IO (§14.4). */
  'profiles:pickAvatarPhoto': { req: undefined; res: { token: string } | null };
  'profiles:create': {
    req: { name: string; avatar: AvatarInput; password: Uint8Array; acknowledgeNoRecovery: true };
    res: ProfileSummary;
  };
  /** Editar exige la contraseña (D14). */
  'profiles:update': {
    req: { profileId: Id; password: Uint8Array; name?: string; avatar?: AvatarInput };
    res: ProfileSummary;
  };
  'profiles:changePassword': {
    req: { profileId: Id; currentPassword: Uint8Array; newPassword: Uint8Array };
    res: void;
  };
  /**
   * Borrar exige siempre la contraseña (anexo §1). [H3-8] `leftoverPath` es la ruta de los restos
   * que `removeVaultDir` no pudo borrar (archivos ajenos dentro de la bóveda), o null.
   */
  'profiles:delete': {
    req: { profileId: Id; password: Uint8Array; confirmName: string };
    res: { leftoverPath: string | null };
  };

  /** [H3-8] Con la bóveda ausente, VAULT_UNAVAILABLE con details.path = la ruta configurada. */
  'session:unlock': {
    req: { profileId: Id; password: Uint8Array };
    res: { profile: ProfileSummary; prefs: ProfilePrefs };
  };
  'session:lock': { req: undefined; res: void };
  'session:getState': { req: undefined; res: SessionState };
  /** U. El renderer lo envía como mucho una vez cada 10 s. */
  'session:activity': { req: undefined; res: void };
  /** U. */
  'session:setPlayback': { req: { active: boolean }; res: void };

  /** U. */
  'prefs:get': { req: undefined; res: ProfilePrefs };
  /** U. */
  'prefs:set': { req: Partial<ProfilePrefs>; res: ProfilePrefs };
}

/** Payload de cada evento (main → renderer, solo a la ventana actual). */
interface EventMap {
  /** Primer paso del bloqueo (§13.3): el renderer pinta el velo opaco al recibirlo. */
  'session:locking': { reason: LockReason };
  /** A la ventana que se va a sustituir, justo antes de crear la nueva (§13.3). */
  'session:locked': { reason: LockReason };
  'window:state': WindowState;
}

// Comprobación en compilación: los mapas no tienen claves fuera de sus allowlists (y ReqOf/PayloadOf
// fallan si falta alguna).
type NoExtraKeys<M, K> = [Exclude<keyof M, K>] extends [never] ? true : false;
type IsTrue<T extends true> = T;
export type ContractKeysMatch = IsTrue<
  [NoExtraKeys<InvokeMap, InvokeChannel>, NoExtraKeys<EventMap, EventChannel>] extends [true, true]
    ? true
    : false
>;

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
