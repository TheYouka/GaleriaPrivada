// Foco de la rejilla de la galería (docs/DESIGN.md §14.6): una sola parada de Tab (roving tabindex).
// Los diálogos de renombrar y eliminar y el menú contextual devuelven el foco a esa celda.

/** Selector de la celda que tiene el tabindex 0 de la rejilla. */
export const GALLERY_TAB_STOP = '[data-gallery-grid] [role="gridcell"][tabindex="0"]';

/** Enfoca la celda activa de la rejilla; false si no hay rejilla (vacía o en otra pantalla). */
export function focusGalleryCell(): boolean {
  const cell = document.querySelector<HTMLElement>(GALLERY_TAB_STOP);
  if (!cell) return false;
  cell.focus({ preventScroll: true });
  return true;
}
