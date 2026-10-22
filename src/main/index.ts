// Arranque del proceso main en el orden exacto de docs/DESIGN.md §5.2 (pasos 1–7, todo antes de
// `ready`), y después de `ready` el proxy y el resolver de la app [H3-5], los guards de sesión,
// el protocolo app://, el IPC y la ventana.
import { app, Menu, session } from 'electron';
import { initAppPaths } from './app-paths';
import { registerAppHandlers } from './ipc/handlers/app';
import { registerAppProtocol } from './protocol/app-protocol';
import { registerSchemesAsPrivileged } from './protocol/schemes';
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
import { createMainWindow, getDevUrl, getMainWindow, getRendererOrigin } from './window';

// 1. Red de Node bloqueada antes de cualquier otra cosa.
installNodeEgressGuard();

// 2. Empaquetado con switches de depuración → salir sin crear ninguna ventana (todavía no hay log).
if (forbiddenDebugSwitch(app.isPackaged, (s) => app.commandLine.hasSwitch(s))) {
  app.exit(1);
} else {
  start();
}

function start(): void {
  // 3. userData ASCII (y raíz de datos) antes del lock de instancia única.
  initAppPaths();

  // 4. Instancia única: la segunda sale y la primera se enfoca.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
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
      registerAppHandlers();

      if (!app.isPackaged && process.env.GALERIA_E2E === '1') {
        Object.assign(globalThis, { __galeriaNetBlocked: getBlockedCounters() });
      }

      createMainWindow();
    })
    .catch(() => {
      // Falla cerrado: si algún guard no se instala, la app no arranca.
      app.exit(1);
    });
}
