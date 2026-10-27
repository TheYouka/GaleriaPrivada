// URLs de vault:// (docs/DESIGN.md §11.1). El renderer nunca recibe rutas de la bóveda: solo
// construye estas URLs con ids validados. F1: avatares; F2 añade media y thumb.
import { AVATAR_TOKEN_PATTERN, ID_PATTERN } from '@shared/constants';
import type { Id } from '@shared/types';

/** Avatar personalizado guardado (en claro); `rev` solo invalida la caché. */
export function avatarUrl(profileId: Id, rev: number): string {
  if (!ID_PATTERN.test(profileId)) throw new RangeError('profileId inválido');
  if (!Number.isSafeInteger(rev) || rev < 0) throw new RangeError('rev inválido');
  return `vault://avatar/${profileId}?rev=${rev}`;
}

/** Miniatura de un medio; `rev` cambia cuando se regenera (§11.1). */
export function thumbUrl(mediaId: Id, rev: number): string {
  if (!ID_PATTERN.test(mediaId)) throw new RangeError('mediaId inválido');
  if (!Number.isSafeInteger(rev) || rev < 0) throw new RangeError('rev inválido');
  return `vault://thumb/${mediaId}?rev=${rev}`;
}

/** Original de un medio (descifrado al vuelo, con Range): la foto en el visor y el vídeo (§11.1). */
export function mediaUrl(mediaId: Id): string {
  if (!ID_PATTERN.test(mediaId)) throw new RangeError('mediaId inválido');
  return `vault://media/${mediaId}`;
}

/** Pista de música de la biblioteca del perfil (en claro, con Range y CORS; §8.6.1 y §11.1). */
export function musicUrl(trackId: Id): string {
  if (!ID_PATTERN.test(trackId)) throw new RangeError('trackId inválido');
  return `vault://music/${trackId}`;
}

/** Foto de avatar elegida y aún no guardada (token de profiles:pickAvatarPhoto). */
export function pendingAvatarUrl(token: string): string {
  if (!AVATAR_TOKEN_PATTERN.test(token)) throw new RangeError('token inválido');
  return `vault://avatar/pending/${token}`;
}
