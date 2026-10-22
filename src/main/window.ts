// BrowserWindow endurecida (docs/DESIGN.md §5.2). Scaffold: frame: true (la barra de título propia
// llega en F1), sin setContentProtection ni replaceMainWindow (F1).
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { originOf } from './security/navigation-guard';

export const APP_ORIGIN = 'app://bundle';
const APP_ENTRY = `${APP_ORIGIN}/index.html`;

let mainWindow: BrowserWindow | null = null;

/** Servidor de Vite (solo sin empaquetar y con ELECTRON_RENDERER_URL). */
export function getDevUrl(): string | undefined {
  return !app.isPackaged ? process.env.ELECTRON_RENDERER_URL || undefined : undefined;
}

export function getRendererOrigin(): string {
  const devUrl = getDevUrl();
  return devUrl ? originOf(devUrl) : APP_ORIGIN;
}

/** La ventana actual (cambia al bloquear desde F1, 13.3). */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

export function createMainWindow(): BrowserWindow {
  const themeId = 'fotos';
  const scheme = 'dark';
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false, // se muestra en 'ready-to-show' (evita destello blanco)
    backgroundColor: '#1b1b1f', // = token bg del tema fotos oscuro
    title: 'Galería',
    frame: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      partition: 'galeria', // sin "persist:" → sesión en memoria: sin caché, cookies ni storage en disco
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false,
      devTools: !app.isPackaged,
      safeDialogs: true,
      autoplayPolicy: 'no-user-gesture-required', // la presentación encadena vídeos con sonido
      additionalArguments: [`--galeria-theme=${themeId}`, `--galeria-scheme=${scheme}`],
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  mainWindow = win;
  void win.loadURL(getDevUrl() ?? APP_ENTRY);
  return win;
}
