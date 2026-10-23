// Proveedor del tema (docs/DESIGN.md §15.4): instala la hoja de tokens antes del primer render, pone
// data-theme/data-scheme/data-reduced-motion en <html> y sigue al sistema (esquema y movimiento
// reducido) en vivo.
import { useEffect, useLayoutEffect, type ReactNode } from 'react';
import { useThemeStore } from '../stores/theme-store';
import { applyDocumentTheme, installThemeSheet } from './document-theme';
import { currentTheme, useTheme } from './use-theme';

// Antes del primer render: tokens y atributos correctos desde el primer fotograma (el preload ya puso
// los de --galeria-theme/--galeria-scheme; aquí se aplica además el fondo oscuro del selector).
installThemeSheet();
applyDocumentTheme(currentTheme(), useThemeStore.getState().reducedMotion);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const reducedMotion = useThemeStore((s) => s.reducedMotion);

  useLayoutEffect(() => {
    applyDocumentTheme(theme, reducedMotion);
  }, [theme, reducedMotion]);

  useEffect(() => {
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = (): void => {
      const store = useThemeStore.getState();
      store.setSystemDark(dark.matches);
      store.setReducedMotion(motion.matches);
    };
    dark.addEventListener('change', sync);
    motion.addEventListener('change', sync);
    sync();
    return () => {
      dark.removeEventListener('change', sync);
      motion.removeEventListener('change', sync);
    };
  }, []);

  return children;
}
