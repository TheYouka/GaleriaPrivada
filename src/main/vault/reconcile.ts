// Reconciliación al desbloquear (docs/DESIGN.md §12.6), enganchada al paso 6 del desbloqueo
// (SessionManager, dependencia `reconcile`). Antes de mostrar la galería, con la DB recién abierta:
//
//   1. filas `pending` (trabajos interrumpidos): objeto final → sigue; `.part` que verifica → se
//      renombra; `.part` que no verifica → borrado criptográfico, fila borrada y `warn`
//      `reconcile.pending.dropped`; sin nada → fila borrada. Lo mismo para la miniatura (kind 2;
//      si no verifica la regenera el punto 3). Después `ready` (salvo las sustituciones, punto 2);
//   2. sustituciones a medias (`import.replace.<newId>`, §12.7): transacción B si la fila nueva
//      existe; si no, se devuelve el HMAC a la antigua. Un valor inválido se conserva con `error`;
//   3. [H3-7] (P9) miniaturas ausentes: `readdir` de los 256 `thumbs/<aa>/` en un Set y comparación
//      con `SELECT thumb_id … state = 'ready'`, sin un `stat` por miniatura. Las ausentes pasan a
//      `thumb_id = NULL` y entran en la cola de regeneración (en segundo plano, una cada vez, con
//      los pasos 2–6 de §16.5 y las ediciones guardadas: vault/thumb-replace.ts);
//   4. se borran los `tmp/*.part` que queden (por KeylessCleanup: se une a un borrado en curso);
//   6. `pendingCleanup` en segundo plano (relocate.ts);
//   7. barrido de huérfanos en segundo plano: 1 directorio `aa` cada 50 ms, ignorando `inFlight` y
//      volviendo a consultar la DB justo antes de cada borrado criptográfico.
// El punto 5 (música) llega en F4 (4.2).
//
// La cola y el barrido usan la señal de la sesión (se aborta en el paso 2 del bloqueo) y piden la
// DB, las claves y la carpeta con la época de la sesión [H3-6]: tras un bloqueo reciben LOCKED y
// no tocan nada más. Durante un traslado (§8.7, paso 2) se pausan después del elemento en curso.
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AppErrorException } from '@shared/errors';
import { ID_PATTERN } from '@shared/constants';
import { foldEdits } from '@shared/edits';
import type { Id, LibraryChangeReason } from '@shared/types';
import { KIND_MEDIA, KIND_THUMB, type ObjectKind } from '../crypto/file-format';
import { openObject, type ObjectReader } from '../crypto/object-reader';
import type { Db } from '../db/database';
import { listEdits } from '../db/repos/edit-repo';
import { listImportReplacements } from '../db/repos/kv-repo';
import {
  clearThumbIds,
  completeReplacement,
  deletePending,
  isObjectReferenced,
  isThumbReferenced,
  listPending,
  listReadyThumbs,
  markReady,
  referencedInShard,
  setRegeneratedThumb,
  thumbSource,
  undoReplacement,
} from '../db/repos/media-repo';
import { log } from '../log';
import type { Ffmpeg } from '../media/ffmpeg';
import { LoopbackServer } from '../media/loopback-server';
import { videoThumbnail } from '../media/thumbnails';
import type { ReconcileContext, SessionManager } from '../session/session-manager';
import type { InFlight } from './in-flight';
import { fileIdOf, ObjectStore, type EraseResult } from './object-store';
import { replaceThumb } from './thumb-replace';
import { vaultPaths } from './vault-layout';

/** Cola de regeneración: miniatura ausente (punto 3) o sustitución con ediciones (punto 2). */
export type RegenMode = 'missing' | 'edited';

/** Barrido de huérfanos: un directorio `aa` cada esto (§12.6, punto 7). */
export const SWEEP_INTERVAL_MS = 50;

/** Los 256 shards `00`…`ff`. */
export const SHARDS: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

const PART_NAME = /^([0-9a-f]{32})\.part$/;

/** E/S de la reconciliación (inyectable: el test de [H3-7] la espía). */
export interface ReconcileIo {
  readdir(path: string): Promise<string[]>;
  /** Solo para las rutas concretas de las filas `pending` (punto 1), nunca por miniatura. */
  lstat(path: string): Promise<{ isFile(): boolean }>;
}

export const defaultReconcileIo: ReconcileIo = {
  readdir: (p) => readdir(p),
  lstat: (p) => lstat(p),
};

export type ReconcileSession = Pick<
  SessionManager,
  'getDb' | 'getKeyRing' | 'getVaultDir' | 'registerReader' | 'registerWriter' | 'cleanup'
>;

export interface ReconcilerDeps {
  session: ReconcileSession;
  /** Un único conjunto por proceso (lo comparten importación, edición y fusión). */
  inFlight: InFlight;
  /** Regenerar miniaturas de vídeo; sin ffmpeg, esas filas se quedan sin miniatura. */
  ffmpeg?: Pick<Ffmpeg, 'available' | 'run'> | null;
  /** library:changed tras regenerar una miniatura (`thumbRev` cambia). */
  library?: { changed(reason: LibraryChangeReason, ids?: readonly Id[]): void };
  /** Punto 6: pendingCleanup del perfil, en segundo plano (relocate.ts). Nunca debe lanzar. */
  pendingCleanup?: (profileId: Id) => Promise<void>;
  io?: Partial<ReconcileIo>;
  sweepIntervalMs?: number;
  /** Arranca la cola y el barrido (por defecto true; los tests de los puntos 1–4 lo desactivan). */
  background?: boolean;
}

export interface ReconcileReport {
  /** Punto 1. */
  pendingReady: number;
  pendingPromoted: number;
  pendingDropped: number;
  thumbsPromoted: number;
  /** Punto 2. */
  replacementsCompleted: number;
  replacementsUndone: number;
  replacementsInvalid: number;
  /** Punto 2: sustituciones terminadas que copiaron ediciones (su miniatura se rehace con ellas). */
  editedReplacements: Id[];
  /** Punto 3: ids sin miniatura que entran en la cola. */
  missingThumbs: Id[];
  /** Punto 4. */
  partsRemoved: number;
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
}

const isEnoent = (err: unknown): boolean => errnoOf(err) === 'ENOENT';

const isLocked = (err: unknown): boolean =>
  err instanceof AppErrorException &&
  (err.error.code === 'LOCKED' || err.error.code === 'CANCELLED');

/** Lee el objeto entero verificando cada tag; el plaintext se pone a cero en cuanto se ha leído. */
async function verifyAll(reader: ObjectReader, signal: AbortSignal): Promise<void> {
  if (reader.plaintextSize === 0) {
    (await reader.readAll()).fill(0);
    return;
  }
  for await (const chunk of reader.createReadStream(0, reader.plaintextSize - 1)) {
    (chunk as Buffer).fill(0);
    if (signal.aborted) throw new AppErrorException({ code: 'LOCKED' });
  }
}

/** Puerta de pausa de la cola y del barrido (§8.7, paso 2: tras el elemento en curso). */
class PauseGate {
  private paused = false;
  private waiters: (() => void)[] = [];
  private current: Promise<unknown> | null = null;

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener('abort', () => this.flush(), { once: true });
  }

  /** Espera mientras esté en pausa (o hasta el abort) y ejecuta `fn` como elemento en curso. */
  async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    while (this.paused && !this.signal.aborted) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    if (this.signal.aborted) return undefined;
    const p = fn();
    this.current = p;
    try {
      return await p;
    } finally {
      if (this.current === p) this.current = null;
    }
  }

  /** Pausa y espera a que termine el elemento en curso (sin propagar su error). */
  async pause(): Promise<void> {
    this.paused = true;
    await this.current?.catch(() => undefined);
  }

  resume(): void {
    this.paused = false;
    this.flush();
  }

  private flush(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r();
  }
}

/** Cola de regeneración y barrido de una sesión. */
class Background {
  readonly gates: PauseGate[];
  private readonly regenGate: PauseGate;
  private readonly sweepGate: PauseGate;
  private readonly queue: { id: Id; mode: RegenMode }[] = [];
  private regenLoop: Promise<void> | null = null;
  private sweepLoop: Promise<void> | null = null;

  constructor(
    private readonly r: Reconciler,
    readonly epoch: number,
    readonly signal: AbortSignal,
  ) {
    this.regenGate = new PauseGate(signal);
    this.sweepGate = new PauseGate(signal);
    this.gates = [this.regenGate, this.sweepGate];
  }

  start(items: readonly { id: Id; mode: RegenMode }[]): void {
    this.queue.push(...items);
    this.regenLoop = this.runRegen();
    this.sweepLoop = this.runSweep();
  }

  async idle(): Promise<void> {
    await Promise.all([this.regenLoop, this.sweepLoop]);
  }

  private async runRegen(): Promise<void> {
    while (this.queue.length > 0 && !this.signal.aborted) {
      const { id, mode } = this.queue.shift() as { id: Id; mode: RegenMode };
      try {
        await this.regenGate.run(() => this.r.regenerateThumb(this.epoch, id, this.signal, mode));
      } catch (err) {
        if (this.signal.aborted || isLocked(err)) return;
        const code = err instanceof AppErrorException ? err.error.code : undefined;
        log.warn('reconcile.thumb-failed', { mediaId: id, code, errno: errnoOf(err) });
      }
    }
  }

  private async runSweep(): Promise<void> {
    for (const kind of ['objects', 'thumbs'] as const) {
      for (const shard of SHARDS) {
        if (this.signal.aborted) return;
        try {
          await this.sweepGate.run(() => this.r.sweepShard(this.epoch, kind, shard, this.signal));
        } catch (err) {
          if (this.signal.aborted || isLocked(err)) return;
          log.warn('reconcile.sweep-failed', { errno: errnoOf(err), stage: kind });
        }
        if (!(await this.r.sleep(this.signal))) return;
      }
    }
  }
}

/**
 * Reconciliación (§12.6). Una instancia por proceso (index.ts); `run` es la dependencia
 * `reconcile` del SessionManager.
 */
export class Reconciler {
  private readonly io: ReconcileIo;
  private readonly sweepMs: number;
  private bg: Background | null = null;

  constructor(private readonly deps: ReconcilerDeps) {
    this.io = { ...defaultReconcileIo, ...deps.io };
    this.sweepMs = deps.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
  }

  /** Paso 6 del desbloqueo. Los puntos 1–4 se esperan; 3 (cola), 6 y 7 siguen en segundo plano. */
  async run(ctx: ReconcileContext): Promise<ReconcileReport> {
    const { db, vaultDir, signal, epoch } = ctx;
    const store = new ObjectStore(vaultDir);
    const report: ReconcileReport = {
      pendingReady: 0,
      pendingPromoted: 0,
      pendingDropped: 0,
      thumbsPromoted: 0,
      replacementsCompleted: 0,
      replacementsUndone: 0,
      replacementsInvalid: 0,
      editedReplacements: [],
      missingThumbs: [],
      partsRemoved: 0,
    };
    const check = (): void => {
      if (signal.aborted) throw new AppErrorException({ code: 'LOCKED' });
    };

    // 1. Filas pending.
    const replacing = new Set(
      listImportReplacements(db)
        .map((r) => r.newId)
        .filter((id): id is Id => id !== null),
    );
    for (const row of listPending(db)) {
      check();
      // Un trabajo de la sesión anterior que aún no ha terminado (drain-timeout) [H3-6].
      if (this.deps.inFlight.has(row.id)) continue;
      try {
        await this.reconcilePending(ctx, store, row.id, row.thumbId, replacing.has(row.id), report);
      } catch (err) {
        if (signal.aborted || isLocked(err)) throw err;
        // Un fallo de E/S con una fila no impide abrir la bóveda: sigue `pending` (invisible) y se
        // reintenta en el siguiente desbloqueo.
        log.warn('reconcile.failed', { mediaId: row.id, errno: errnoOf(err), stage: 'pending' });
      }
    }

    // 2. Sustituciones a medias.
    check();
    await this.reconcileReplacements(db, store, report);

    // 3. Miniaturas ausentes [H3-7].
    check();
    report.missingThumbs = await this.findMissingThumbs(db, vaultDir);
    if (report.missingThumbs.length > 0) clearThumbIds(db, report.missingThumbs);

    // 4. tmp/*.part.
    check();
    report.partsRemoved = await this.removeParts(store);

    log.info('reconcile.done', {
      count: report.pendingReady + report.pendingDropped + report.replacementsCompleted,
    });

    // 6 y 7 (y la cola del punto 3) en segundo plano.
    if (this.deps.pendingCleanup) {
      void this.deps.pendingCleanup(ctx.profileId).catch(() => undefined);
    }
    if (this.deps.background !== false) {
      const bg = new Background(this, epoch, signal);
      this.bg = bg;
      const missing = new Set(report.missingThumbs);
      bg.start([
        ...report.missingThumbs.map((id) => ({ id, mode: 'missing' as const })),
        // Si además le falta la miniatura, ya la rehace la entrada `missing` (con sus ediciones).
        ...report.editedReplacements
          .filter((id) => !missing.has(id))
          .map((id) => ({ id, mode: 'edited' as const })),
      ]);
    }
    return report;
  }

  /** §8.7, paso 2: pausa la cola y el barrido después del elemento en curso. */
  async pauseBackground(): Promise<void> {
    const bg = this.bg;
    if (bg) await Promise.all(bg.gates.map((g) => g.pause()));
  }

  /** Al salir de `maintenance`. */
  resumeBackground(): void {
    for (const g of this.bg?.gates ?? []) g.resume();
  }

  /** Tests: se resuelve cuando la cola y el barrido de la sesión actual terminan. */
  async backgroundIdle(): Promise<void> {
    await this.bg?.idle();
  }

  /** Espera el intervalo del barrido; false si la sesión se abortó. */
  sleep(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve(false);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(!signal.aborted);
      }, this.sweepMs);
      timer.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ── Punto 1 ───────────────────────────────────────────────────────────────────────────────────

  private async exists(path: string): Promise<boolean> {
    try {
      await this.io.lstat(path);
      return true;
    } catch (err) {
      if (isEnoent(err)) return false;
      throw err;
    }
  }

  /** Verifica `tmp/<id>.part` entero (cabecera, fileId, kind y todos los tags). */
  private async verifyPart(
    ctx: ReconcileContext,
    store: ObjectStore,
    id: Id,
    kind: ObjectKind,
  ): Promise<boolean> {
    const keys = this.deps.session.getKeyRing(ctx.epoch);
    let reader: ObjectReader;
    try {
      reader = await openObject(store.partPath(id), { fileId: fileIdOf(id), kind }, keys.kWrap);
    } catch (err) {
      if (ctx.signal.aborted || isLocked(err)) throw err;
      return false;
    }
    let unregister: () => void = () => undefined;
    try {
      unregister = this.deps.session.registerReader(reader, ctx.epoch);
      await verifyAll(reader, ctx.signal);
      return true;
    } catch (err) {
      if (ctx.signal.aborted || isLocked(err)) throw err;
      return false;
    } finally {
      unregister();
      await reader.close();
    }
  }

  private async dropThumb(store: ObjectStore, thumbId: Id | null): Promise<void> {
    if (!thumbId) return;
    await store.eraseObject(thumbId, KIND_THUMB);
    await store.erasePart(thumbId);
  }

  private async reconcilePending(
    ctx: ReconcileContext,
    store: ObjectStore,
    id: Id,
    thumbId: Id | null,
    isReplacement: boolean,
    report: ReconcileReport,
  ): Promise<void> {
    const { db } = ctx;
    // Objeto.
    if (!(await this.exists(store.objectPath(id)))) {
      const hasPart = await this.exists(store.partPath(id));
      if (hasPart && (await this.verifyPart(ctx, store, id, KIND_MEDIA))) {
        await store.promote(id, KIND_MEDIA);
        report.pendingPromoted += 1;
      } else {
        // Sin objeto verificable: fuera la fila (y su EXIF por cascada) y después los archivos.
        deletePending(db, id);
        if (hasPart) {
          await store.erasePart(id);
          log.warn('reconcile.pending.dropped', { mediaId: id });
        }
        await this.dropThumb(store, thumbId);
        report.pendingDropped += 1;
        return;
      }
    }
    // Miniatura (la fila sigue): si falta y su .part verifica, se renombra; si no, el punto 3.
    if (thumbId && !(await this.exists(store.thumbPath(thumbId)))) {
      if (await this.exists(store.partPath(thumbId))) {
        if (await this.verifyPart(ctx, store, thumbId, KIND_THUMB)) {
          await store.promote(thumbId, KIND_THUMB);
          report.thumbsPromoted += 1;
        } else {
          await store.erasePart(thumbId);
        }
      }
    }
    // Las sustituciones pasan a `ready` con la transacción B (punto 2).
    if (!isReplacement && markReady(db, id)) report.pendingReady += 1;
  }

  // ── Punto 2 ───────────────────────────────────────────────────────────────────────────────────

  private async reconcileReplacements(
    db: Db,
    store: ObjectStore,
    report: ReconcileReport,
  ): Promise<void> {
    for (const entry of listImportReplacements(db)) {
      if (!entry.newId || !entry.value) {
        // Se conserva la clave para diagnóstico; la fila antigua sigue con un HMAC aleatorio.
        log.error('reconcile.replace.invalid', { stage: 'value' });
        report.replacementsInvalid += 1;
        continue;
      }
      const { newId, value } = entry;
      const exists = db.prepare('SELECT 1 FROM media WHERE id = ?').get(newId) !== undefined;
      if (exists) {
        let result: ReturnType<typeof completeReplacement>;
        try {
          result = completeReplacement(db, newId, value.old);
        } catch (err) {
          log.error('reconcile.replace.invalid', { mediaId: newId, errno: errnoOf(err) });
          report.replacementsInvalid += 1;
          continue;
        }
        if (!result.ok) {
          log.error('reconcile.replace.invalid', { mediaId: newId, stage: 'state' });
          report.replacementsInvalid += 1;
          continue;
        }
        // Tras el COMMIT, borrado criptográfico de los objetos antiguos.
        if (result.oldExisted) {
          await store.eraseObject(value.old, KIND_MEDIA);
          if (result.oldThumbId) await store.eraseObject(result.oldThumbId, KIND_THUMB);
        }
        // Se copiaron ediciones: la miniatura de newId se rehace con ellas (§12.7 punto 3, §16.5
        // pasos 2–6), en la cola de segundo plano.
        if (result.copiedEdits > 0) report.editedReplacements.push(newId);
        report.replacementsCompleted += 1;
      } else {
        try {
          undoReplacement(db, newId, value.old, Buffer.from(value.hmac, 'hex'));
          report.replacementsUndone += 1;
        } catch (err) {
          log.error('reconcile.replace.invalid', { mediaId: newId, errno: errnoOf(err) });
          report.replacementsInvalid += 1;
        }
      }
    }
  }

  // ── Punto 3 [H3-7] ────────────────────────────────────────────────────────────────────────────

  /**
   * 256 `readdir` de `thumbs/<aa>/` en un Set; ningún `stat` por miniatura. Si un shard no se puede
   * listar (salvo ENOENT), no se marca nada: sus miniaturas parecerían ausentes sin estarlo.
   */
  private async findMissingThumbs(db: Db, vaultDir: string): Promise<Id[]> {
    const present = new Set<string>();
    const thumbs = vaultPaths(vaultDir).thumbs;
    for (const shard of SHARDS) {
      let names: string[];
      try {
        names = await this.io.readdir(join(thumbs, shard));
      } catch (err) {
        if (isEnoent(err)) continue;
        log.warn('reconcile.failed', { errno: errnoOf(err), stage: 'thumbs' });
        return [];
      }
      for (const name of names) present.add(name);
    }
    return listReadyThumbs(db)
      .filter((r) => !present.has(r.thumbId))
      .map((r) => r.id);
  }

  // ── Punto 4 ───────────────────────────────────────────────────────────────────────────────────

  private async removeParts(store: ObjectStore): Promise<number> {
    let names: string[];
    try {
      names = await this.io.readdir(vaultPaths(store.vaultDir).tmp);
    } catch (err) {
      if (!isEnoent(err)) log.warn('reconcile.failed', { errno: errnoOf(err), stage: 'tmp' });
      return 0;
    }
    let removed = 0;
    const keyless = this.deps.session.cleanup;
    for (const name of names) {
      const id = PART_NAME.exec(name)?.[1];
      if (!id || this.deps.inFlight.has(id)) continue;
      const out: { result: EraseResult | null } = { result: null };
      await keyless.run(store.partPath(id), async () => {
        out.result = await store.erasePart(id);
      });
      if (out.result === 'erased' || out.result === 'unlinked') removed += 1;
    }
    return removed;
  }

  // ── Cola de regeneración (punto 3, §16.5 pasos 2–6) ──────────────────────────────────────────

  /**
   * Rehace la miniatura de `id` con los pasos 2–6 de §16.5 (vault/thumb-replace.ts): foto desde el
   * objeto descifrado en memoria y CON SUS EDICIONES GUARDADAS (§16.3); vídeo con el fotograma
   * leído del objeto cifrado por loopback. La nueva se cifra en `tmp/<thumbId>.part`, entra en
   * inFlight, se renombra y se confirma con `thumb_rev += 1`.
   *
   * `missing` (punto 3): solo si la fila sigue `ready` y sin miniatura. `edited` (punto 2, una
   * sustitución que copió ediciones): sustituye la miniatura actual, solo si sigue siendo la misma
   * al confirmar (una edición guardada mientras tanto gana) y la antigua se borra tras el COMMIT.
   */
  async regenerateThumb(
    epoch: number,
    id: Id,
    signal: AbortSignal,
    mode: RegenMode = 'missing',
  ): Promise<void> {
    const { session } = this.deps;
    const db = session.getDb(epoch);
    const source = thumbSource(db, id, { anyThumb: mode === 'edited' });
    if (!source) return;
    if (source.kind === 'video' && !this.deps.ffmpeg?.available) return;
    const expected = source.thumbId;
    const store = new ObjectStore(session.getVaultDir(epoch));
    const ok = await replaceThumb(
      { session, inFlight: this.deps.inFlight },
      {
        epoch,
        mediaId: id,
        signal,
        state: source.kind === 'photo' ? foldEdits(listEdits(db, id)) : undefined,
        produce:
          source.kind === 'video'
            ? () => this.videoFromObject(epoch, store, id, source.mime, source.durationMs, signal)
            : undefined,
        commit: (tx, thumbId) =>
          setRegeneratedThumb(tx, id, thumbId, expected)
            ? { oldThumbId: expected, value: true }
            : null,
      },
    );
    if (ok) this.deps.library?.changed('edit', [id]);
  }

  private async openRegistered(
    epoch: number,
    path: string,
    id: Id,
    kind: ObjectKind,
  ): Promise<ObjectReader> {
    const keys = this.deps.session.getKeyRing(epoch);
    const reader = await openObject(
      path,
      { fileId: fileIdOf(id), kind },
      keys.kWrap,
      keys.dekCache,
    );
    let unregister: () => void;
    try {
      unregister = this.deps.session.registerReader(reader, epoch);
    } catch (err) {
      void reader.close();
      throw err;
    }
    return {
      get plaintextSize() {
        return reader.plaintextSize;
      },
      createReadStream: (start, end) => reader.createReadStream(start, end),
      readAll: () => reader.readAll(),
      destroyKeys: () => reader.destroyKeys(),
      close: async () => {
        unregister();
        await reader.close();
      },
    };
  }

  private async videoFromObject(
    epoch: number,
    store: ObjectStore,
    id: Id,
    mime: string,
    durationMs: number | null,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const ffmpeg = this.deps.ffmpeg as Pick<Ffmpeg, 'available' | 'run'>;
    const lb = await LoopbackServer.start({
      open: (t) => this.openRegistered(epoch, t.path, id, t.kind),
      signal,
    });
    try {
      const url = lb.register('src', {
        path: store.objectPath(id),
        fileId: fileIdOf(id),
        kind: KIND_MEDIA,
        mime,
      });
      return await videoThumbnail({ ffmpeg, url, mime, durationMs, signal });
    } finally {
      await lb.close();
    }
  }

  // ── Barrido de huérfanos (punto 7) ────────────────────────────────────────────────────────────

  /**
   * Un directorio `objects/<aa>` o `thumbs/<aa>`: los archivos sin fila se borran con borrado
   * criptográfico, salvo los de inFlight; justo antes de cada borrado se vuelve a consultar la DB.
   */
  async sweepShard(
    epoch: number,
    kind: 'objects' | 'thumbs',
    shard: string,
    signal: AbortSignal,
  ): Promise<number> {
    const { session, inFlight } = this.deps;
    const vaultDir = session.getVaultDir(epoch);
    const dir = join(vaultDir, kind, shard);
    let names: string[];
    try {
      names = await this.io.readdir(dir);
    } catch (err) {
      if (isEnoent(err)) return 0;
      throw err;
    }
    const candidates = names.filter((n) => ID_PATTERN.test(n) && n.startsWith(shard));
    if (candidates.length === 0 || signal.aborted) return 0;
    const referenced = referencedInShard(session.getDb(epoch), kind, shard);
    const store = new ObjectStore(vaultDir);
    let erased = 0;
    for (const id of candidates) {
      if (signal.aborted) return erased;
      if (referenced.has(id) || inFlight.has(id)) continue;
      // Justo antes de borrar: otra vez inFlight y la DB (un COMMIT puede haber llegado ya).
      const db = session.getDb(epoch);
      const used = kind === 'objects' ? isObjectReferenced(db, id) : isThumbReferenced(db, id);
      if (used || inFlight.has(id) || signal.aborted) continue;
      const result = await store.eraseObject(id, kind === 'objects' ? KIND_MEDIA : KIND_THUMB);
      if (result === 'erased' || result === 'unlinked') erased += 1;
    }
    if (erased > 0) log.info('reconcile.orphans-erased', { count: erased, stage: kind });
    return erased;
  }
}
