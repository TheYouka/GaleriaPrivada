// Arranque del proceso main en el orden exacto de docs/DESIGN.md §5.2 (pasos 1–7, todo antes de
// `ready`), y después de `ready` el proxy y el resolver de la app [H3-5], los guards de sesión,
// los protocolos app:// y vault://, la limpieza de arranque, la sesión, el IPC y la ventana.
import { join } from 'node:path';
import { app, dialog, Menu, nativeTheme, powerMonitor, powerSaveBlocker, session } from 'electron';
import { initAppPaths } from './app-paths';
import { KV_DEFAULT_TRACKS, kvSet } from './db/repos/kv-repo';
import { AppErrorException } from '@shared/errors';
import { FAULT_POINTS, ImportService, type FaultPoint } from './import/import-service';
import { registerAppHandlers } from './ipc/handlers/app';
import { registerEditsHandlers } from './ipc/handlers/edits';
import { importPathsFromTest, registerImportHandlers } from './ipc/handlers/import';
import { registerMediaHandlers } from './ipc/handlers/media';
import { registerMergeHandlers } from './ipc/handlers/merge';
import { registerMusicHandlers } from './ipc/handlers/music';
import { registerPlaylistHandlers } from './ipc/handlers/playlists';
import { registerPresentationHandlers } from './ipc/handlers/presentation';
import { MusicService } from './music/music-service';
import { registerVaultHandlers } from './ipc/handlers/vault';
import { LibraryEvents } from './ipc/library-events';
import { registerProfileHandlers } from './ipc/handlers/profiles';
import { registerSessionHandlers } from './ipc/handlers/session';
import { registerSettingsHandlers } from './ipc/handlers/settings';
import { registerWindowHandlers } from './ipc/handlers/window';
import { setSessionGate } from './ipc/register';
import { initLog, log } from './log';
import { Ffmpeg, resolveFfmpegPaths } from './media/ffmpeg';
import { MergeService } from './media/merge-service';
import { avatarFilePath, AvatarTokens } from './profiles/avatars';
import { ProfileService } from './profiles/profile-service';
import { ProfileStore, vaultDirOf } from './profiles/profile-store';
import { registerAppProtocol } from './protocol/app-protocol';
import { registerSchemesAsPrivileged } from './protocol/schemes';
import {
  registerVaultProtocol,
  sessionMusicSource,
  sessionObjectSource,
} from './protocol/vault-protocol';
import { installDevCsp } from './security/csp';
import { installWebContentsGuards } from './security/navigation-guard';
import {
  deadProxyConfig,
  getBlockedCounters,
  installSessionGuards,
  type SessionGuardOptions,
} from './security/network-guard';
import { installNodeEgressGuard } from './security/node-egress-guard';
import { forbiddenDebugSwitch } from './security/startup-checks';
import { installLockTriggers, SessionManager } from './session/session-manager';
import { cleanupTmpFiles, PrefsStore, SettingsStore } from './settings/settings-store';
import { InFlight } from './vault/in-flight';
import { Reconciler } from './vault/reconcile';
import { RelocateService } from './vault/relocate';
import {
  computeInitialTheme,
  createMainWindow,
  getDevUrl,
  getMainWindow,
  getRendererOrigin,
  hideMainWindow,
  replaceMainWindow,
  sendToMainWindow,
  setContentProtection,
  stealthWindows,
  setInitialThemeProvider,
  setPlaybackReleaser,
} from './window';

// 1. Red de Node bloqueada antes de cualquier otra cosa.
installNodeEgressGuard();

// 2. Empaquetado con switches de depuración → salir sin crear ninguna ventana (todavía no hay log).
if (forbiddenDebugSwitch(app.isPackaged, (s) => app.commandLine.hasSwitch(s))) {
  app.exit(1);
} else {
  start();
}

/**
 * Ganchos de E2E (§23.2), solo sin empaquetar y con GALERIA_E2E=1: nunca en un build empaquetado.
 * GALERIA_TEST_AUTOLOCK_MS (entero de 100 ms a 10 min) sustituye el tiempo del auto-bloqueo.
 */
function testAutoLockMs(testHooks: boolean): number | undefined {
  if (!testHooks) return undefined;
  const raw = process.env.GALERIA_TEST_AUTOLOCK_MS;
  if (!raw || !/^\d{3,6}$/.test(raw)) return undefined;
  const ms = Number(raw);
  return ms >= 100 && ms <= 600_000 ? ms : undefined;
}

/**
 * Raíces que la importación nunca toca (§12.3 punto 2, [H3-3]): GaleriaData y la bóveda de cada
 * perfil (y su pendingCleanup). Con profiles.json ilegible, al menos GaleriaData (la bóveda de la
 * sesión la añade siempre el servicio).
 */
async function protectedRoots(dataRoot: string, store: ProfileStore): Promise<string[]> {
  const roots = [dataRoot];
  try {
    for (const p of (await store.read()).profiles) {
      roots.push(vaultDirOf(dataRoot, p));
      if (p.vault.pendingCleanup) roots.push(p.vault.pendingCleanup);
    }
  } catch {
    // VAULT_CORRUPT: se protege lo que se puede
  }
  return roots;
}

function start(): void {
  // 3. userData ASCII (y raíz de datos) antes del lock de instancia única.
  const paths = initAppPaths();

  // 4. Instancia única: la segunda sale y la primera se enfoca.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  // Log (§21.2): solo la instancia que tiene el lock escribe en GaleriaData/logs.
  initLog({
    dir: join(paths.dataRoot, 'logs'),
    isPackaged: app.isPackaged,
    console: !app.isPackaged,
  });
  log.info('app.start');
  // §8.1: "override activo", sin la ruta.
  if (paths.overridden) log.info('paths.override-active');
  if (paths.overrideIgnored) log.warn('paths.override-ignored');

  app.on('second-instance', () => {
    const win = getMainWindow();
    if (!win) return;
    if (stealthWindows()) return; // modo discreto de los tests: nunca se roba el foco
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  // 5. Sandbox en todos los renderers.
  app.enableSandbox();

  // 6. app:// y vault://.
  registerSchemesAsPrivileged();

  // 7. Switches de Chromium. Solo en desarrollo se excluye el host del servidor de Vite (127.0.0.1);
  //    en producción no hay excepción.
  const devUrl = getDevUrl();
  app.commandLine.appendSwitch(
    'host-resolver-rules',
    devUrl ? `MAP * ~NOTFOUND, EXCLUDE ${new URL(devUrl).hostname}` : 'MAP * ~NOTFOUND',
  );
  if (process.platform === 'linux') app.commandLine.appendSwitch('password-store', 'basic');

  const guardOptions: SessionGuardOptions = { devUrl };
  app.on('session-created', (ses) => {
    void installSessionGuards(ses, guardOptions);
  });
  app.on('web-contents-created', (_event, contents) => {
    installWebContentsGuards(contents, getRendererOrigin());
  });
  app.on('window-all-closed', () => app.quit());
  // Nunca crashReporter.start() ni autoUpdater.

  const testHooks = !app.isPackaged && process.env.GALERIA_E2E === '1';

  app
    .whenReady()
    .then(async () => {
      // [H3-5] Peticiones sin sesión (net en utility process, peticiones internas del runtime).
      await app.setProxy(deadProxyConfig(devUrl));
      app.configureHostResolver({ secureDnsMode: 'off' });

      await installSessionGuards(session.defaultSession, guardOptions);
      const ses = session.fromPartition('galeria');
      await installSessionGuards(ses, guardOptions);
      if (devUrl) installDevCsp(ses, devUrl);

      Menu.setApplicationMenu(null);
      registerAppProtocol(ses);

      // Almacenes en claro y limpieza de arranque (§8.8, §14.4), antes de mostrar el selector.
      const dataRoot = paths.dataRoot;
      cleanupTmpFiles(dataRoot);
      const settings = new SettingsStore(dataRoot);
      await settings.load();
      const prefs = new PrefsStore(dataRoot);
      const tokens = new AvatarTokens();

      // Sesión y perfiles. GALERIA_TEST_FAST_KDF solo se respeta sin empaquetar (kdf.ts).
      let profiles: ProfileService | null = null;
      // Reconciliación (§12.6): se crea más abajo, con inFlight, ffmpeg y los eventos.
      let reconciler: Reconciler | null = null;
      // Reproducción activa (3.6): impide que la pantalla se apague mientras suena un vídeo.
      let displayBlockerId: number | null = null;
      const sessionManager = new SessionManager({
        loadProfile: (id) => {
          if (!profiles) throw new Error('profiles not ready');
          return profiles.unlockTarget(id);
        },
        readPrefs: (id) => prefs.get(id),
        reconcile: async (ctx) => {
          if (!reconciler) throw new Error('reconciler not ready');
          await reconciler.run(ctx);
        },
        ui: {
          sendLocking: (reason) => sendToMainWindow('session:locking', { reason }),
          hide: hideMainWindow,
          sendLocked: (reason) => sendToMainWindow('session:locked', { reason }),
          replaceWindow: () => {
            replaceMainWindow();
          },
          setContentProtection,
        },
        testAutoLockMs: testAutoLockMs(testHooks),
        exposeTestHooks: testHooks,
        setDisplaySleepBlocked: (on) => {
          if (on && displayBlockerId === null) {
            displayBlockerId = powerSaveBlocker.start('prevent-display-sleep');
          } else if (!on && displayBlockerId !== null) {
            powerSaveBlocker.stop(displayBlockerId);
            displayBlockerId = null;
          }
        },
      });
      const profileStore = new ProfileStore(dataRoot);
      profiles = new ProfileService({
        dataRoot,
        store: profileStore,
        prefs,
        tokens,
        session: sessionManager,
        isPackaged: app.isPackaged,
      });
      await profiles.startupCleanup();

      // ffmpeg/ffprobe (§19.4): disponibilidad con fs.access y, en segundo plano, el conjunto de
      // decodificadores de vídeo [H3-11].
      const ffmpeg = new Ffmpeg(
        resolveFfmpegPaths({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath(),
        }),
      );
      await ffmpeg.checkAvailable();
      void ffmpeg.loadDecoders();

      // IPC y vault://.
      setInitialThemeProvider(() =>
        computeInitialTheme(settings.get(), nativeTheme.shouldUseDarkColors),
      );
      setSessionGate(sessionManager);
      // Si el renderer cae o recarga con un vídeo sonando, nadie más retira 'playback' (3.6).
      setPlaybackReleaser(() => sessionManager.setPlayback(false));
      registerAppHandlers({ ffmpegAvailable: () => ffmpeg.available });
      registerWindowHandlers();
      registerSettingsHandlers({ settings, prefs, session: sessionManager });
      registerProfileHandlers({ profiles, tokens });
      registerSessionHandlers({ session: sessionManager });
      const libraryEvents = new LibraryEvents((payload) =>
        sendToMainWindow('library:changed', payload),
      );
      registerMediaHandlers({ session: sessionManager, events: libraryEvents });

      // Importación (§12): un único inFlight por proceso (lo comparte la reconciliación, §12.6).
      const inFlight = new InFlight();
      // Edición no destructiva (§16.5): miniatura nueva por objeto nuevo, con el mismo inFlight.
      registerEditsHandlers({ session: sessionManager, inFlight, library: libraryEvents });
      // Playlists, música y ajustes de la presentación (F4): todo en la DB cifrada salvo los
      // archivos de música (en claro, con nombre neutro) y la parte en claro de prefs.
      registerPlaylistHandlers({ session: sessionManager, library: libraryEvents });
      registerPresentationHandlers({ session: sessionManager, prefs });

      // Traslado de la bóveda y disco ausente (§8.7) y reconciliación al desbloquear (§12.6).
      const relocate: RelocateService = new RelocateService({
        dataRoot,
        session: sessionManager,
        profiles,
        events: {
          progress: (p) => sendToMainWindow('relocate:progress', p),
          done: (d) => sendToMainWindow('relocate:done', d),
        },
        background: {
          pauseBackground: () => reconciler?.pauseBackground() ?? Promise.resolve(),
          resumeBackground: () => reconciler?.resumeBackground(),
        },
      });
      reconciler = new Reconciler({
        session: sessionManager,
        inFlight,
        ffmpeg,
        library: libraryEvents,
        pendingCleanup: (id) => relocate.runPendingCleanup(id),
      });
      registerVaultHandlers({
        relocate,
        showOpenDialog: (options) => {
          const win = getMainWindow();
          return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
        },
      });
      // pendingCleanup también se reintenta al arrancar (§8.7, paso 8), en segundo plano.
      void profileStore
        .read()
        .then((file) => {
          for (const p of file.profiles) {
            if (p.vault.pendingCleanup) void relocate.runPendingCleanup(p.id);
          }
        })
        .catch(() => undefined);
      let importFault: FaultPoint | null = null;
      const importService = new ImportService({
        session: sessionManager,
        ffmpeg,
        events: {
          progress: (p) => sendToMainWindow('import:progress', p),
          done: (r) => sendToMainWindow('import:done', r),
          confirmNeeded: (c) => sendToMainWindow('import:confirmNeeded', c),
        },
        library: libraryEvents,
        inFlight,
        protectedRoots: () => protectedRoots(dataRoot, profileStore),
        // Gancho de E2E (nota 108): fallo inyectado en el paso elegido de cada archivo.
        faults: testHooks
          ? (point) => {
              if (point === importFault) {
                throw new AppErrorException({ code: 'IO', details: { reason: 'test-fault' } });
              }
            }
          : undefined,
      });
      const importHandlers = registerImportHandlers({
        service: importService,
        showOpenDialog: (options) => {
          const win = getMainWindow();
          return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
        },
      });
      // Fusión de vídeos (§18): entradas por loopback, salida por pipe:1 al cifrador.
      registerMergeHandlers({
        service: new MergeService({
          session: sessionManager,
          ffmpeg,
          events: {
            progress: (p) => sendToMainWindow('merge:progress', p),
            done: (d) => sendToMainWindow('merge:done', d),
          },
          library: libraryEvents,
          inFlight,
        }),
      });
      registerMusicHandlers({
        service: new MusicService({ session: sessionManager, ffmpeg, inFlight }),
        session: sessionManager,
        showOpenDialog: (options) => {
          const win = getMainWindow();
          return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
        },
      });
      registerVaultProtocol(ses, {
        avatarFile: (id) => avatarFilePath(dataRoot, id),
        pendingAvatar: (token) => tokens.peek(token),
        rendererOrigin: getRendererOrigin,
        isUnlocked: () => sessionManager.isUnlocked,
        inMaintenance: () => sessionManager.inMaintenance,
        objects: sessionObjectSource(sessionManager),
        music: sessionMusicSource(sessionManager),
      });
      installLockTriggers(sessionManager, { app, powerMonitor, dialog });

      if (testHooks) {
        Object.assign(globalThis, {
          __galeriaNetBlocked: getBlockedCounters(),
          // Marcador de §22 para el E2E de disco: solo ESCRIBE dos ids en la tabla kv cifrada de la
          // sesión abierta (LOCKED si no la hay). No devuelve ni lee nada de la bóveda.
          __galeriaTestWriteMarker: (ids: string[]): void => {
            kvSet(sessionManager.getDb(sessionManager.epoch), KV_DEFAULT_TRACKS, ids);
          },
          // Importación (nota 108): solo cambian el comportamiento de main, no leen la bóveda.
          // Fallo inyectado al empezar el paso `point` de cada archivo (null = ninguno).
          __galeriaTestFailImportAt: (point: unknown): boolean => {
            if (point === null) importFault = null;
            else if ((FAULT_POINTS as readonly unknown[]).includes(point)) {
              importFault = point as FaultPoint;
            } else return false;
            return true;
          },
          // El mismo camino de main que un arrastre (import:paths), por si Playwright no puede
          // soltar archivos del SO: devuelve el Result de import:paths.
          __galeriaTestImportPaths: (paths: unknown) =>
            importPathsFromTest(importHandlers, sessionManager, { paths }),
        });
        // Motivos de pausa del auto-bloqueo ('playback', 'job', …) y si el bloqueador de suspensión de
        // pantalla está activo (3.7). Solo lectura y sin datos de la bóveda: nombres de motivos.
        Object.defineProperties(globalThis, {
          __galeriaAutoLockReasons: {
            configurable: true,
            get: (): string[] => sessionManager.autoLockPauseReasons,
          },
          __galeriaDisplaySleepBlocked: {
            configurable: true,
            get: (): boolean =>
              displayBlockerId !== null && powerSaveBlocker.isStarted(displayBlockerId),
          },
        });
      }

      createMainWindow();
    })
    .catch(() => {
      // Falla cerrado: si algún guard no se instala, la app no arranca.
      app.exit(1);
    });
}
