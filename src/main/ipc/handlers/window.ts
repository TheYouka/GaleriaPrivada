// window:* (docs/DESIGN.md §10.2 y §15.6): los botones de la barra de título propia. Siempre sobre
// la ventana actual, sin "U".
import { getMainWindow, getWindowState } from '../../window';
import { handle } from '../register';

export function registerWindowHandlers(): void {
  handle('window:minimize', { requiresUnlock: false }, () => {
    getMainWindow()?.minimize();
  });
  handle('window:toggleMaximize', { requiresUnlock: false }, () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  // Con la única ventana cerrada, window-all-closed → app.quit() → before-quit bloquea (shutdown).
  handle('window:close', { requiresUnlock: false }, () => {
    getMainWindow()?.close();
  });
  handle('window:setFullScreen', { requiresUnlock: false }, ({ on }) => {
    getMainWindow()?.setFullScreen(on);
  });
  handle('window:getState', { requiresUnlock: false }, () => getWindowState());
}
