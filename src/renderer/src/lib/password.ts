// Reglas de la UI para nombres y contraseñas (docs/DESIGN.md §10.3), antes de enviar a main: así el
// usuario recibe el aviso al momento. main vuelve a validar lo mismo (solo bytes, en el caso de la
// contraseña). Las contraseñas nunca se recortan.
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_CODE_POINTS,
  PROFILE_NAME_MAX,
  PROFILE_NAME_MIN,
} from '@shared/constants';

export type PasswordIssue = 'short' | 'long';
export type NameIssue = 'empty' | 'long' | 'control';

export const PASSWORD_ISSUE_MESSAGES: Readonly<Record<PasswordIssue, string>> = {
  short: 'Mínimo 8 caracteres',
  long: 'Demasiado larga',
};

export const NAME_ISSUE_MESSAGES: Readonly<Record<NameIssue, string>> = {
  empty: 'Escribe un nombre',
  long: 'Máximo 40 caracteres',
  control: 'El nombre tiene caracteres no válidos',
};

/** Code points de NFC(texto). */
export function codePointLength(text: string): number {
  return [...text.normalize('NFC')].length;
}

/** Bytes UTF-8 de NFC(texto): lo que recibe main. El llamador los pone a cero tras enviarlos. */
export function passwordBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text.normalize('NFC'));
}

export function passwordIssue(text: string): PasswordIssue | null {
  if (codePointLength(text) < PASSWORD_MIN_CODE_POINTS) return 'short';
  if (new TextEncoder().encode(text.normalize('NFC')).length > PASSWORD_MAX_BYTES) return 'long';
  return null;
}

/** NFC + trim, como main (text(1, 40) de ipc/schemas.ts). */
export function normalizeName(name: string): string {
  return name.normalize('NFC').trim();
}

export function profileNameIssue(name: string): NameIssue | null {
  const n = normalizeName(name);
  const len = [...n].length;
  if (len < PROFILE_NAME_MIN) return 'empty';
  if (len > PROFILE_NAME_MAX) return 'long';
  if (/\p{Cc}/u.test(n)) return 'control';
  return null;
}
