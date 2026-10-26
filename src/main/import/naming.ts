// Nombre y extensión del medio importado (docs/DESIGN.md §12.4.1). Puro: a partir del nombre de
// archivo del original (sin la carpeta) y de la extensión canónica del formato detectado por firma.
//
// 1. Último punto: `stem` = lo anterior y `suffix` = lo posterior (sin punto, todo es `stem`).
// 2. `suffix` en minúsculas que cumple /^[a-z0-9]{1,16}$/ → `originalExt`; si no, `originalExt` =
//    la extensión detectada y el punto deja de ser separador (`stem` = el nombre entero).
// 3. `name` = NFC(stem) sin \p{Cc}, con trim y como mucho 255 code points (sin partir pares
//    sustitutos); vacío → "Sin nombre".
// 4. `name_fold` (búsqueda, §9.2) = NFC(toLowerCase(sin diacríticos(NFD(name)))).
import { MEDIA_NAME_MAX } from '@shared/constants';
import { foldName as foldProfileName } from '../profiles/profile-store';

export const UNNAMED = 'Sin nombre';

const EXT_PATTERN = /^[a-z0-9]{1,16}$/;
const CONTROL = /\p{Cc}/gu;

/** Limpia un nombre visible: NFC, sin controles, trim y ≤ 255 code points; vacío → "Sin nombre". */
export function cleanName(raw: string): string {
  const cleaned = raw.normalize('NFC').replace(CONTROL, '').trim();
  const cut = [...cleaned].slice(0, MEDIA_NAME_MAX).join('');
  return cut.length > 0 ? cut : UNNAMED;
}

export function deriveName(
  basename: string,
  detectedExt: string,
): { name: string; originalExt: string } {
  const dot = basename.lastIndexOf('.');
  let stem = dot === -1 ? basename : basename.slice(0, dot);
  const suffix = dot === -1 ? '' : basename.slice(dot + 1).toLowerCase();
  let originalExt: string;
  if (EXT_PATTERN.test(suffix)) {
    originalExt = suffix;
  } else {
    originalExt = detectedExt;
    stem = basename;
  }
  return { name: cleanName(stem), originalExt };
}

/** Pliegue de búsqueda (§9.2): el mismo que el de los nombres de perfil. */
export function foldName(name: string): string {
  return foldProfileName(name);
}
