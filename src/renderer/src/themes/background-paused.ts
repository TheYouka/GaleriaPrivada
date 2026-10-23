// Cuándo se pausa el fondo animado (docs/DESIGN.md §15.7). Puro, para probarlo sin DOM.

export interface BackgroundPauseInputs {
  documentHidden: boolean;
  minimized: boolean;
  visible: boolean;
  /** Presentación activa (F4). */
  presentationActive: boolean;
  /** Vídeo reproduciéndose en el visor o el vídeo dual (F3, F5). */
  videoPlaying: boolean;
}

export function isBackgroundPaused(s: BackgroundPauseInputs): boolean {
  return s.documentHidden || s.minimized || !s.visible || s.presentationActive || s.videoPlaying;
}
