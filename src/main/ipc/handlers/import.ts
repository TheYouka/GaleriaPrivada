// import:chooseFiles, import:chooseFolder, import:paths, import:confirm e import:cancel
// (docs/DESIGN.md §10.2, §12.1, §12.2, §12.5.1). Todos "U".
//
// - BUSY antes de abrir ningún diálogo (§12.11): la reserva del trabajo va primero.
// - Todos los diálogos llevan `dontAddToRecent` (§12.1).
// - import:paths solo llega desde importDropped (no está en la allowlist genérica) y sus rutas se
//   usan tal cual, sin NFC ni trim [H3-3]: el esquema es rawPath() (ipc/schemas.ts).
import type { OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import { AppErrorException, type Result } from '@shared/errors';
import { IMPORT_DIALOG_EXTENSIONS } from '@shared/constants';
import type { ReqOf, ResOf } from '@shared/ipc-contract';
import type { Id } from '@shared/types';
import type { ImportService } from '../../import/import-service';
import { handle, type SessionGate } from '../register';
import { SCHEMAS } from '../schemas';

export interface ImportHandlerDeps {
  service: Pick<ImportService, 'reserve' | 'release' | 'launch' | 'confirm' | 'cancel'>;
  /** dialog.showOpenDialog con la ventana actual como padre. */
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>;
}

export const CHOOSE_FILES_OPTIONS: OpenDialogOptions = Object.freeze({
  properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
  filters: [{ name: 'Fotos y vídeos', extensions: [...IMPORT_DIALOG_EXTENSIONS] }],
}) as OpenDialogOptions;

export const CHOOSE_FOLDER_OPTIONS: OpenDialogOptions = Object.freeze({
  properties: ['openDirectory', 'dontAddToRecent'],
}) as OpenDialogOptions;

export interface ImportHandlers {
  chooseFiles(): Promise<ResOf<'import:chooseFiles'>>;
  chooseFolder(): Promise<ResOf<'import:chooseFolder'>>;
  paths(req: ReqOf<'import:paths'>): ResOf<'import:paths'>;
  confirm(req: ReqOf<'import:confirm'>): void;
  cancel(req: ReqOf<'import:cancel'>): void;
}

/** Cuerpos de los handlers, sin ipcMain (los tests los llaman directamente). */
export function importHandlers({ service, showOpenDialog }: ImportHandlerDeps): ImportHandlers {
  const choose = async (options: OpenDialogOptions): Promise<{ jobId: Id } | null> => {
    const job = service.reserve(); // BUSY o LOCKED sin abrir el diálogo
    let result: OpenDialogReturnValue;
    try {
      result = await showOpenDialog(options);
    } catch (err) {
      service.release(job);
      throw err;
    }
    if (result.canceled || result.filePaths.length === 0) {
      service.release(job);
      return null;
    }
    // Las rutas salen del diálogo nativo, en main (§12.2).
    return { jobId: service.launch(job, result.filePaths).jobId };
  };
  return {
    chooseFiles: () => choose({ ...CHOOSE_FILES_OPTIONS }),
    chooseFolder: () => choose({ ...CHOOSE_FOLDER_OPTIONS }),
    paths: ({ paths }) => {
      const job = service.reserve();
      return { jobId: service.launch(job, paths).jobId };
    },
    confirm: ({ jobId, convert }) => service.confirm(jobId, convert),
    cancel: ({ jobId }) => service.cancel(jobId),
  };
}

export function registerImportHandlers(deps: ImportHandlerDeps): ImportHandlers {
  const h = importHandlers(deps);
  handle('import:chooseFiles', { requiresUnlock: true }, () => h.chooseFiles());
  handle('import:chooseFolder', { requiresUnlock: true }, () => h.chooseFolder());
  handle('import:paths', { requiresUnlock: true }, (req) => h.paths(req));
  handle('import:confirm', { requiresUnlock: true }, (req) => h.confirm(req));
  handle('import:cancel', { requiresUnlock: true }, (req) => h.cancel(req));
  return h;
}

/**
 * Gancho de E2E (solo `!app.isPackaged && GALERIA_E2E === '1'`, PLAN.md nota 108): el mismo camino
 * de main que un arrastre (`import:paths`): esquema rawPath(), desbloqueo, mantenimiento y BUSY,
 * sin el comprobante de emisor (no hay renderer de por medio).
 */
export function importPathsFromTest(
  h: ImportHandlers,
  gate: SessionGate,
  payload: unknown,
): Result<{ jobId: Id }> {
  const parsed = SCHEMAS['import:paths'].safeParse(payload);
  if (!parsed.success) return { ok: false, error: { code: 'VALIDATION' } };
  if (!gate.isUnlocked) return { ok: false, error: { code: 'LOCKED' } };
  if (gate.inMaintenance) return { ok: false, error: { code: 'BUSY' } };
  try {
    return { ok: true, data: h.paths(parsed.data) };
  } catch (err) {
    if (err instanceof AppErrorException) return { ok: false, error: err.error };
    return { ok: false, error: { code: 'INTERNAL' } };
  }
}
