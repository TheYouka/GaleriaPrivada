// Arranque del proceso main en el orden exacto de docs/DESIGN.md §5.2 (pasos 1–7, todo antes de
// `ready`), y después de `ready` el proxy y el resolver de la app [H3-5], los guards de sesión,
// los protocolos app:// y vault://, la limpieza de arranque, la sesión, el IPC y la ventana.
import { join } from 'node:path';
import { app, dialog, Menu, nativeTheme, powerMonitor, session } from 'electron';
import { initAppPaths } from './app-paths';
import { KV_DEFAULT_TRACKS, kvSet } from './db/repos/kv-repo';
import { registerAppHandlers } from './ipc/handlers/app';
import { registerProfileHandlers } from './ipc/handlers/profiles';
import { registerSessionHandlers } from './ipc/handlers/session';
import { registerSettingsHandlers } from './ipc/handlers/settings';
import { registerWindowHandlers } from './ipc/handlers/window';
import { setSessionGate } from './ipc/register';
import { initLog, log } from './log';
import { avatarFilePath, AvatarTokens } from './profiles/avatars';
import { ProfileService } from './profiles/profile-service';
import { ProfileStore } from './profiles/profile-store';
import { registerAppProtocol } from './protocol/app-protocol';
import { registerSchemesAsPrivileged } from './protocol/schemes';
import { registerVaultProtocol } from './protocol/vault-protocol';
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
  setInitialThemeProvider,
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
      const sessionManager = new SessionManager({
        loadProfile: (id) => {
          if (!profiles) throw new Error('profiles not ready');
          return profiles.unlockTarget(id);
        },
        readPrefs: (id) => prefs.get(id),
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
      });
      profiles = new ProfileService({
        dataRoot,
        store: new ProfileStore(dataRoot),
        prefs,
        tokens,
        session: sessionManager,
        isPackaged: app.isPackaged,
      });
      await profiles.startupCleanup();

      // IPC y vault:// (solo avatares en F1).
      setInitialThemeProvider(() =>
        computeInitialTheme(settings.get(), nativeTheme.shouldUseDarkColors),
      );
      setSessionGate(sessionManager);
      registerAppHandlers();
      registerWindowHandlers();
      registerSettingsHandlers({ settings, prefs, session: sessionManager });
      registerProfileHandlers({ profiles, tokens });
      registerSessionHandlers({ session: sessionManager });
      registerVaultProtocol(ses, {
        avatarFile: (id) => avatarFilePath(dataRoot, id),
        pendingAvatar: (token) => tokens.peek(token),
        rendererOrigin: getRendererOrigin,
        isUnlocked: () => sessionManager.isUnlocked,
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
        });
      }

      createMainWindow();
    })
    .catch(() => {
      // Falla cerrado: si algún guard no se instala, la app no arranca.
      app.exit(1);
    });
}
