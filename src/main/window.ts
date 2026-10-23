// BrowserWindow endurecida (docs/DESIGN.md §5.2), sin marco desde F1 (§15.6: barra de título propia
// por tema). Una sola referencia a la ventana: getMainWindow() devuelve siempre la actual, que
// cambia al bloquear (replaceMainWindow, §13.3); el IPC (§5.6), los eventos y los diálogos la usan.
//
// additionalArguments se calculan cada vez que se crea una ventana con el tema y el esquema globales
// de settings.json en ese momento (§15.4), así el selector aparece con el tema vigente tras bloquear.
import { join } from 'node:path';
import { app, BrowserWindow, type Rectangle } from 'electron';
import type { EventChannel, PayloadOf } from '@shared/ipc-contract';
import {
  DEFAULT_THEME_ID,
  getThemeEntry,
  resolveScheme,
  type ColorScheme,
  type ThemeId,
} from '@shared/themes';
import type { GlobalSettings, WindowState } from '@shared/types';
import { log } from './log';
import { originOf } from './security/navigation-guard';

export const APP_ORIGIN = 'app://bundle';
const APP_ENTRY = `${APP_ORIGIN}/index.html`;
/** Paso 5 de la sustitución: si la nueva no llega a ready-to-show, se muestra igualmente. */
export const REPLACE_TIMEOUT_MS = 10_000;

export interface InitialTheme {
  themeId: ThemeId;
  scheme: ColorScheme;
}

/**
 * Tema y esquema de una ventana nueva (§15.4): el tema global (si no está implementado en esta
 * versión, el predeterminado) y el esquema con `system` resuelto; si el tema no admite el esquema,
 * el primero de los suyos.
 */
export function computeInitialTheme(settings: GlobalSettings, prefersDark: boolean): InitialTheme {
  const themeId = getThemeEntry(settings.pickerThemeId).available
    ? settings.pickerThemeId
    : DEFAULT_THEME_ID;
  const wanted: ColorScheme =
    settings.colorScheme === 'system' ? (prefersDark ? 'dark' : 'light') : settings.colorScheme;
  return { themeId, scheme: resolveScheme(themeId, wanted) };
}

let mainWindow: BrowserWindow | null = null;
let initialThemeProvider: () => InitialTheme = () => ({
  themeId: DEFAULT_THEME_ID,
  scheme: 'dark',
});

/** index.ts lo conecta a settings.json (tema global y esquema con `system` resuelto). */
export function setInitialThemeProvider(provider: () => InitialTheme): void {
  initialThemeProvider = provider;
}

/** Servidor de Vite (solo sin empaquetar y con ELECTRON_RENDERER_URL). */
export function getDevUrl(): string | undefined {
  return !app.isPackaged ? process.env.ELECTRON_RENDERER_URL || undefined : undefined;
}

export function getRendererOrigin(): string {
  const devUrl = getDevUrl();
  return devUrl ? originOf(devUrl) : APP_ORIGIN;
}

/** La ventana actual (cambia al bloquear, §13.3). */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

export function getWindowState(win: BrowserWindow | null = getMainWindow()): WindowState {
  if (!win) {
    return {
      maximized: false,
      minimized: false,
      fullscreen: false,
      focused: false,
      visible: false,
    };
  }
  return {
    maximized: win.isMaximized(),
    minimized: win.isMinimized(),
    fullscreen: win.isFullScreen(),
    focused: win.isFocused(),
    visible: win.isVisible(),
  };
}

/** Envía un evento solo a la ventana actual (§10.2). */
export function sendToMainWindow<E extends EventChannel>(event: E, payload: PayloadOf<E>): void {
  const win = getMainWindow();
  if (!win || win.webContents.isDestroyed()) return;
  win.webContents.send(event, payload);
}

function attachStateEvents(win: BrowserWindow): void {
  const emit = (): void => {
    if (mainWindow !== win || win.isDestroyed()) return;
    win.webContents.send('window:state', getWindowState(win));
  };
  for (const name of [
    'maximize',
    'unmaximize',
    'minimize',
    'restore',
    'enter-full-screen',
    'leave-full-screen',
    'focus',
    'blur',
    'show',
    'hide',
  ] as const) {
    win.on(name as 'show', emit);
  }
}

function buildWindow(bounds?: Partial<Rectangle>): BrowserWindow {
  const { themeId, scheme } = initialThemeProvider();
  const win = new BrowserWindow({
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 800,
    ...(bounds?.x !== undefined && bounds?.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 960,
    minHeight: 600,
    show: false, // se muestra en 'ready-to-show' (evita destello blanco)
    backgroundColor: '#1b1b1f', // = token bg del tema fotos oscuro
    title: 'Galería',
    frame: false, // §15.6: barra de título propia por tema
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
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  attachStateEvents(win);
  return win;
}

export function createMainWindow(): BrowserWindow {
  const win = buildWindow();
  win.once('ready-to-show', () => win.show());
  mainWindow = win;
  void win.loadURL(getDevUrl() ?? APP_ENTRY);
  return win;
}

/**
 * Sustitución de la ventana al bloquear (§13.3, pasos 1–5): ventana nueva, con un proceso de
 * renderer nuevo, que nace sin protección de contenido y con el tema global actual. La antigua se
 * destruye (con su proceso, su heap, las imágenes decodificadas y los búferes de vídeo) cuando la
 * nueva está lista, o a los 10 s.
 */
export function replaceMainWindow(): BrowserWindow {
  const old = getMainWindow();
  // 1. Geometría y estado maximizado (la pantalla completa no se conserva).
  const bounds = old ? old.getNormalBounds() : undefined;
  const maximized = old ? old.isMaximized() : false;
  // 2. Ventana nueva con los mismos webPreferences y additionalArguments calculados ahora.
  const win = buildWindow(bounds);
  // 3. Desde ya, el IPC y los eventos solo aceptan y llegan a la nueva.
  mainWindow = win;
  let settled = false;
  const swap = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (!win.isDestroyed()) {
      if (maximized) win.maximize();
      win.show();
    }
    if (old && !old.isDestroyed()) old.destroy();
  };
  // 5. Si la nueva no llega a ready-to-show en 10 s, se destruye la antigua igualmente.
  const timer = setTimeout(() => {
    log.warn('window.replace-timeout');
    swap();
  }, REPLACE_TIMEOUT_MS);
  // 4. En ready-to-show: show() (y maximize) de la nueva y destroy() de la antigua.
  win.once('ready-to-show', swap);
  void win.loadURL(getDevUrl() ?? APP_ENTRY);
  return win;
}

/** D15 (§5.2): WDA_EXCLUDEFROMCAPTURE en Windows; sin efecto en Linux. */
export function setContentProtection(on: boolean): void {
  const win = getMainWindow();
  if (win) win.setContentProtection(on);
}

/** Paso 1 del bloqueo con suspend y os-lock: saca el contenido de la pantalla de forma síncrona. */
export function hideMainWindow(): void {
  getMainWindow()?.hide();
}
