// Modelo de teclado de la presentación (docs/DESIGN.md §17.9). Puro: traduce una pulsación y el
// contexto en una orden; el componente la ejecuta. Lo prueba tests/unit/renderer/presentation-keys.test.ts.
//
// - Espacio: reproducir/pausar; ←/→: anterior/siguiente; F: pantalla completa; M: música sí/no.
// - Esc: cierra el panel de ajustes si está abierto y, si no, sale. Funciona siempre, también con el
//   foco en un campo de texto.
// - Intro: «Volver a empezar» en la capa final.
// - Las repeticiones de tecla (mantener pulsada) se ignoran: mantener → saltaría diapositivas sin
//   dejarles cargar.
// - Con Ctrl/Alt/Meta no se hace nada (no se roban atajos del sistema ni de la ventana).

export type PresentationCommand =
  | 'toggle-pause'
  | 'next'
  | 'prev'
  | 'toggle-fullscreen'
  | 'toggle-music'
  | 'close-settings'
  | 'exit'
  | 'restart';

export interface PresentationKey {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  repeat?: boolean;
}

/** Qué tiene el foco: un control que ya usa algunas teclas no debe disparar además la orden global. */
export type FocusKind =
  /** Nada especial (la capa de la presentación). */
  | 'none'
  /** Un botón: Espacio e Intro lo activan a él. */
  | 'button'
  /** Un campo de texto o selector: usa todo salvo Esc. */
  | 'text'
  /** Un deslizador: usa las flechas y Espacio. */
  | 'slider';

export interface PresentationKeyContext {
  settingsOpen: boolean;
  /** Se ve la capa «Fin de la presentación». */
  finished: boolean;
  focus: FocusKind;
}

export function presentationCommand(
  k: PresentationKey,
  ctx: PresentationKeyContext,
): PresentationCommand | null {
  if (k.ctrlKey || k.altKey || k.metaKey || k.repeat) return null;
  if (k.key === 'Escape') return ctx.settingsOpen ? 'close-settings' : 'exit';
  if (ctx.focus === 'text') return null;
  const letter = k.key.length === 1 ? k.key.toLowerCase() : k.key;
  if (letter === 'f') return 'toggle-fullscreen';
  if (letter === 'm') return 'toggle-music';
  if (k.key === 'Enter') {
    return ctx.finished && ctx.focus !== 'button' ? 'restart' : null;
  }
  if (ctx.finished) return null;
  if (k.key === ' ' || k.key === 'Spacebar') {
    return ctx.focus === 'button' || ctx.focus === 'slider' ? null : 'toggle-pause';
  }
  if (ctx.focus === 'slider') return null;
  if (k.key === 'ArrowRight') return 'next';
  if (k.key === 'ArrowLeft') return 'prev';
  return null;
}
