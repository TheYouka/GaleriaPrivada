// Validación del nombre de un medio al renombrar (docs/DESIGN.md §10.3 y §14.6): las mismas reglas
// que aplica main (NFC, trim, 1–255 caracteres, sin caracteres de control), para avisar antes de
// enviar. main sigue validando.
import { MEDIA_NAME_MAX } from '@shared/constants';

/** Mensaje de validación del nombre, o null si es válido. */
export function renameProblem(raw: string): string | null {
  const name = raw.normalize('NFC').trim();
  if (name.length === 0) return 'Escribe un nombre.';
  if ([...name].length > MEDIA_NAME_MAX) {
    return `El nombre admite como máximo ${MEDIA_NAME_MAX} caracteres.`;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    return 'El nombre no puede tener caracteres de control.';
  }
  return null;
}
