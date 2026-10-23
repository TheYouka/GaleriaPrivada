// "Saltar al contenido" (§14.1): primer elemento de cada shell, visible solo con el foco. Mueve el
// foco al contenido principal sin cambiar la URL.
import type { MouseEvent } from 'react';
import { MAIN_CONTENT_ID } from '../themes/shells/nav-model';

export function SkipLink() {
  const skip = (e: MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault();
    document.getElementById(MAIN_CONTENT_ID)?.focus();
  };
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      onClick={skip}
      className="sr-only z-30 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
    >
      Saltar al contenido
    </a>
  );
}
