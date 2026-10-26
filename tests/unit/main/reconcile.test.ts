// Reconciliación al desbloquear (docs/DESIGN.md §12.6; PLAN.md 2.10) con perfil, bóveda, DB y
// SessionManager reales bajo tests/.tmp/ (KDF rápido). Los estados a medias se construyen a mano
// (objetos cifrados con el KeyRing de la sesión y filas con media-repo).
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { KIND_MEDIA, KIND_THUMB } from '../../../src/main/crypto/file-format';
import {
  importReplaceKey,
  kvGet,
  listImportReplacements,
} from '../../../src/main/db/repos/kv-repo';
import { insertReplacing } from '../../../src/main/db/repos/media-repo';
import { log } from '../../../src/main/log';
import { getSharp } from '../../../src/main/media/sharp-loader';
import { InFlight } from '../../../src/main/vault/in-flight';
import {
  Reconciler,
  SHARDS,
  defaultReconcileIo,
  type ReconcileIo,
  type ReconcilerDeps,
} from '../../../src/main/vault/reconcile';
import { importHarness, type ImportHarness } from '../helpers/import';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
import {
  addReadyMedia,
  idInShard,
  insertRow,
  mediaRow,
  newId,
  storeOf,
  writeObject,
  writePart,
} from '../helpers/vault-fill';

vi.setConfig({ testTimeout: 30_000 });

const tmp = makeTmpDir('reconcile');
const open: ImportHarness[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of open.splice(0)) await h.dispose();
});
afterAll(() => removeTmpDir(tmp));

async function harness(): Promise<ImportHarness> {
  const h = await importHarness(tmp);
  open.push(h);
  return h;
}

function reconciler(h: ImportHarness, deps: Partial<ReconcilerDeps> = {}): Reconciler {
  return new Reconciler({
    session: h.session,
    inFlight: h.inFlight,
    background: false,
    ...deps,
  });
}

/** El contexto del paso 6 del desbloqueo, con la sesión ya abierta. */
function ctxOf(h: ImportHarness) {
  const epoch = h.session.epoch;
  return {
    epoch,
    profileId: h.profileId,
    db: h.db(),
    vaultDir: h.vaultDir,
    signal: h.session.getSessionSignal(epoch),
  };
}

function rowOf(h: ImportHarness, id: string) {
  return h
    .db()
    .prepare('SELECT state, thumb_id, thumb_rev, name FROM media WHERE id = ?')
    .get(id) as
    { state: string; thumb_id: string | null; thumb_rev: number; name: string } | undefined;
}

async function pngBuffer(): Promise<Buffer> {
  const sharp = await getSharp();
  return sharp({ create: { width: 64, height: 48, channels: 3, background: '#3366cc' } })
    .png()
    .toBuffer();
}

describe('punto 1: filas pending', () => {
  it('con el objeto final → ready', async () => {
    const h = await harness();
    const id = newId();
    const thumbId = newId();
    await writeObject(h.session, id, KIND_MEDIA, randomBytes(2000));
    await writeObject(h.session, thumbId, KIND_THUMB, randomBytes(200));
    insertRow(h.db(), { id, thumbId });
    const report = await reconciler(h).run(ctxOf(h));
    expect(report.pendingReady).toBe(1);
    expect(rowOf(h, id)?.state).toBe('ready');
    expect(rowOf(h, id)?.thumb_id).toBe(thumbId);
  });

  it('con un .part que verifica → se renombra a su sitio y queda ready', async () => {
    const h = await harness();
    const id = newId();
    const thumbId = newId();
    await writePart(h.session, id, KIND_MEDIA, randomBytes(70_000)); // dos chunks
    await writePart(h.session, thumbId, KIND_THUMB, randomBytes(300));
    insertRow(h.db(), { id, thumbId });
    const store = storeOf(h.session);
    const report = await reconciler(h).run(ctxOf(h));
    expect(report.pendingPromoted).toBe(1);
    expect(report.thumbsPromoted).toBe(1);
    expect(existsSync(store.objectPath(id))).toBe(true);
    expect(existsSync(store.thumbPath(thumbId))).toBe(true);
    expect(existsSync(store.partPath(id))).toBe(false);
    expect(rowOf(h, id)?.state).toBe('ready');
  });

  it('con un .part que no verifica → borrado criptográfico, fila borrada y warn', async () => {
    const h = await harness();
    const warn = vi.spyOn(log, 'warn');
    const id = newId();
    await writePart(h.session, id, KIND_MEDIA, randomBytes(5000));
    const store = storeOf(h.session);
    // Un bit cambiado en el ciphertext del primer chunk: la cabecera vale, el tag no.
    const fd = openSync(store.partPath(id), 'r+');
    writeSync(fd, Buffer.from([0xff]), 0, 1, 200);
    closeSync(fd);
    insertRow(h.db(), { id });
    const report = await reconciler(h).run(ctxOf(h));
    expect(report.pendingDropped).toBe(1);
    expect(rowOf(h, id)).toBeUndefined();
    expect(existsSync(store.partPath(id))).toBe(false);
    expect(warn).toHaveBeenCalledWith('reconcile.pending.dropped', { mediaId: id });
  });

  it('un .part sin cabecera (bloqueo antes de finish) también se descarta', async () => {
    const h = await harness();
    const id = newId();
    const store = storeOf(h.session);
    mkdirSync(join(h.vaultDir, 'tmp'), { recursive: true });
    writeFileSync(store.partPath(id), Buffer.alloc(108 + 4096)); // 108 ceros de cabecera
    insertRow(h.db(), { id });
    await reconciler(h).run(ctxOf(h));
    expect(rowOf(h, id)).toBeUndefined();
    expect(existsSync(store.partPath(id))).toBe(false);
  });

  it('sin objeto ni .part → fila y miniatura borradas', async () => {
    const h = await harness();
    const id = newId();
    const thumbId = newId();
    await writeObject(h.session, thumbId, KIND_THUMB, randomBytes(200));
    insertRow(h.db(), { id, thumbId });
    await reconciler(h).run(ctxOf(h));
    expect(rowOf(h, id)).toBeUndefined();
    expect(existsSync(storeOf(h.session).thumbPath(thumbId))).toBe(false);
  });

  it('miniatura .part que no verifica → se borra y la fila queda ready sin ella (punto 3)', async () => {
    const h = await harness();
    const id = newId();
    const thumbId = newId();
    await writeObject(h.session, id, KIND_MEDIA, randomBytes(2000));
    const store = storeOf(h.session);
    writeFileSync(store.partPath(thumbId), Buffer.alloc(200));
    insertRow(h.db(), { id, thumbId });
    const report = await reconciler(h).run(ctxOf(h));
    expect(existsSync(store.partPath(thumbId))).toBe(false);
    expect(rowOf(h, id)?.state).toBe('ready');
    expect(rowOf(h, id)?.thumb_id).toBeNull();
    expect(report.missingThumbs).toEqual([id]);
  });
});

describe('punto 2: sustituciones a medias (import.replace.*)', () => {
  it('con la fila nueva: transacción B y borrado criptográfico de los objetos antiguos', async () => {
    const h = await harness();
    const old = await addReadyMedia(h.session);
    h.db()
      .prepare("UPDATE media SET name = 'Vacaciones', imported_at = 42 WHERE id = ?")
      .run(old.id);
    const hmac = randomBytes(32);
    h.db().prepare('UPDATE media SET content_hmac = ? WHERE id = ?').run(hmac, old.id);
    // Caída entre A y B: la fila nueva está pending con sus objetos ya renombrados.
    const fresh = newId();
    const freshThumb = newId();
    await writeObject(h.session, fresh, KIND_MEDIA, randomBytes(3000));
    await writeObject(h.session, freshThumb, KIND_THUMB, randomBytes(200));
    insertReplacing(
      h.db(),
      mediaRow({ id: fresh, thumbId: freshThumb, contentHmac: hmac }),
      null,
      old.id,
    );
    const store = storeOf(h.session);

    const report = await reconciler(h).run(ctxOf(h));
    expect(report.replacementsCompleted).toBe(1);
    expect(rowOf(h, old.id)).toBeUndefined();
    const row = rowOf(h, fresh);
    expect(row?.state).toBe('ready');
    expect(row?.name).toBe('Vacaciones');
    expect(kvGet(h.db(), importReplaceKey(fresh))).toBeNull();
    expect(existsSync(store.objectPath(old.id))).toBe(false);
    expect(existsSync(store.thumbPath(old.thumbId))).toBe(false);
    expect(existsSync(store.objectPath(fresh))).toBe(true);
  });

  it('sin la fila nueva: la antigua recupera su HMAC (desde el hex en minúsculas) y se borra la clave', async () => {
    const h = await harness();
    const old = await addReadyMedia(h.session);
    const hmac = randomBytes(32);
    h.db().prepare('UPDATE media SET content_hmac = ? WHERE id = ?').run(hmac, old.id);
    const fresh = newId();
    // Caída justo después de A: fila pending sin objeto ni .part → el punto 1 la borra.
    insertReplacing(h.db(), mediaRow({ id: fresh, contentHmac: hmac }), null, old.id);
    expect(
      (
        h.db().prepare('SELECT content_hmac FROM media WHERE id = ?').get(old.id) as {
          content_hmac: Buffer;
        }
      ).content_hmac.equals(hmac),
    ).toBe(false);

    const report = await reconciler(h).run(ctxOf(h));
    expect(report.replacementsUndone).toBe(1);
    const restored = h
      .db()
      .prepare('SELECT content_hmac, state FROM media WHERE id = ?')
      .get(old.id) as {
      content_hmac: Buffer;
      state: string;
    };
    expect(restored.state).toBe('ready');
    expect(restored.content_hmac.equals(hmac)).toBe(true);
    expect(rowOf(h, fresh)).toBeUndefined();
    expect(listImportReplacements(h.db())).toEqual([]);
  });

  it('un valor inválido se conserva y registra un error', async () => {
    const h = await harness();
    const errorLog = vi.spyOn(log, 'error');
    const key = importReplaceKey(newId());
    h.db().prepare('INSERT INTO kv (key, value_json) VALUES (?, ?)').run(key, '{"old":"nope"}');
    const report = await reconciler(h).run(ctxOf(h));
    expect(report.replacementsInvalid).toBe(1);
    expect(errorLog).toHaveBeenCalledWith('reconcile.replace.invalid', { stage: 'value' });
    expect(
      h.db().prepare('SELECT value_json FROM kv WHERE key = ?').get(key) as { value_json: string },
    ).toEqual({ value_json: '{"old":"nope"}' });
  });
});

describe('punto 3: miniaturas ausentes [H3-7]', () => {
  it('1000 filas y 37 ausentes: exactamente esas 37, ≤ 256 readdir y ningún stat por miniatura', async () => {
    const h = await harness();
    const db = h.db();
    const thumbsDir = join(h.vaultDir, 'thumbs');
    const missing = new Set<string>();
    const rows: { id: string; thumbId: string }[] = [];
    db.transaction(() => {
      for (let i = 0; i < 1000; i += 1) {
        const id = newId();
        const thumbId = newId();
        rows.push({ id, thumbId });
        insertRow(db, { id, thumbId }, { ready: true });
      }
    })();
    rows.forEach((r, i) => {
      if (i % 27 === 5 && missing.size < 37) {
        missing.add(r.id);
        return;
      }
      const shardDir = join(thumbsDir, r.thumbId.slice(0, 2));
      mkdirSync(shardDir, { recursive: true });
      writeFileSync(join(shardDir, r.thumbId), ''); // el punto 3 solo mira los nombres
    });
    expect(missing.size).toBe(37);

    const calls = { readdir: [] as string[], lstat: [] as string[] };
    const io: ReconcileIo = {
      readdir: (p) => {
        calls.readdir.push(p);
        return defaultReconcileIo.readdir(p);
      },
      lstat: (p) => {
        calls.lstat.push(p);
        return defaultReconcileIo.lstat(p);
      },
    };
    const report = await reconciler(h, { io }).run(ctxOf(h));

    expect(new Set(report.missingThumbs)).toEqual(missing);
    expect(report.missingThumbs).toHaveLength(37);
    const thumbReaddirs = calls.readdir.filter((p) => p.startsWith(thumbsDir));
    expect(thumbReaddirs.length).toBeLessThanOrEqual(256);
    expect(thumbReaddirs.length).toBe(SHARDS.length);
    expect(calls.lstat.filter((p) => p.startsWith(thumbsDir))).toEqual([]);
    const nulls = db
      .prepare("SELECT id FROM media WHERE state = 'ready' AND thumb_id IS NULL")
      .all() as { id: string }[];
    expect(new Set(nulls.map((r) => r.id))).toEqual(missing);
  });

  it('la cola de regeneración rehace en segundo plano la miniatura de una foto', async () => {
    const h = await harness();
    const id = newId();
    const lostThumb = newId();
    await writeObject(h.session, id, KIND_MEDIA, await pngBuffer());
    insertRow(h.db(), { id, thumbId: lostThumb }, { ready: true });
    const changed: unknown[] = [];
    const r = reconciler(h, {
      background: true,
      sweepIntervalMs: 0,
      library: { changed: (reason, ids) => changed.push({ reason, ids }) },
    });
    const report = await r.run(ctxOf(h));
    expect(report.missingThumbs).toEqual([id]);
    await r.backgroundIdle();
    const row = rowOf(h, id);
    expect(row?.thumb_id).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.thumb_id).not.toBe(lostThumb);
    expect(row?.thumb_rev).toBe(1);
    const store = storeOf(h.session);
    const keys = h.session.getKeyRing(h.session.epoch);
    const reader = await store.open(row?.thumb_id as string, KIND_THUMB, keys.kWrap);
    const webp = await reader.readAll();
    await reader.close();
    expect(webp.subarray(8, 12).toString('latin1')).toBe('WEBP');
    expect(changed).toEqual([{ reason: 'edit', ids: [id] }]);
  });
});

describe('punto 4: tmp/*.part', () => {
  it('se borran los .part que quedan (salvo los de inFlight)', async () => {
    const h = await harness();
    const store = storeOf(h.session);
    const a = newId();
    const b = newId();
    await writePart(h.session, a, KIND_MEDIA, randomBytes(100));
    await writePart(h.session, b, KIND_MEDIA, randomBytes(100));
    writeFileSync(join(h.vaultDir, 'tmp', 'otro.txt'), 'x');
    const release = h.inFlight.track(b);
    const report = await reconciler(h).run(ctxOf(h));
    release();
    expect(report.partsRemoved).toBe(1);
    expect(existsSync(store.partPath(a))).toBe(false);
    expect(existsSync(store.partPath(b))).toBe(true);
    expect(readFileSync(join(h.vaultDir, 'tmp', 'otro.txt'), 'utf8')).toBe('x');
  });
});

describe('punto 7: barrido de huérfanos', () => {
  it('borra los huérfanos, pero no un id de inFlight ni uno que la DB referencia en el último momento', async () => {
    const h = await harness();
    const shard = 'ab';
    const orphan = idInShard(shard);
    const tracked = idInShard(shard);
    const late = idInShard(shard);
    const kept = await addReadyMedia(h.session);
    for (const id of [orphan, tracked, late]) {
      await writeObject(h.session, id, KIND_MEDIA, randomBytes(100));
    }
    const lateThumb = idInShard('cd');
    const orphanThumb = idInShard('cd');
    await writeObject(h.session, lateThumb, KIND_THUMB, randomBytes(100));
    await writeObject(h.session, orphanThumb, KIND_THUMB, randomBytes(100));
    const release = h.inFlight.track(tracked);
    // Entre el readdir del barrido y el borrado llega un COMMIT que referencia `late` y `lateThumb`.
    const io: Partial<ReconcileIo> = {
      readdir: async (p) => {
        const names = await defaultReconcileIo.readdir(p);
        if (p.endsWith(join('objects', shard))) insertRow(h.db(), { id: late }, { ready: true });
        if (p.endsWith(join('thumbs', 'cd'))) {
          insertRow(h.db(), { id: newId(), thumbId: lateThumb }, { ready: true });
        }
        return names;
      },
    };
    const r = reconciler(h, { io });
    const epoch = h.session.epoch;
    const signal = h.session.getSessionSignal(epoch);
    const store = storeOf(h.session);
    expect(await r.sweepShard(epoch, 'objects', shard, signal)).toBe(1);
    expect(await r.sweepShard(epoch, 'thumbs', 'cd', signal)).toBe(1);
    release();
    expect(existsSync(store.objectPath(orphan))).toBe(false);
    expect(existsSync(store.objectPath(tracked))).toBe(true);
    expect(existsSync(store.objectPath(late))).toBe(true);
    expect(existsSync(store.thumbPath(lateThumb))).toBe(true);
    expect(existsSync(store.thumbPath(orphanThumb))).toBe(false);
    expect(existsSync(store.objectPath(kept.id))).toBe(true);
  });

  it('en segundo plano recorre los 512 directorios y se detiene al bloquear', async () => {
    const h = await harness();
    const orphan = newId();
    await writeObject(h.session, orphan, KIND_MEDIA, randomBytes(100));
    const r = reconciler(h, { background: true, sweepIntervalMs: 0 });
    await r.run(ctxOf(h));
    await r.backgroundIdle();
    expect(existsSync(storeOf(h.session).objectPath(orphan))).toBe(false);

    const r2 = reconciler(h, { background: true, sweepIntervalMs: 50 });
    await r2.run(ctxOf(h));
    const t0 = Date.now();
    await h.session.lock('suspend');
    await r2.backgroundIdle();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('enganche al desbloqueo (paso 6)', () => {
  it('el SessionManager reconcilia al volver a desbloquear y pausa/reanuda el fondo', async () => {
    const holder: { r: Reconciler | null } = { r: null };
    const inFlight = new InFlight();
    const h = await importHarness(tmp, {
      session: {
        reconcile: async (ctx) => {
          await holder.r?.run(ctx);
        },
      },
    });
    open.push(h);
    holder.r = new Reconciler({ session: h.session, inFlight, sweepIntervalMs: 0 });
    const id = newId();
    await writeObject(h.session, id, KIND_MEDIA, randomBytes(500));
    insertRow(h.db(), { id });
    await h.session.lock('manual');
    await h.unlock();
    expect(rowOf(h, id)?.state).toBe('ready');
    await holder.r.pauseBackground();
    holder.r.resumeBackground();
    await holder.r.backgroundIdle();
  });
});
