// Velo opaco del bloqueo (docs/DESIGN.md §13.3, paso 1): al recibir session:locking, el renderer
// tapa al momento todo el contenido con el color de fondo del tema, sin animación y sin esperar a
// React, y deja la página inerte. La ventana se sustituye por otra nueva en el paso 5.
import { on } from './ipc';

export const VEIL_ID = 'galeria-veil';

export function showVeil(): void {
  if (document.getElementById(VEIL_ID)) return;
  const veil = document.createElement('div');
  veil.id = VEIL_ID;
  veil.className = 'galeria-veil';
  veil.setAttribute('aria-hidden', 'true');
  for (const el of Array.from(document.body.children)) el.setAttribute('inert', '');
  document.body.appendChild(veil);
}

export function installLockVeil(): () => void {
  return on('session:locking', () => showVeil());
}
