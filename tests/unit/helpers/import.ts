// Banco de pruebas de la importación (PLAN.md 2.9): perfil, bóveda y DB reales bajo tests/.tmp/
// (KDF rápido), SessionManager real con la ventana falsa y un ImportService con los eventos
// grabados. Los fallos se inyectan con `faults.hook`.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ImportConfirmNeeded,
  ImportProgress,
  ImportReport,
  LibraryChanged,
} from '@shared/types';
import { KDF_FAST_TEST } from '../../../src/main/crypto/kdf';
import type { Db } from '../../../src/main/db/database';
import {
  ImportService,
  type FaultHook,
  type ImportFfmpeg,
  type ImportServiceDeps,
} from '../../../src/main/import/import-service';
import { LibraryEvents } from '../../../src/main/ipc/library-events';
import { Ffmpeg, resolveFfmpegPaths } from '../../../src/main/media/ffmpeg';
import { AvatarTokens } from '../../../src/main/profiles/avatars';
import { ProfileService } from '../../../src/main/profiles/profile-service';
import { ProfileStore } from '../../../src/main/profiles/profile-store';
import { SessionManager, type SessionDeps } from '../../../src/main/session/session-manager';
import { PrefsStore } from '../../../src/main/settings/settings-store';
import { InFlight } from '../../../src/main/vault/in-flight';
import { defaultVaultDir } from '../../../src/main/vault/vault-layout';

export const PASSWORD = 'contraseña larga';
export const pw = (): Uint8Array => new TextEncoder().encode(PASSWORD);

const ROOT = join(__dirname, '..', '..', '..');
export const realFfmpegPaths = resolveFfmpegPaths({
  isPackaged: false,
  resourcesPath: '',
  appPath: ROOT,
});
export const haveFfmpeg = existsSync(realFfmpegPaths.ffmpeg) && existsSync(realFfmpegPaths.ffprobe);

let sharedFfmpeg: Promise<Ffmpeg> | null = null;
/** El ffmpeg empaquetado (uno por archivo de test). */
export function realFfmpeg(): Promise<Ffmpeg> {
  sharedFfmpeg ??= (async () => {
    const ff = new Ffmpeg(realFfmpegPaths);
    await ff.checkAvailable();
    return ff;
  })();
  return sharedFfmpeg;
}

/** ffmpeg ausente: la importación de vídeo da FFMPEG_MISSING (§19.4). */
export const missingFfmpeg: ImportFfmpeg = {
  available: false,
  loadDecoders: async () => null,
  run: async () => {
    throw new Error('sin ffmpeg');
  },
  start: () => {
    throw new Error('sin ffmpeg');
  },
};

export interface Recorded {
  progress: ImportProgress[];
  done: ImportReport[];
  confirmNeeded: ImportConfirmNeeded[];
  library: LibraryChanged[];
  /** Se resuelve con el siguiente import:confirmNeeded. */
  nextConfirm(): Promise<ImportConfirmNeeded>;
}

export interface ImportHarness {
  root: string;
  vaultDir: string;
  profileId: string;
  session: SessionManager;
  /** El servicio de perfiles del banco (traslado y disco ausente, 2.11). */
  profiles: ProfileService;
  prefs: PrefsStore;
  service: ImportService;
  inFlight: InFlight;
  events: Recorded;
  faults: { hook: FaultHook | null };
  /** Carpeta de origen propia del test. */
  src: string;
  db(): Db;
  unlock(): Promise<void>;
  /** reserve + launch y espera al informe (null si un bloqueo lo abortó). */
  run(paths: string[]): Promise<ImportReport | null>;
  start(paths: string[]): { jobId: string; done: Promise<ImportReport | null> };
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  ffmpeg?: ImportFfmpeg;
  deps?: Partial<ImportServiceDeps>;
  session?: Partial<SessionDeps>;
}

export async function importHarness(
  tmp: string,
  opts: HarnessOptions = {},
): Promise<ImportHarness> {
  const root = mkdtempSync(join(tmp, 'r-'));
  const src = join(root, 'origen');
  mkdirSync(src);
  const dataRoot = join(root, 'GaleriaData');
  mkdirSync(dataRoot);
  const prefs = new PrefsStore(dataRoot);
  const store = new ProfileStore(dataRoot);
  const service = new ProfileService({
    dataRoot,
    store,
    prefs,
    tokens: new AvatarTokens(),
    session: { currentProfileId: null, lock: async () => undefined },
    isPackaged: false,
    chooseKdfParams: async () => ({ ...KDF_FAST_TEST }),
  });
  const summary = await service.createProfile({
    name: 'Ana',
    avatar: { type: 'builtin', id: 'aurora' },
    password: pw(),
    acknowledgeNoRecovery: true,
  });
  const profileId = summary.id;
  const session = new SessionManager({
    loadProfile: (id) => service.unlockTarget(id),
    readPrefs: (id) => prefs.get(id),
    ui: {
      sendLocking: () => undefined,
      hide: () => undefined,
      sendLocked: () => undefined,
      replaceWindow: () => undefined,
      setContentProtection: () => undefined,
    },
    ...opts.session,
  });
  await session.unlock(profileId, pw());

  let confirmWaiters: ((c: ImportConfirmNeeded) => void)[] = [];
  const events: Recorded = {
    progress: [],
    done: [],
    confirmNeeded: [],
    library: [],
    nextConfirm: () => new Promise((resolve) => confirmWaiters.push(resolve)),
  };
  const faults: { hook: FaultHook | null } = { hook: null };
  const inFlight = new InFlight();
  const library = new LibraryEvents((p) => events.library.push(p), 1);
  const ffmpeg = opts.ffmpeg ?? (haveFfmpeg ? await realFfmpeg() : missingFfmpeg);
  const importService = new ImportService({
    session,
    ffmpeg,
    events: {
      progress: (p) => events.progress.push(p),
      done: (r) => events.done.push(r),
      confirmNeeded: (c) => {
        events.confirmNeeded.push(c);
        const waiters = confirmWaiters;
        confirmWaiters = [];
        for (const w of waiters) w(c);
      },
    },
    library,
    inFlight,
    protectedRoots: async () => [dataRoot],
    faults: (point, ctx) => faults.hook?.(point, ctx),
    ...opts.deps,
  });

  const start = (paths: string[]): { jobId: string; done: Promise<ImportReport | null> } =>
    importService.launch(importService.reserve(), paths);

  return {
    root: dataRoot,
    vaultDir: defaultVaultDir(dataRoot, profileId),
    profileId,
    session,
    profiles: service,
    prefs,
    service: importService,
    inFlight,
    events,
    faults,
    src,
    db: () => session.getDb(session.epoch),
    unlock: async () => {
      await session.unlock(profileId, pw());
    },
    run: (paths) => start(paths).done,
    start,
    dispose: async () => {
      library.dispose();
      await session.lock('manual');
      await session.cleanup.idle();
    },
  };
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Archivos bajo objects/, thumbs/ y tmp/ de la bóveda (rutas relativas). */
export function vaultFiles(vaultDir: string): {
  objects: string[];
  thumbs: string[];
  tmp: string[];
} {
  const list = (sub: string): string[] => {
    const dir = join(vaultDir, sub);
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const visit = (d: string, rel: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) visit(p, `${rel}${name}/`);
        else out.push(`${rel}${name}`);
      }
    };
    visit(dir, '');
    return out.sort();
  };
  return { objects: list('objects'), thumbs: list('thumbs'), tmp: list('tmp') };
}

export function mediaRows(
  db: Db,
): { id: string; state: string; name: string; converted: number }[] {
  return db.prepare('SELECT id, state, name, converted FROM media ORDER BY id').all() as {
    id: string;
    state: string;
    name: string;
    converted: number;
  }[];
}
