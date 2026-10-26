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
  EditOp,
  GlobalSettings,
  Id,
  ImportConfirmNeeded,
  ImportProgress,
  ImportReport,
  LibraryChanged,
  LockReason,
  MediaDetail,
  MediaListItem,
  MediaQuery,
  ProfilePrefs,
  ProfileSummary,
  RelocateDone,
  RelocateProgress,
  SessionState,
  ThemeId,
  VaultInfo,
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
  'media:list',
  'media:get',
  'media:rename',
  'media:delete',
  'import:chooseFiles',
  'import:chooseFolder',
  'import:confirm',
  'import:cancel',
  'vault:getInfo',
  'vault:relocate',
  'vault:relocateCancel',
  'vault:locate',
  'edits:save',
] as const;

/**
 * Canales que main registra pero que NO están en la allowlist genérica (§5.6, §12.2): el preload
 * los invoca solo desde funciones propias. `import:paths` solo sale de `importDropped`, que obtiene
 * las rutas con webUtils.getPathForFile; el renderer nunca construye ni envía rutas [H3-8].
 */
export const PRIVATE_INVOKE_CHANNELS = ['import:paths'] as const;

export const EVENT_CHANNELS = [
  'session:locking',
  'session:locked',
  'window:state',
  'library:changed',
  'import:progress',
  'import:done',
  'import:confirmNeeded',
  'relocate:progress',
  'relocate:done',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export type PrivateInvokeChannel = (typeof PRIVATE_INVOKE_CHANNELS)[number];
/** Todos los canales que registra main (los de la allowlist y los privados del preload). */
export type AnyInvokeChannel = InvokeChannel | PrivateInvokeChannel;
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

  /** U. La biblioteca entera de la consulta (R13), con el orden total de §9.2. */
  'media:list': { req: MediaQuery; res: { items: MediaListItem[] } };
  /** U. NOT_FOUND si no hay fila `ready`. */
  'media:get': { req: { id: Id }; res: MediaDetail };
  /** U. */
  'media:rename': { req: { id: Id; name: string }; res: MediaListItem };
  /** U. Borrado permanente (§12.10): fila, EXIF, ediciones, playlists y borrado criptográfico. */
  'media:delete': { req: { ids: Id[] }; res: { deleted: number } };

  /**
   * U. Diálogo nativo en main (§12.1); null si se cancela. BUSY sin abrir el diálogo si ya hay una
   * importación activa (§12.11). El progreso llega por import:progress e import:done.
   */
  'import:chooseFiles': { req: undefined; res: { jobId: Id } | null };
  /** U. Como import:chooseFiles, con una carpeta. */
  'import:chooseFolder': { req: undefined; res: { jobId: Id } | null };
  /** U. Solo vía importDropped (PRIVATE_INVOKE_CHANNELS). BUSY si ya hay una importación activa. */
  'import:paths': { req: { paths: string[] }; res: { jobId: Id } };
  /** U. Respuesta a import:confirmNeeded (§12.5.1). NOT_FOUND si no está en awaiting-confirmation. */
  'import:confirm': { req: { jobId: Id; convert: boolean }; res: void };
  /** U. Cancela la importación (§12.4, "Cancelar"). */
  'import:cancel': { req: { jobId: Id }; res: void };

  /** U. También durante el traslado (§5.6, punto 4). */
  'vault:getInfo': { req: undefined; res: VaultInfo };
  /**
   * U. Traslado de la bóveda (§8.7). [H3-8] El renderer nunca envía una ruta: 'choose' abre el
   * diálogo de carpeta en main y 'default' vuelve a GaleriaData/vaults/<id>. null si se cancela el
   * diálogo. BUSY sin abrir el diálogo si hay algún trabajo activo. El resto llega por
   * relocate:progress y relocate:done.
   */
  'vault:relocate': { req: { target: 'choose' | 'default' }; res: { jobId: Id } | null };
  /** U. Se ignora desde el paso 5 de §8.7. NOT_FOUND si no es el traslado en curso. */
  'vault:relocateCancel': { req: { jobId: Id }; res: void };
  /**
   * Con la bóveda bloqueada (disco ausente, §8.7): diálogo de carpeta en main; null si se cancela.
   * [H3-8] Si la carpeta elegida no es la bóveda del perfil, VAULT_UNAVAILABLE con details.path =
   * la ruta configurada (la que ya está en claro en profiles.json).
   */
  'vault:locate': { req: { profileId: Id }; res: ProfileSummary | null };

  /**
   * U. Edición no destructiva de una foto (§16.5): sustituye la lista completa de operaciones
   * (`[]` = revertir; ≤ 64, el editor colapsa antes a la forma canónica, §16.4) y regenera la
   * miniatura. Devuelve las operaciones guardadas y el `thumbRev` nuevo (vault://thumb/<id>?rev=).
   * Las operaciones actuales llegan en `media:get` (`MediaDetail.edits`; el EditState sale de
   * foldEdits, src/shared/edits.ts). VALIDATION con un vídeo; NOT_FOUND si no hay fila `ready`;
   * BUSY con otra edición del mismo medio o durante un traslado; INTEGRITY si el original no
   * descifra; INTERNAL si sharp falla; DISK_FULL; IO.
   */
  'edits:save': {
    req: { mediaId: Id; ops: EditOp[] };
    res: { edits: EditOp[]; thumbRev: number };
  };
}

/** Payload de cada evento (main → renderer, solo a la ventana actual). */
interface EventMap {
  /** Primer paso del bloqueo (§13.3): el renderer pinta el velo opaco al recibirlo. */
  'session:locking': { reason: LockReason };
  /** A la ventana que se va a sustituir, justo antes de crear la nueva (§13.3). */
  'session:locked': { reason: LockReason };
  'window:state': WindowState;
  /** Agrupado durante importaciones y fusiones (ipc/library-events.ts). */
  'library:changed': LibraryChanged;
  /** Agrupado como mucho cada 100 ms, salvo los cambios de fase (§12.11). */
  'import:progress': ImportProgress;
  'import:done': ImportReport;
  /** §12.5.1: vídeos que se recodificarían con pérdida (D8). */
  'import:confirmNeeded': ImportConfirmNeeded;
  /** Como mucho cada 250 ms (§8.7, paso 4). */
  'relocate:progress': RelocateProgress;
  /** No llega si un bloqueo interrumpe el traslado (la ventana se sustituye). */
  'relocate:done': RelocateDone;
}

// Comprobación en compilación: los mapas no tienen claves fuera de sus allowlists (y ReqOf/PayloadOf
// fallan si falta alguna).
type NoExtraKeys<M, K> = [Exclude<keyof M, K>] extends [never] ? true : false;
type IsTrue<T extends true> = T;
export type ContractKeysMatch = IsTrue<
  [NoExtraKeys<InvokeMap, AnyInvokeChannel>, NoExtraKeys<EventMap, EventChannel>] extends [
    true,
    true,
  ]
    ? true
    : false
>;

export type ReqOf<C extends AnyInvokeChannel> = InvokeMap[C]['req'];
export type ResOf<C extends AnyInvokeChannel> = InvokeMap[C]['res'];
export type PayloadOf<E extends EventChannel> = EventMap[E];

/** Argumentos de invoke después del canal: se puede omitir la petición si es `undefined`. */
export type InvokeArgs<C extends InvokeChannel> =
  ReqOf<C> extends undefined ? [req?: undefined] : [req: ReqOf<C>];

export interface GaleriaApi {
  /** Rechaza los canales fuera de la allowlist sin llegar a main. */
  invoke<C extends InvokeChannel>(channel: C, ...args: InvokeArgs<C>): Promise<Result<ResOf<C>>>;
  /** Devuelve la función para darse de baja. */
  on<E extends EventChannel>(event: E, cb: (payload: PayloadOf<E>) => void): () => void;
  /**
   * §12.2: cada elemento tiene que ser `instanceof File` (si no, VALIDATION); la ruta sale de
   * webUtils.getPathForFile (también para carpetas) y se descartan las vacías (File creados en JS).
   * Sin ninguna ruta, VALIDATION { reason: 'no-paths' }. Si no, invoca import:paths.
   */
  importDropped(files: File[]): Promise<Result<{ jobId: Id }>>;
  /** Leído de process.argv (--galeria-theme, --galeria-scheme). */
  readonly initialTheme: { themeId: ThemeId; scheme: 'light' | 'dark' };
}
