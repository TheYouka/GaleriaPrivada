// vault:getInfo, vault:relocate, vault:relocateCancel ("U") y vault:locate (con la bóveda
// bloqueada) (docs/DESIGN.md §8.7, §10.2). [H3-8] El renderer nunca envía rutas: las carpetas salen
// de diálogos nativos en main, todos con `dontAddToRecent`.
//
// - vault:relocate reserva el trabajo antes de abrir el diálogo (BUSY sin diálogo, §12.11) y lo
//   libera si se cancela; vault:getInfo y vault:relocateCancel siguen disponibles en `maintenance`
//   (MAINTENANCE_ALLOWED de register.ts).
// - vault:locate: VAULT_UNAVAILABLE con details.path = la ruta configurada si la carpeta elegida no
//   es la bóveda del perfil.
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import type { ReqOf, ResOf } from '@shared/ipc-contract';
import type { RelocateService } from '../../vault/relocate';
import { handle } from '../register';

export interface VaultHandlerDeps {
  relocate: Pick<
    RelocateService,
    'getInfo' | 'reserve' | 'release' | 'launch' | 'cancel' | 'locate'
  >;
  /** dialog.showOpenDialog con la ventana actual como padre. */
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
}

export const RELOCATE_DIALOG_OPTIONS: OpenDialogOptions = Object.freeze({
  title: 'Elige dónde mover la bóveda',
  properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
}) as OpenDialogOptions;

export const LOCATE_DIALOG_OPTIONS: OpenDialogOptions = Object.freeze({
  title: 'Busca la carpeta de la bóveda',
  properties: ['openDirectory', 'dontAddToRecent'],
}) as OpenDialogOptions;

export interface VaultHandlers {
  getInfo(): Promise<ResOf<'vault:getInfo'>>;
  relocate(req: ReqOf<'vault:relocate'>): Promise<ResOf<'vault:relocate'>>;
  relocateCancel(req: ReqOf<'vault:relocateCancel'>): void;
  locate(req: ReqOf<'vault:locate'>): Promise<ResOf<'vault:locate'>>;
}

async function chooseFolder(
  showOpenDialog: VaultHandlerDeps['showOpenDialog'],
  options: OpenDialogOptions,
): Promise<string | null> {
  const result = await showOpenDialog({ ...options });
  if (result.canceled) return null;
  return result.filePaths[0] ?? null;
}

/** Cuerpos de los handlers, sin ipcMain (los tests los llaman directamente). */
export function vaultHandlers({ relocate, showOpenDialog }: VaultHandlerDeps): VaultHandlers {
  return {
    getInfo: () => relocate.getInfo(),
    relocate: async ({ target }) => {
      const job = relocate.reserve(); // BUSY o LOCKED sin abrir el diálogo
      let chosen: string | undefined;
      if (target === 'choose') {
        let folder: string | null;
        try {
          folder = await chooseFolder(showOpenDialog, RELOCATE_DIALOG_OPTIONS);
        } catch (err) {
          relocate.release(job);
          throw err;
        }
        if (!folder) {
          relocate.release(job);
          return null;
        }
        chosen = folder;
      }
      return relocate.launch(job, target, chosen); // libera la reserva si la validación falla
    },
    relocateCancel: ({ jobId }) => relocate.cancel(jobId),
    locate: async ({ profileId }) => {
      const folder = await chooseFolder(showOpenDialog, LOCATE_DIALOG_OPTIONS);
      if (!folder) return null;
      return relocate.locate(profileId, folder);
    },
  };
}

export function registerVaultHandlers(deps: VaultHandlerDeps): VaultHandlers {
  const h = vaultHandlers(deps);
  handle('vault:getInfo', { requiresUnlock: true }, () => h.getInfo());
  handle('vault:relocate', { requiresUnlock: true }, (req) => h.relocate(req));
  handle('vault:relocateCancel', { requiresUnlock: true }, (req) => h.relocateCancel(req));
  handle('vault:locate', { requiresUnlock: false }, (req) => h.locate(req));
  return h;
}
