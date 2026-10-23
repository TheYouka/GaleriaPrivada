// profiles:* (docs/DESIGN.md §10.2 y §14.4). Ningún canal es "U": el selector los usa con la
// bóveda bloqueada. Editar, cambiar la contraseña y borrar exigen la contraseña del perfil; borrar
// no tiene ninguna otra ruta (anexo §1).
import { dialog } from 'electron';
import { pickAvatarPhoto, type AvatarTokens } from '../../profiles/avatars';
import type { ProfileService } from '../../profiles/profile-service';
import { getMainWindow } from '../../window';
import { handle } from '../register';

export interface ProfileHandlerDeps {
  profiles: ProfileService;
  tokens: AvatarTokens;
}

export function registerProfileHandlers({ profiles, tokens }: ProfileHandlerDeps): void {
  handle('profiles:list', { requiresUnlock: false }, () => profiles.list());
  handle('profiles:pickAvatarPhoto', { requiresUnlock: false }, () =>
    pickAvatarPhoto((options) => {
      const win = getMainWindow();
      return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
    }, tokens),
  );
  handle('profiles:create', { requiresUnlock: false }, (req) => profiles.createProfile(req));
  handle('profiles:update', { requiresUnlock: false }, (req) => profiles.updateProfile(req));
  handle('profiles:changePassword', { requiresUnlock: false }, (req) =>
    profiles.changePassword(req),
  );
  handle('profiles:delete', { requiresUnlock: false }, (req) => profiles.deleteProfile(req));
}
