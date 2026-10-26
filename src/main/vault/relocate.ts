// Traslado de la bóveda y disco ausente (docs/DESIGN.md §8.7). Ajustes → Almacenamiento llama a
// vault:relocate ("Mover bóveda…" o "Volver a la ubicación predeterminada"); el selector, a
// vault:locate ("Buscar la bóveda…").
//
// Pasos del traslado:
//   1. validar (carpeta escribible, destino y destino.partial inexistentes, ni dentro de la bóveda
//      ni al revés, espacio ≥ tamaño × 1,05 + 200 MiB, ningún trabajo activo → BUSY);
//   2. subestado `maintenance` (canales "U" → BUSY, vault:// → 503, auto-bloqueo y vigilante en
//      pausa, cola de miniaturas y barrido en pausa tras el elemento en curso);
//   3. wal_checkpoint(TRUNCATE) y cerrar la DB;
//   4. copiar a <destino>.partial (con el marcador .galeria-relocate-<jobId>) vault.json,
//      library.db, objects/, thumbs/ y music/ (sin tmp/ ni music/*.part), con fsync por archivo, y
//      verificar cada archivo comparando el SHA-256 del origen y del destino (ciphertext y música en
//      claro: no se descifra nada);
//   5. rename(<destino>.partial, <destino>) y borrar el marcador;
//   6. punto de confirmación: profiles.json (+ .bak) con la ubicación nueva y pendingCleanup;
//   7. reabrir la DB en el destino y salir de `maintenance`;
//   8. removeVaultDir(<antigua>) y, si termina bien, quitar pendingCleanup.
//
// Nunca queda ninguna bóveda sin referenciar: hasta el paso 6 profiles.json apunta a la antigua, que
// no se toca; desde el paso 6, a la nueva, ya completa y verificada. Los pasos 4, 5, 6 y 8 no usan
// claves: un bloqueo pone las claves a cero al momento (el trabajo llama a done() en el abort) y lo
// que falte sigue o se deshace en KeylessCleanup (§13.3, paso 6). Los pasos 5–6 son una unidad que
// no se interrumpe; el desbloqueo de este perfil la espera (relocateCommitKey, §13.1 paso 1).
//
// [H3-8] El renderer nunca envía rutas: el destino sale del diálogo de main o es la ubicación
// predeterminada; solo ve la ubicación de la bóveda (VaultInfo.path y leftoverPath).
import { createHash, randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  statfs,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { AppErrorException, type AppError } from '@shared/errors';
import type { Id, ProfileSummary, RelocateDone, RelocateProgress, VaultInfo } from '@shared/types';
import { comparable, isWithin } from '../import/path-guard';
import { log } from '../log';
import type { ProfileService } from '../profiles/profile-service';
import { vaultDirOf, type StoredProfile } from '../profiles/profile-store';
import type { JobHandle } from '../session/jobs';
import { relocateCommitKey } from '../session/keyless-cleanup';
import type { SessionManager } from '../session/session-manager';
import {
  VAULT_JSON,
  VAULT_SUBDIRS,
  VAULTS_DIR,
  defaultVaultDir,
  readVaultJson,
  removeVaultDir as defaultRemoveVaultDir,
  vaultPaths,
} from './vault-layout';

/** relocate:progress como mucho cada esto (§8.7, paso 4). */
export const RELOCATE_PROGRESS_MS = 250;
/** Espacio libre exigido: tamaño × 1,05 + 200 MiB (§8.7, paso 1). */
export const RELOCATE_SPACE_FACTOR = 1.05;
export const RELOCATE_SPACE_MARGIN = 200 * 1024 * 1024;
/** Marcador de <destino>.partial (removeVaultDir 'relocate-partial', §8.5.1). */
export const RELOCATE_MARKER_PREFIX = '.galeria-relocate-';
const COPY_CHUNK = 1024 * 1024;
const linux = process.platform === 'linux';

/** Puntos donde los tests simulan una caída (el hook no vuelve nunca) o esperan. */
export const RELOCATE_FAULT_POINTS = [
  'validated',
  'maintenance',
  'db-closed',
  'partial-created',
  'file-copied',
  'copied',
  'verified',
  'renamed',
  'committed',
  'reopened',
  'old-removed',
] as const;
export type RelocateFaultPoint = (typeof RELOCATE_FAULT_POINTS)[number];

export interface RelocateIo {
  removeVaultDir: typeof defaultRemoveVaultDir;
  /** Bytes libres para un usuario sin privilegios en el volumen de `path`. */
  freeBytes(path: string): Promise<number>;
}

export const defaultRelocateIo: RelocateIo = {
  removeVaultDir: defaultRemoveVaultDir,
  freeBytes: async (p) => {
    const st = await statfs(p);
    return Number(st.bavail) * Number(st.bsize);
  },
};

export type RelocateSession = Pick<
  SessionManager,
  | 'epoch'
  | 'currentProfileId'
  | 'startJob'
  | 'getVaultDir'
  | 'enterMaintenance'
  | 'exitMaintenance'
  | 'closeDbForMaintenance'
  | 'reopenDb'
  | 'cleanup'
  | 'lock'
>;

export type RelocateProfiles = Pick<ProfileService, 'storedProfile' | 'updateVault' | 'summarize'>;

export interface RelocateEvents {
  progress(p: RelocateProgress): void;
  done(d: RelocateDone): void;
}

export interface RelocateDeps {
  dataRoot: string;
  session: RelocateSession;
  profiles: RelocateProfiles;
  events: RelocateEvents;
  /** Cola de miniaturas y barrido de la reconciliación (se pausan en el paso 2). */
  background?: { pauseBackground(): Promise<void>; resumeBackground(): void };
  io?: Partial<RelocateIo>;
  /** Solo tests: se espera en cada punto (un hook que no vuelve simula una caída del proceso). */
  faults?: (point: RelocateFaultPoint, ctx: { jobId: Id }) => void | Promise<void>;
}

const validation = (reason: string): AppErrorException =>
  new AppErrorException({ code: 'VALIDATION', details: { reason } });

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
}

/** Un fallo de E/S como AppError: ENOSPC → DISK_FULL; el resto → IO (nunca err.message). */
function toAppError(err: unknown): AppError {
  if (err instanceof AppErrorException) return err.error;
  return { code: errnoOf(err) === 'ENOSPC' ? 'DISK_FULL' : 'IO' };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return false;
    throw err;
  }
}

/** Misma carpeta tras realpath (si existe), sin distinguir mayúsculas en Windows. */
async function sameDir(a: string, b: string): Promise<boolean> {
  const ra = await realpath(a).catch(() => a);
  const rb = await realpath(b).catch(() => b);
  return comparable(ra) === comparable(rb);
}

async function syncDir(path: string): Promise<void> {
  if (!linux) return;
  const fh = await open(path, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// ── Lista de lo que se copia (§8.7, paso 4) ────────────────────────────────────────────────────

interface FileEntry {
  /** Ruta relativa a la bóveda. */
  rel: string;
  size: number;
}

interface VaultListing {
  files: FileEntry[];
  /** Carpetas relativas, padres antes que hijas. */
  dirs: string[];
  bytes: number;
}

/**
 * vault.json, library.db, objects/, thumbs/ y music/ (sin music/*.part), en ese orden. Sin tmp/.
 * Nunca sigue enlaces: un enlace u otra cosa que no sea archivo o carpeta se omite con un `warn`.
 */
async function listVault(vaultDir: string): Promise<VaultListing> {
  const files: FileEntry[] = [];
  const dirs: string[] = [...VAULT_SUBDIRS];
  let bytes = 0;
  const addFile = (rel: string, size: number): void => {
    files.push({ rel, size });
    bytes += size;
  };
  for (const name of [VAULT_JSON, 'library.db']) {
    const st = await lstat(join(vaultDir, name));
    if (!st.isFile()) throw new AppErrorException({ code: 'IO', details: { reason: 'layout' } });
    addFile(name, st.size);
  }
  const visit = async (rel: string, top: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(join(vaultDir, rel))).sort();
    } catch (err) {
      if (errnoOf(err) === 'ENOENT') return;
      throw err;
    }
    for (const name of names) {
      const childRel = join(rel, name);
      const st = await lstat(join(vaultDir, childRel));
      if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
        log.warn('relocate.skipped-entry', { stage: top });
      } else if (st.isDirectory()) {
        dirs.push(childRel);
        await visit(childRel, top);
      } else if (!(top === 'music' && name.endsWith('.part'))) {
        addFile(childRel, st.size);
      }
    }
  };
  for (const top of ['objects', 'thumbs', 'music']) await visit(top, top);
  return { files, dirs, bytes };
}

/** Tamaño de la bóveda (lo que se copiaría más el WAL, si queda alguno). */
async function vaultSize(vaultDir: string): Promise<number> {
  const listing = await listVault(vaultDir);
  const wal = await lstat(join(vaultDir, 'library.db-wal')).catch(() => null);
  return listing.bytes + (wal?.isFile() ? wal.size : 0);
}

/** Error de parada: cancelación del usuario o bloqueo. */
class Stop extends Error {
  constructor() {
    super('stop');
  }
}

// ── El trabajo ─────────────────────────────────────────────────────────────────────────────────

interface Plan {
  profileId: Id;
  epoch: number;
  oldDir: string;
  dest: string;
  location: 'default' | 'custom';
  oldVault: StoredProfile['vault'];
}

type Stage = 'prepare' | 'copy' | 'commit' | 'finish';

class RelocateJob {
  readonly id: Id;
  stage: Stage = 'prepare';
  private readonly cancelCtl = new AbortController();
  private readonly partial: string;
  private partialCreated = false;
  private dbClosed = false;
  /** profiles.json apunta a la nueva, pero su escritura dio error (recoverFailedCommit). */
  private commitUncertain = false;
  private copied = 0;
  private total = 0;
  private lastProgress = 0;

  constructor(
    private readonly deps: RelocateDeps,
    private readonly io: RelocateIo,
    private readonly handle: JobHandle,
    private readonly plan: Plan,
  ) {
    this.id = handle.id;
    this.partial = `${plan.dest}.partial`;
  }

  /** Bloqueo (la señal del JobHandle). */
  private get locked(): boolean {
    return this.handle.signal.aborted;
  }

  private get stopped(): boolean {
    return this.locked || this.cancelCtl.signal.aborted;
  }

  /** "Cancelar": solo antes del paso 5 (después se ignora y el diálogo muestra "Terminando…"). */
  cancel(): void {
    if (this.stage === 'prepare' || this.stage === 'copy') this.cancelCtl.abort();
  }

  private async fault(point: RelocateFaultPoint): Promise<void> {
    await this.deps.faults?.(point, { jobId: this.id });
  }

  private checkStop(): void {
    if (this.stopped) throw new Stop();
  }

  private progress(force = false): void {
    if (this.locked) return;
    const now = Date.now();
    if (!force && now - this.lastProgress < RELOCATE_PROGRESS_MS) return;
    this.lastProgress = now;
    try {
      this.deps.events.progress({
        jobId: this.id,
        copiedBytes: Math.min(this.copied, this.total),
        totalBytes: this.total,
      });
    } catch {
      // la ventana puede no existir
    }
  }

  private emitDone(result: RelocateDone['result']): void {
    this.handle.done(); // antes del evento: la UI puede volver a pedir un traslado al recibirlo
    if (this.locked) return; // tras un bloqueo la ventana se sustituye: no hay a quién avisar
    try {
      this.deps.events.done({ jobId: this.id, result });
    } catch {
      // la ventana puede no existir
    }
  }

  async run(): Promise<void> {
    // Al bloquear, las claves se ponen a cero sin esperar: lo que queda no usa claves (§8.7).
    const onAbort = (): void => {
      log.info('relocate.interrupted', { jobId: this.id, stage: this.stage });
      this.handle.done();
    };
    this.handle.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.execute();
    } catch (err) {
      log.error('relocate.failed', { jobId: this.id, stage: this.stage, errno: errnoOf(err) });
      this.handle.done();
    } finally {
      this.handle.signal.removeEventListener('abort', onAbort);
    }
  }

  private async execute(): Promise<void> {
    const { session } = this.deps;
    const { epoch } = this.plan;

    // 2. Mantenimiento.
    try {
      session.enterMaintenance(this.id, epoch);
    } catch (err) {
      this.emitDone({ ok: false, error: toAppError(err) });
      return;
    }
    await this.deps.background?.pauseBackground();
    await this.fault('maintenance');

    try {
      this.checkStop();
      // 3. Checkpoint y cerrar la DB.
      this.dbClosed = true;
      session.closeDbForMaintenance(epoch);
      await this.fault('db-closed');
      this.checkStop();

      // 4. Copiar y verificar.
      this.stage = 'copy';
      await this.copyAndVerify();
      this.checkStop();
    } catch (err) {
      await this.abandonCopy(err);
      return;
    }

    // 5–6. Unidad sin claves que no se interrumpe (también si llega un bloqueo).
    this.stage = 'commit';
    this.copied = this.total;
    this.progress(true);
    const committed = await this.commitUnit();
    if (!committed.ok && !(await this.recoverFailedCommit(committed))) return;
    await this.fault('committed');

    // Desde el paso 6 la bóveda es la nueva. Tras un bloqueo no se reabre nada: el paso 8 sigue
    // en segundo plano (salvo con shutdown: lo retoma pendingCleanup al arrancar).
    this.stage = 'finish';
    if (this.locked) {
      if (this.handle.signal.reason !== 'shutdown') void this.removeOld();
      return;
    }

    // 7. Reabrir en el destino y salir de mantenimiento.
    try {
      session.reopenDb(epoch, this.plan.dest);
    } catch (err) {
      await this.undoAfterReopenFailure(err);
      return;
    }
    this.exitMaintenance();
    await this.fault('reopened');

    // 8. Borrar la bóveda antigua.
    const leftover = await this.removeOld();
    await this.fault('old-removed');
    log.info('relocate.done', { jobId: this.id });
    if (this.locked) {
      this.handle.done();
      return;
    }
    let info: VaultInfo;
    try {
      info = await this.info();
    } catch {
      info = { location: this.plan.location, path: this.plan.dest, sizeBytes: 0, freeBytes: 0 };
    }
    this.emitDone({ ok: true, data: leftover ? { ...info, leftoverPath: leftover } : info });
  }

  private exitMaintenance(): void {
    this.deps.session.exitMaintenance(this.id, this.plan.epoch);
    this.deps.background?.resumeBackground();
  }

  private async info(): Promise<VaultInfo> {
    const dir = this.plan.dest;
    const [sizeBytes, freeBytes] = await Promise.all([vaultSize(dir), this.io.freeBytes(dir)]);
    return { location: this.plan.location, path: dir, sizeBytes, freeBytes };
  }

  // ── Paso 4 ────────────────────────────────────────────────────────────────────────────────────

  private async copyAndVerify(): Promise<void> {
    const { oldDir } = this.plan;
    const listing = await listVault(oldDir);
    this.total = listing.bytes * 2; // copia + verificación
    this.copied = 0;
    this.progress(true);

    await mkdir(this.partial); // el padre existe (paso 1); falla si ya existe
    this.partialCreated = true;
    await writeFile(join(this.partial, `${RELOCATE_MARKER_PREFIX}${this.id}`), '', { flag: 'wx' });
    for (const rel of listing.dirs) await mkdir(join(this.partial, rel));
    await this.fault('partial-created');

    const hashes = new Map<string, Buffer>();
    for (const file of listing.files) {
      this.checkStop();
      hashes.set(
        file.rel,
        await this.copyFile(join(oldDir, file.rel), join(this.partial, file.rel)),
      );
      await this.fault('file-copied');
    }
    await this.fault('copied');

    for (const file of listing.files) {
      this.checkStop();
      const sha = await this.hashFile(join(this.partial, file.rel));
      if (!sha.equals(hashes.get(file.rel) as Buffer)) {
        throw new AppErrorException({ code: 'INTEGRITY', details: { reason: 'relocate-verify' } });
      }
    }
    await this.fault('verified');
  }

  /** Copia con 'wx' y fsync; devuelve el SHA-256 de lo leído del origen. */
  private async copyFile(src: string, dst: string): Promise<Buffer> {
    const hash = createHash('sha256');
    const input = await open(src, 'r');
    try {
      const output = await open(dst, 'wx', 0o600);
      try {
        const buf = Buffer.alloc(COPY_CHUNK);
        let pos = 0;
        for (;;) {
          this.checkStop();
          const { bytesRead } = await input.read(buf, 0, buf.length, pos);
          if (bytesRead <= 0) break;
          const chunk = buf.subarray(0, bytesRead);
          hash.update(chunk);
          let written = 0;
          while (written < bytesRead) {
            const { bytesWritten } = await output.write(chunk, written, bytesRead - written);
            if (bytesWritten <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' });
            written += bytesWritten;
          }
          pos += bytesRead;
          this.copied += bytesRead;
          this.progress();
        }
        await output.sync();
      } finally {
        await output.close().catch(() => undefined);
      }
    } finally {
      await input.close().catch(() => undefined);
    }
    return hash.digest();
  }

  private async hashFile(path: string): Promise<Buffer> {
    const hash = createHash('sha256');
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(COPY_CHUNK);
      let pos = 0;
      for (;;) {
        this.checkStop();
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (bytesRead <= 0) break;
        hash.update(buf.subarray(0, bytesRead));
        pos += bytesRead;
        this.copied += bytesRead;
        this.progress();
      }
    } finally {
      await fh.close().catch(() => undefined);
    }
    return hash.digest();
  }

  private removePartial(): Promise<void> {
    const { profileId } = this.plan;
    return this.deps.session.cleanup.run(this.partial, async () => {
      const r = await this.io.removeVaultDir(this.partial, profileId, 'relocate-partial', {
        relocateJobId: this.id,
      });
      if (!r.removed) log.warn('relocate.leftover', { jobId: this.id, stage: 'partial' });
    });
  }

  /**
   * Antes del paso 5: cancelación, bloqueo o fallo de copia/verificación. Se borra
   * <destino>.partial y, con la sesión viva, se reabre la DB original y se sale de `maintenance`.
   */
  private async abandonCopy(err: unknown): Promise<void> {
    if (this.locked) {
      // Equivale a cancelar sin reabrir la DB; el borrado sigue sin claves. Con shutdown no se
      // arranca: el .partial se queda y el paso 1 de otro traslado no lo reutiliza.
      if (this.partialCreated && this.handle.signal.reason !== 'shutdown') {
        void this.removePartial();
      }
      return;
    }
    const cancelled = err instanceof Stop;
    const error: AppError = cancelled ? { code: 'CANCELLED' } : toAppError(err);
    if (cancelled) log.info('relocate.cancelled', { jobId: this.id });
    else log.warn('relocate.failed', { jobId: this.id, code: error.code, errno: errnoOf(err) });
    if (this.partialCreated) await this.removePartial();
    if (!this.reopenOld()) return;
    this.exitMaintenance();
    this.emitDone({ ok: false, error });
  }

  /**
   * Vuelta a la DB original con la sesión viva. false si no se pudo (se bloquea con `error`: la
   * bóveda antigua sigue intacta y referenciada, el siguiente desbloqueo la abre).
   */
  private reopenOld(): boolean {
    if (this.locked) return false;
    if (!this.dbClosed) return true;
    try {
      this.deps.session.reopenDb(this.plan.epoch, this.plan.oldDir);
      return true;
    } catch (err) {
      log.error('relocate.rollback-failed', { jobId: this.id, errno: errnoOf(err) });
      this.handle.done();
      void this.deps.session.lock('error');
      return false;
    }
  }

  // ── Pasos 5–6 ─────────────────────────────────────────────────────────────────────────────────

  /**
   * rename(<destino>.partial, <destino>), borrar el marcador y escribir profiles.json. Corre en
   * KeylessCleanup con la clave del perfil: sigue aunque llegue un bloqueo y el desbloqueo la espera.
   */
  private async commitUnit(): Promise<
    { ok: true } | { ok: false; renamed: boolean; err: unknown }
  > {
    const { profileId, dest, oldDir, location } = this.plan;
    let renamed = false;
    let failure: unknown = null;
    await this.deps.session.cleanup.runKey(relocateCommitKey(profileId), async () => {
      try {
        // 5. (El marcador se borra después del rename: si el rename falla, <destino>.partial sigue
        //    identificándose y removeVaultDir 'relocate-partial' lo puede borrar; nota 118.)
        await rename(this.partial, dest);
        renamed = true;
        await unlink(join(dest, `${RELOCATE_MARKER_PREFIX}${this.id}`)).catch(() => undefined);
        await syncDir(dirname(dest)).catch(() => undefined);
        await this.fault('renamed');
        // 6. Punto de confirmación.
        await this.deps.profiles.updateVault(profileId, () =>
          location === 'default'
            ? { location: 'default', pendingCleanup: oldDir }
            : { location: 'custom', path: dest, pendingCleanup: oldDir },
        );
      } catch (err) {
        failure = err;
      }
    });
    return failure === null ? { ok: true } : { ok: false, renamed, err: failure };
  }

  /**
   * Qué bóveda referencia ahora profiles.json (lo que abriría el siguiente desbloqueo): la antigua,
   * la nueva, otra o ninguna ('unknown', también si no se puede leer).
   */
  private async referencedVault(): Promise<{ which: 'old' | 'new' | 'unknown'; dir: string }> {
    const { profileId, dest, oldDir } = this.plan;
    let dir: string;
    try {
      dir = vaultDirOf(this.deps.dataRoot, await this.deps.profiles.storedProfile(profileId));
    } catch (err) {
      log.error('relocate.rollback-failed', { jobId: this.id, stage: 'read', errno: errnoOf(err) });
      return { which: 'unknown', dir: '' };
    }
    if (await sameDir(dir, dest)) return { which: 'new', dir };
    if (await sameDir(dir, oldDir)) return { which: 'old', dir };
    return { which: 'unknown', dir };
  }

  /**
   * Falló el paso 5 o el 6. Devuelve true si, pese al error, el traslado quedó confirmado (el
   * trabajo sigue con los pasos 7–8); false si ya está resuelto.
   *
   * Sin el rename, profiles.json no se ha tocado: se borra <destino>.partial. Con el rename hecho,
   * profiles.json puede apuntar ya a la nueva aunque updateVault lance (writeFileAtomic lanza
   * también si falla el fsync de la carpeta después de su rename, y ProfileStore.write si falla el
   * .bak): se vuelve a leer y <destino> solo se borra si sigue referenciada la antigua, pasando esa
   * ruta leída como bóveda actual. Si no se puede saber, no se borra nada y se bloquea con `error`.
   */
  private async recoverFailedCommit(failed: { renamed: boolean; err: unknown }): Promise<boolean> {
    const { profileId, dest } = this.plan;
    log.warn('relocate.failed', { jobId: this.id, stage: 'commit', errno: errnoOf(failed.err) });
    let which: 'old' | 'new' | 'unknown' = 'old';
    if (!failed.renamed) {
      const cleanup = this.removePartial();
      if (this.locked) {
        void cleanup;
        return false;
      }
      await cleanup;
    } else {
      // En KeylessCleanup: la decisión y el borrado siguen aunque llegue un bloqueo.
      const ref: { which: 'old' | 'new' | 'unknown' } = { which: 'unknown' };
      await this.deps.session.cleanup.run(dest, async () => {
        const current = await this.referencedVault();
        ref.which = current.which;
        if (current.which !== 'old') return;
        await this.io.removeVaultDir(dest, profileId, 'vault', { currentVaultDir: current.dir });
      });
      which = ref.which;
    }
    if (which === 'new') {
      // Confirmado: la nueva está completa y verificada. Antes de borrar la antigua (paso 8) se
      // reescribe profiles.json para asegurar que el cambio es duradero (removeOld).
      log.warn('relocate.failed', { jobId: this.id, stage: 'commit-confirmed' });
      this.commitUncertain = true;
      return true;
    }
    if (this.locked) return false;
    if (which === 'unknown') {
      // Siguen las dos; el siguiente desbloqueo abre la que diga profiles.json.
      log.error('relocate.rollback-failed', { jobId: this.id, stage: 'commit' });
      this.handle.done();
      void this.deps.session.lock('error');
      return false;
    }
    if (!this.reopenOld()) return false;
    this.exitMaintenance();
    this.emitDone({ ok: false, error: toAppError(failed.err) });
    return false;
  }

  // ── Paso 7 ────────────────────────────────────────────────────────────────────────────────────

  /**
   * La DB no abre en el destino: profiles.json vuelve a la ubicación anterior (sin pendingCleanup),
   * se reabre la DB antigua (intacta), se borra el destino y se devuelve IO.
   */
  private async undoAfterReopenFailure(err: unknown): Promise<void> {
    const { profileId, dest, oldVault } = this.plan;
    log.error('relocate.failed', { jobId: this.id, stage: 'reopen', errno: errnoOf(err) });
    try {
      await this.deps.profiles.updateVault(profileId, () => oldVault);
    } catch (writeErr) {
      // Sigue referenciada la nueva (completa y verificada) y la antigua en pendingCleanup: el
      // siguiente desbloqueo lo intentará otra vez. No se borra nada.
      log.error('relocate.rollback-failed', { jobId: this.id, errno: errnoOf(writeErr) });
      this.handle.done();
      void this.deps.session.lock('error');
      return;
    }
    if (!this.reopenOld()) return;
    this.exitMaintenance();
    // Como en recoverFailedCommit: <destino> solo se borra si profiles.json vuelve a la antigua.
    await this.deps.session.cleanup.run(dest, async () => {
      const current = await this.referencedVault();
      if (current.which !== 'old') {
        log.warn('relocate.leftover', { jobId: this.id, stage: 'reopen' });
        return;
      }
      await this.io.removeVaultDir(dest, profileId, 'vault', { currentVaultDir: current.dir });
    });
    this.emitDone({ ok: false, error: { code: 'IO' } });
  }

  // ── Paso 8 ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Borra la bóveda antigua (sin claves) y quita pendingCleanup si termina bien. Si la escritura
   * de profiles.json dio error aunque cambió (commitUncertain), primero se reescribe: si vuelve a
   * fallar, la antigua se conserva para pendingCleanup y se devuelve como restos.
   */
  private async removeOld(): Promise<string | null> {
    const { profileId, oldDir } = this.plan;
    if (this.commitUncertain) {
      try {
        await this.deps.profiles.updateVault(profileId, (p) => ({ ...p.vault }));
      } catch (err) {
        log.warn('relocate.leftover', {
          jobId: this.id,
          stage: 'unconfirmed',
          errno: errnoOf(err),
        });
        return oldDir;
      }
    }
    return removePendingCleanup(this.deps, this.io, profileId, oldDir);
  }
}

/** true si `dir` sigue teniendo vault.json, o si no se puede saber (la carpeta no responde). */
async function stillHoldsVault(dir: string): Promise<boolean> {
  try {
    const st = await lstat(dir);
    if (!st.isDirectory()) return true;
  } catch {
    return true;
  }
  try {
    await lstat(join(dir, VAULT_JSON));
    return true;
  } catch (err) {
    return errnoOf(err) !== 'ENOENT';
  }
}

/** `dir` tiene un vault.json de `profileId` y un library.db (archivos normales). */
async function holdsProfileVault(dir: string, profileId: Id): Promise<boolean> {
  if ((await readVaultJson(dir))?.profileId !== profileId) return false;
  const db = await lstat(vaultPaths(dir).db).catch(() => null);
  return db?.isFile() ?? false;
}

/**
 * removeVaultDir(<antigua>) por KeylessCleanup y, si termina bien, quita pendingCleanup de
 * profiles.json. Devuelve la ruta de los restos o null. Si ya había una tarea sobre esa ruta, se une
 * a ella y devuelve null (la otra ya lo resuelve). Nunca lanza.
 */
async function removePendingCleanup(
  deps: Pick<RelocateDeps, 'session' | 'profiles' | 'dataRoot'>,
  io: RelocateIo,
  profileId: Id,
  oldDir: string,
): Promise<string | null> {
  const out: { leftover: string | null } = { leftover: null };
  await deps.session.cleanup.run(oldDir, async () => {
    const profile = await deps.profiles.storedProfile(profileId);
    const current = vaultDirOf(deps.dataRoot, profile);
    // La antigua solo se borra si la referenciada es de verdad la bóveda de este perfil (vault.json
    // con su profileId y library.db). Si no (ausente, disco desconectado), se conserva todo.
    if (!(await holdsProfileVault(current, profileId))) {
      out.leftover = oldDir;
      log.warn('relocate.pending-cleanup', { stage: 'current-missing' });
      return;
    }
    const result = await io.removeVaultDir(oldDir, profileId, 'vault', {
      currentVaultDir: current,
    });
    if (!result.removed) {
      out.leftover = result.leftoverPath ?? oldDir;
      log.warn('relocate.leftover', { stage: 'old-vault' });
      // Solo se reintenta mientras quede algo de la bóveda: removeVaultDir borra vault.json el
      // último, así que sin él solo quedan archivos ajenos (que nunca borra) y pendingCleanup ya
      // no tiene nada que hacer (nota 119). Si la carpeta no responde (disco desconectado), se
      // conserva.
      if (await stillHoldsVault(oldDir)) return;
    }
    await deps.profiles.updateVault(profileId, (p) => {
      if (p.vault.pendingCleanup !== oldDir) return p.vault;
      return p.vault.location === 'default'
        ? { location: 'default' }
        : { location: 'custom', path: p.vault.path };
    });
    log.info('relocate.pending-cleanup', { stage: 'removed' });
  });
  return out.leftover;
}

// ── Servicio ───────────────────────────────────────────────────────────────────────────────────

export class RelocateService {
  private readonly io: RelocateIo;
  private current: RelocateJob | null = null;

  constructor(private readonly deps: RelocateDeps) {
    this.io = { ...defaultRelocateIo, ...deps.io };
  }

  /** vault:getInfo: ubicación, tamaño y espacio libre de la bóveda de la sesión. */
  async getInfo(): Promise<VaultInfo> {
    const { session, profiles } = this.deps;
    const epoch = session.epoch;
    const profileId = session.currentProfileId;
    if (!profileId) throw new AppErrorException({ code: 'LOCKED' });
    const dir = session.getVaultDir(epoch);
    const profile = await profiles.storedProfile(profileId);
    const [sizeBytes, freeBytes] = await Promise.all([vaultSize(dir), this.io.freeBytes(dir)]);
    return { location: profile.vault.location, path: dir, sizeBytes, freeBytes };
  }

  /** Paso 1, regla de trabajos: BUSY si hay cualquier trabajo activo (antes de abrir el diálogo). */
  reserve(): JobHandle {
    return this.deps.session.startJob('relocate');
  }

  /** Libera una reserva sin traslado (diálogo cancelado o validación fallida). */
  release(handle: JobHandle): void {
    handle.done();
  }

  /**
   * Paso 1 (validar) y arranque en segundo plano. Devuelve `{ jobId }` en cuanto pasan las
   * validaciones; si fallan, VALIDATION, IO, DISK_FULL o BUSY sin cambios (y libera la reserva).
   */
  async launch(
    handle: JobHandle,
    target: 'choose' | 'default',
    chosenDir?: string,
  ): Promise<{ jobId: Id }> {
    let plan: Plan;
    try {
      plan = await this.validate(handle, target, chosenDir);
      if (handle.signal.aborted) throw new AppErrorException({ code: 'LOCKED' });
    } catch (err) {
      handle.done();
      if (err instanceof AppErrorException) throw err;
      throw new AppErrorException(toAppError(err));
    }
    const job = new RelocateJob(this.deps, this.io, handle, plan);
    this.current = job;
    log.info('relocate.started', { jobId: job.id });
    void (async () => {
      await this.deps.faults?.('validated', { jobId: job.id });
      await job.run();
      if (this.current === job) this.current = null;
    })();
    return { jobId: job.id };
  }

  /** vault:relocateCancel: NOT_FOUND si no es el traslado en curso; se ignora desde el paso 5. */
  cancel(jobId: Id): void {
    const job = this.current;
    if (!job || job.id !== jobId) throw new AppErrorException({ code: 'NOT_FOUND' });
    job.cancel();
  }

  private async validate(
    handle: JobHandle,
    target: 'choose' | 'default',
    chosenDir: string | undefined,
  ): Promise<Plan> {
    const { session, profiles, dataRoot } = this.deps;
    const epoch = handle.epoch;
    const profileId = session.currentProfileId;
    if (!profileId || session.epoch !== epoch) throw new AppErrorException({ code: 'LOCKED' });
    const oldDir = session.getVaultDir(epoch);
    let profile = await profiles.storedProfile(profileId);

    // Un pendingCleanup anterior: se intenta terminar ya; si deja restos, no se empieza otro
    // traslado (solo cabe uno en profiles.json y se perdería la referencia; nota 119).
    if (profile.vault.pendingCleanup) {
      await removePendingCleanup(this.deps, this.io, profileId, profile.vault.pendingCleanup);
      profile = await profiles.storedProfile(profileId);
      if (profile.vault.pendingCleanup) throw validation('pending-cleanup');
    }

    let parent: string;
    let dest: string;
    if (target === 'default') {
      if (profile.vault.location === 'default') throw validation('same-location');
      parent = join(dataRoot, VAULTS_DIR);
      await mkdir(parent, { recursive: true });
      dest = defaultVaultDir(dataRoot, profileId);
    } else {
      if (!chosenDir) throw validation('folder-not-found');
      parent = chosenDir;
      dest = join(chosenDir, `Galeria-${profileId.slice(0, 8)}`);
    }

    // La carpeta elegida existe y se puede escribir (se crea y se borra un archivo).
    const parentSt = await lstat(parent).catch(() => null);
    if (!parentSt?.isDirectory()) throw validation('folder-not-found');
    const probe = join(parent, `.galeria-write-test-${randomBytes(8).toString('hex')}`);
    try {
      await writeFile(probe, '', { flag: 'wx' });
    } catch {
      throw validation('folder-not-writable');
    }
    await unlink(probe).catch(() => undefined);

    // Ni <destino> ni <destino>.partial existen.
    if ((await pathExists(dest)) || (await pathExists(`${dest}.partial`))) {
      throw validation('target-exists');
    }

    // Ni el destino dentro de la bóveda actual ni al revés (realpath, por segmentos).
    const realOld = comparable(await realpath(oldDir));
    const realDest = comparable(join(await realpath(parent), basename(dest)));
    if (isWithin(realOld, realDest) || isWithin(realDest, realOld))
      throw validation('inside-vault');

    // Espacio libre ≥ tamaño × 1,05 + 200 MiB.
    const size = await vaultSize(oldDir);
    const free = await this.io.freeBytes(parent);
    if (free < size * RELOCATE_SPACE_FACTOR + RELOCATE_SPACE_MARGIN) {
      throw new AppErrorException({ code: 'DISK_FULL' });
    }

    return {
      profileId,
      epoch,
      oldDir,
      dest,
      location: target === 'default' ? 'default' : 'custom',
      oldVault: profile.vault,
    };
  }

  // ── Disco ausente (§8.7) ──────────────────────────────────────────────────────────────────────

  /**
   * vault:locate: acepta `chosenDir` si su vault.json es del perfil (y tiene library.db) y guarda
   * exactamente esa carpeta como vault.path. Si no, VAULT_UNAVAILABLE con details.path = la ruta
   * configurada [H3-8]. BUSY si el perfil está abierto.
   */
  async locate(profileId: Id, chosenDir: string): Promise<ProfileSummary> {
    const { session, profiles, dataRoot } = this.deps;
    if (session.currentProfileId === profileId) throw new AppErrorException({ code: 'BUSY' });
    const profile = await profiles.storedProfile(profileId);
    const configured = vaultDirOf(dataRoot, profile);
    const pending = profile.vault.pendingCleanup;
    const vaultJson = await readVaultJson(chosenDir);
    const dbSt = await lstat(vaultPaths(chosenDir).db).catch(() => null);
    const isOldVault = pending ? await sameDir(chosenDir, pending) : false;
    if (!vaultJson || vaultJson.profileId !== profileId || !dbSt?.isFile() || isOldVault) {
      log.warn('vault.locate-rejected');
      throw new AppErrorException({ code: 'VAULT_UNAVAILABLE', details: { path: configured } });
    }
    const isDefault = await sameDir(chosenDir, defaultVaultDir(dataRoot, profileId));
    const updated = await profiles.updateVault(profileId, (p) => {
      const keep = p.vault.pendingCleanup ? { pendingCleanup: p.vault.pendingCleanup } : {};
      return isDefault
        ? { location: 'default', ...keep }
        : { location: 'custom', path: chosenDir, ...keep };
    });
    log.info('vault.located');
    return profiles.summarize(updated);
  }

  /**
   * pendingCleanup del perfil (§8.2): al arrancar y en cada desbloqueo (§12.6 punto 6). En
   * segundo plano y sin claves; nunca lanza.
   */
  async runPendingCleanup(profileId: Id): Promise<void> {
    try {
      const profile = await this.deps.profiles.storedProfile(profileId);
      const pending = profile.vault.pendingCleanup;
      if (!pending) return;
      await removePendingCleanup(this.deps, this.io, profileId, pending);
    } catch (err) {
      log.warn('relocate.pending-cleanup', { stage: 'failed', errno: errnoOf(err) });
    }
  }
}
