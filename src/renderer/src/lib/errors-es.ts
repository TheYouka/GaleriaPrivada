// Mensajes en español de cada ErrorCode (docs/DESIGN.md §14.1 y §21.1) [H3-10]. main nunca envía
// textos: el renderer elige el mensaje a partir del código (y, como mucho, de details.reason).
import type { AppError, ErrorCode } from '@shared/errors';

export const GENERIC_ERROR_MESSAGE = 'Se produjo un error inesperado. Inténtalo de nuevo.';

/** Record<ErrorCode, …>: si se añade un código a ERROR_CODES sin mensaje, no compila. */
export const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  VALIDATION: 'Algún dato no es válido. Revísalo e inténtalo de nuevo.',
  LOCKED: 'La bóveda está bloqueada.',
  BUSY: 'Hay otra operación en curso. Espera a que termine.',
  WRONG_PASSWORD: 'Contraseña incorrecta',
  PROFILE_NOT_FOUND: 'Ese perfil ya no existe.',
  PROFILE_NAME_TAKEN: 'Ya hay un perfil con ese nombre.',
  PROFILE_LIMIT: 'Ya hay 10 perfiles, que es el máximo.',
  VAULT_UNAVAILABLE: 'No se encuentra la bóveda (¿está conectado el disco?)',
  VAULT_CORRUPT:
    'La bóveda de este perfil está dañada y no se puede abrir. Galería no puede repararla.',
  NOT_FOUND: 'No se ha encontrado el elemento.',
  INTEGRITY: 'No se puede mostrar este archivo (está dañado).',
  UNSUPPORTED_FORMAT: 'Ese formato no es compatible.',
  TOO_LARGE: 'El archivo es demasiado grande.',
  DISK_FULL: 'No queda espacio suficiente en el disco.',
  IO: 'No se pudo leer o escribir en el disco.',
  FFMPEG_MISSING: 'Falta el componente de vídeo de Galería.',
  FFMPEG_FAILED: 'No se pudo procesar el vídeo.',
  CANCELLED: 'Operación cancelada.',
  PLAYLIST_FULL: 'La playlist está llena (máximo 2000 elementos).',
  INTERNAL: GENERIC_ERROR_MESSAGE,
});

/** Mensajes más concretos según details.reason. */
const REASON_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'kdf-memory':
    'No hay memoria suficiente para proteger la contraseña. Cierra otras aplicaciones e inténtalo de nuevo.',
  'confirm-name': 'El nombre no coincide con el del perfil.',
  // Traslado de la bóveda (§8.7, paso 1).
  'same-location': 'La bóveda ya está en la ubicación predeterminada.',
  'folder-not-found': 'No se encuentra la carpeta elegida.',
  'folder-not-writable': 'No se puede escribir en la carpeta elegida.',
  'target-exists': 'En la carpeta elegida ya hay una bóveda de este perfil (o una copia a medias).',
  'inside-vault': 'La carpeta de destino no puede estar dentro de la bóveda, ni al revés.',
  'pending-cleanup':
    'Todavía quedan restos de la ubicación anterior de la bóveda. Bórralos o inténtalo más tarde.',
  'relocate-verify':
    'La copia no coincide con el original. La bóveda sigue en su sitio y no se ha movido nada.',
  'relocate-commit':
    'Galería está terminando de mover la bóveda. Espera unos segundos e inténtalo de nuevo.',
});

function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code);
}

/** Mensaje para un AppError o un código; uno genérico si el código es desconocido. */
export function errorMessage(error: AppError | ErrorCode | string | null | undefined): string {
  if (error && typeof error === 'object') {
    const reason = error.details?.reason;
    if (typeof reason === 'string' && Object.hasOwn(REASON_MESSAGES, reason)) {
      return REASON_MESSAGES[reason] as string;
    }
    return isErrorCode(error.code) ? ERROR_MESSAGES[error.code] : GENERIC_ERROR_MESSAGE;
  }
  return isErrorCode(error) ? ERROR_MESSAGES[error] : GENERIC_ERROR_MESSAGE;
}
