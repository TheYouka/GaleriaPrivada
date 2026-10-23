// Avatar de un perfil: una de las 12 ilustraciones del proyecto, la foto guardada (vault://avatar,
// en claro) o la foto elegida aún sin guardar (token). Decorativo por defecto: el nombre accesible lo
// da el control que lo contiene.
import type { AvatarRef, Id } from '@shared/types';
import { BUILTIN_AVATAR_URLS } from '../lib/avatars';
import { cx } from '../lib/cx';
import { avatarUrl, pendingAvatarUrl } from '../lib/vault-url';

export type AvatarSource =
  { kind: 'ref'; profileId: Id; avatar: AvatarRef } | { kind: 'pending'; token: string };

export interface AvatarProps {
  source: AvatarSource;
  size: number;
  className?: string;
  alt?: string;
}

function srcOf(source: AvatarSource): string {
  if (source.kind === 'pending') return pendingAvatarUrl(source.token);
  const { avatar, profileId } = source;
  return avatar.type === 'builtin'
    ? BUILTIN_AVATAR_URLS[avatar.id]
    : avatarUrl(profileId, avatar.rev);
}

export function Avatar({ source, size, className, alt = '' }: AvatarProps) {
  return (
    <img
      src={srcOf(source)}
      alt={alt}
      width={size}
      height={size}
      decoding="async"
      className={cx('block shrink-0 rounded-avatar bg-tile-placeholder object-cover', className)}
      style={{ width: size, height: size }}
    />
  );
}
