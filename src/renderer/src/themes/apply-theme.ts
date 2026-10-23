// Cambio de tema en vivo (docs/DESIGN.md §15.8): con movimiento reducido (o sin View Transitions)
// cambia al momento; si no, `document.startViewTransition(() => flushSync(...))` con un fundido de
// 200 ms (styles/base.css). Los stores no cambian, así que la pantalla y la selección se conservan;
// si el shell cambia y el elemento enfocado se vuelve a montar, el foco vuelve al de mismo id.
import { flushSync } from 'react-dom';
import { focusById } from '../lib/focus';
import { useThemeStore } from '../stores/theme-store';

export function applyTheme(update: () => void): void {
  const active = document.activeElement;
  const focusId = active instanceof HTMLElement && active.id ? active.id : null;
  const run = (): void => {
    flushSync(update);
    if (focusId) focusById(focusId);
  };
  const reduced = useThemeStore.getState().reducedMotion;
  if (reduced || document.hidden || typeof document.startViewTransition !== 'function') {
    run();
    return;
  }
  try {
    document.startViewTransition(run);
  } catch {
    run();
  }
}
