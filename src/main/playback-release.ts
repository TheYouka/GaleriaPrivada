// Suelta la reproducción activa (pausa 'playback' del auto-bloqueo y powerSaveBlocker, 3.6) cuando el
// renderer desaparece sin avisar: se cae (render-process-gone) o recarga/navega el frame principal
// (did-start-navigation). Normalmente lo retira el propio renderer al desmontar el reproductor.
export interface NavigationDetails {
  isMainFrame: boolean;
  isSameDocument: boolean;
}

/** Lo mínimo de `webContents` que usa esta función (así se prueba sin Electron). */
export interface PlaybackWebContents {
  on(event: 'render-process-gone', listener: () => void): unknown;
  on(event: 'did-start-navigation', listener: (details: NavigationDetails) => void): unknown;
}

export function attachPlaybackRelease(wc: PlaybackWebContents, release: () => void): void {
  wc.on('render-process-gone', () => release());
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) release();
  });
}
