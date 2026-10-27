// Textos y cuentas de Ajustes → Música (docs/DESIGN.md §14.9): el aviso fijo de que la copia va sin
// cifrar y el fragmento de la vista previa de cada pista.

/** Texto fijo del aviso (§14.9): la copia en music/ no está cifrada y el original no se borra. */
export const MUSIC_UNENCRYPTED_NOTICE =
  'La música se guarda sin cifrar. Importarla copia el archivo; el original no se borra.';

/** Duración del fragmento de la vista previa. */
export const PREVIEW_MS = 10_000;

/** Desde dónde suena el fragmento: hacia el 30 % de la pista, sin pasarse del final (segundos). */
export function previewStartSeconds(durationMs: number | null): number {
  if (durationMs === null || durationMs <= PREVIEW_MS) return 0;
  return Math.min(durationMs * 0.3, durationMs - PREVIEW_MS) / 1000;
}
