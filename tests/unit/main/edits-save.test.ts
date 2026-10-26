// edits:save (docs/DESIGN.md §16.5; PLAN.md 3.3) con perfil, bóveda, DB y SessionManager reales
// bajo tests/.tmp/ (KDF rápido), a través del wrapper real del IPC (register.ts, con ipcMain y la
// ventana simulados): validación zod, foto `ready`, trabajo `edit` (BUSY por medio), pasos 2–6
// (miniatura nueva con id nuevo, thumb_rev += 1, borrado criptográfico de la antigua tras el
// COMMIT), revertir, el original intacto en disco, bloqueo a mitad e INTEGRITY.
import { closeSync, existsSync, openSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Result } from '../../../src/shared/errors';
import { foldEdits, type EditState } from '../../../src/shared/edits';
import type { EditOp, LibraryChangeReason } from '../../../src/shared/types';
import { KIND_MEDIA, KIND_THUMB } from '../../../src/main/crypto/file-format';
import { getMedia } from '../../../src/main/db/repos/media-repo';
import { renderEdits } from '../../../src/main/media/edits-render';
import { getSharp } from '../../../src/main/media/sharp-loader';
import type { ThumbReplaceStep } from '../../../src/main/vault/thumb-replace';
import { Reconciler } from '../../../src/main/vault/reconcile';
import { importHarness, sha256File, vaultFiles, type ImportHarness } from '../helpers/import';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
import { insertRow, newId, storeOf, writeObject } from '../helpers/vault-fill';

type Listener = (event: unknown, payload: unknown) => Promise<Result<unknown>>;
const ipc = vi.hoisted(() => ({ handlers: new Map<string, Listener>() }));

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, fn: Listener) => ipc.handlers.set(channel, fn) },
}));
vi.mock('../../../src/main/window', () => ({
  getMainWindow: () => ({ webContents: { id: 1 } }),
  getRendererOrigin: () => 'app://bundle',
}));

const { setSessionGate } = await import('../../../src/main/ipc/register');
const { registerEditsHandlers } = await import('../../../src/main/ipc/handlers/edits');

vi.setConfig({ testTimeout: 30_000 });

const tmp = makeTmpDir('edits-save');
const open: ImportHarness[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  setSessionGate(null);
  ipc.handlers.clear();
  for (const h of open.splice(0)) await h.dispose();
});
afterAll(() => removeTmpDir(tmp));

const RED = { r: 220, g: 20, b: 20 };
const BLUE = { r: 20, g: 20, b: 220 };

/** Foto de 64×32: mitad izquierda roja y mitad derecha azul (asimétrica para los giros). */
async function photoPng(): Promise<Buffer> {
  const sharp = await getSharp();
  const left = await sharp({ create: { width: 32, height: 32, channels: 3, background: RED } })
    .png()
    .toBuffer();
  return sharp({ create: { width: 64, height: 32, channels: 3, background: BLUE } })
    .composite([{ input: left, left: 0, top: 0 }])
    .png()
    .toBuffer();
}

interface Ctx {
  h: ImportHarness;
  id: string;
  thumbId: string;
  library: { reason: LibraryChangeReason; ids?: readonly string[] }[];
  steps: { hook: ((s: ThumbReplaceStep) => void | Promise<void>) | null };
  render: { hook: ((buf: Buffer, s: EditState) => Promise<Buffer>) | null };
  invoke(payload: unknown): Promise<Result<unknown>>;
}

async function setup(): Promise<Ctx> {
  const h = await importHarness(tmp);
  open.push(h);
  const id = newId();
  const thumbId = newId();
  await writeObject(h.session, id, KIND_MEDIA, await photoPng());
  await writeObject(
    h.session,
    thumbId,
    KIND_THUMB,
    await renderEdits(await photoPng(), foldEdits([])),
  );
  insertRow(h.db(), { id, thumbId, width: 64, height: 32 }, { ready: true });
  const library: Ctx['library'] = [];
  const steps: Ctx['steps'] = { hook: null };
  const render: Ctx['render'] = { hook: null };
  registerEditsHandlers({
    session: h.session,
    inFlight: h.inFlight,
    library: { changed: (reason, ids) => library.push({ reason, ids }) },
    onStep: (s) => steps.hook?.(s),
    render: (buf, s) => (render.hook ? render.hook(buf, s) : renderEdits(buf, s)),
  });
  setSessionGate(h.session);
  const fn = ipc.handlers.get('edits:save') as Listener;
  return {
    h,
    id,
    thumbId,
    library,
    steps,
    render,
    invoke: (payload) =>
      fn({ sender: { id: 1 }, senderFrame: { url: 'app://bundle/index.html' } }, payload),
  };
}

function row(h: ImportHarness, id: string) {
  return h.db().prepare('SELECT thumb_id, thumb_rev FROM media WHERE id = ?').get(id) as {
    thumb_id: string | null;
    thumb_rev: number;
  };
}

function editRows(h: ImportHarness, id: string): EditOp[] {
  const rows = h
    .db()
    .prepare('SELECT op_json FROM media_edits WHERE media_id = ? ORDER BY seq')
    .all(id) as { op_json: string }[];
  return rows.map((r) => JSON.parse(r.op_json) as EditOp);
}

/** Descifra la miniatura y devuelve sus dimensiones y el color de dos píxeles. */
async function thumbInfo(h: ImportHarness, thumbId: string) {
  const keys = h.session.getKeyRing(h.session.epoch);
  const reader = await storeOf(h.session).open(thumbId, KIND_THUMB, keys.kWrap);
  const webp = await reader.readAll();
  await reader.close();
  const sharp = await getSharp();
  const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    return { r: data[i] as number, g: data[i + 1] as number, b: data[i + 2] as number };
  };
  return {
    width: info.width,
    height: info.height,
    first: px(0, 0),
    last: px(info.width - 1, info.height - 1),
  };
}

const isRed = (c: { r: number; b: number }) => c.r > 150 && c.b < 100;
const isBlue = (c: { r: number; b: number }) => c.b > 150 && c.r < 100;

function ok<T>(r: Result<unknown>): T {
  if (!r.ok) throw new Error(`esperaba ok: ${JSON.stringify(r.error)}`);
  return r.data as T;
}

const ROTATE_CROP: EditOp[] = [
  { t: 'rotate', q: 1 },
  { t: 'crop', x: 0, y: 0, w: 1, h: 0.5 },
];

describe('guardar y revertir', () => {
  it('guarda: filas de media_edits, thumb_rev + 1, miniatura con id nuevo y la antigua borrada', async () => {
    const c = await setup();
    const store = storeOf(c.h.session);
    const originalSha = sha256File(store.objectPath(c.id));
    const res = ok<{ edits: EditOp[]; thumbRev: number }>(
      await c.invoke({ mediaId: c.id, ops: ROTATE_CROP }),
    );
    expect(res).toEqual({ edits: ROTATE_CROP, thumbRev: 1 });
    expect(editRows(c.h, c.id)).toEqual(ROTATE_CROP);
    const r = row(c.h, c.id);
    expect(r.thumb_rev).toBe(1);
    expect(r.thumb_id).toMatch(/^[0-9a-f]{32}$/);
    expect(r.thumb_id).not.toBe(c.thumbId);
    // La antigua: borrado criptográfico tras el COMMIT; la nueva existe; sin .part.
    expect(existsSync(store.thumbPath(c.thumbId))).toBe(false);
    expect(existsSync(store.thumbPath(r.thumb_id as string))).toBe(true);
    expect(vaultFiles(c.h.vaultDir).tmp).toEqual([]);
    expect(c.h.inFlight.size).toBe(0);
    // La miniatura nueva aplica las ediciones: 64×32 girada a la derecha → 32×64, mitad de arriba
    // (la que era la mitad izquierda, roja) → 32×32 roja.
    const t = await thumbInfo(c.h, r.thumb_id as string);
    expect(t).toMatchObject({ width: 32, height: 32 });
    expect(isRed(t.first) && isRed(t.last)).toBe(true);
    // El original no cambia en disco.
    expect(sha256File(store.objectPath(c.id))).toBe(originalSha);
    expect(c.library).toEqual([{ reason: 'edit', ids: [c.id] }]);
    // media:get devuelve las operaciones (el renderer saca el EditState con foldEdits) y thumbRev.
    const detail = getMedia(c.h.db(), c.id);
    expect(detail?.edits).toEqual(ROTATE_CROP);
    expect(detail?.thumbRev).toBe(1);
  });

  it('revertir (ops: []) quita las ediciones, regenera la miniatura original y el original sigue igual', async () => {
    const c = await setup();
    const store = storeOf(c.h.session);
    const originalSha = sha256File(store.objectPath(c.id));
    ok(await c.invoke({ mediaId: c.id, ops: [{ t: 'flipH' }, ...ROTATE_CROP] }));
    const edited = row(c.h, c.id);
    expect(sha256File(store.objectPath(c.id))).toBe(originalSha);

    const res = ok<{ edits: EditOp[]; thumbRev: number }>(
      await c.invoke({ mediaId: c.id, ops: [] }),
    );
    expect(res).toEqual({ edits: [], thumbRev: 2 });
    expect(editRows(c.h, c.id)).toEqual([]);
    const r = row(c.h, c.id);
    expect(r.thumb_rev).toBe(2);
    expect(r.thumb_id).not.toBe(edited.thumb_id);
    expect(existsSync(store.thumbPath(edited.thumb_id as string))).toBe(false);
    // Aspecto original: 64×32, roja a la izquierda y azul a la derecha.
    const t = await thumbInfo(c.h, r.thumb_id as string);
    expect(t).toMatchObject({ width: 64, height: 32 });
    expect(isRed(t.first)).toBe(true);
    expect(isBlue(t.last)).toBe(true);
    expect(sha256File(store.objectPath(c.id))).toBe(originalSha);
    expect(vaultFiles(c.h.vaultDir).thumbs).toHaveLength(1);
    expect(getMedia(c.h.db(), c.id)?.edits).toEqual([]);
  });

  it('el volteo cambia de lado los colores (flipH: azul a la izquierda)', async () => {
    const c = await setup();
    ok(await c.invoke({ mediaId: c.id, ops: [{ t: 'flipH' }] }));
    const t = await thumbInfo(c.h, row(c.h, c.id).thumb_id as string);
    expect(t).toMatchObject({ width: 64, height: 32 });
    expect(isBlue(t.first)).toBe(true);
    expect(isRed(t.last)).toBe(true);
  });
});

describe('validación (§10.3) y reglas de §16.5 paso 1', () => {
  it('más de 64 operaciones → VALIDATION; 64 se aceptan', async () => {
    const c = await setup();
    const flips = (n: number): EditOp[] => Array.from({ length: n }, () => ({ t: 'flipH' }));
    const r = await c.invoke({ mediaId: c.id, ops: flips(65) });
    expect(r).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(row(c.h, c.id).thumb_rev).toBe(0);
    expect(
      ok<{ thumbRev: number }>(await c.invoke({ mediaId: c.id, ops: flips(64) })).thumbRev,
    ).toBe(1);
  });

  it('recorte fuera de rango, operación desconocida o clave extra → VALIDATION sin tocar nada', async () => {
    const c = await setup();
    const before = vaultFiles(c.h.vaultDir);
    for (const op of [
      { t: 'crop', x: 0.6, y: 0, w: 0.5, h: 1 },
      { t: 'crop', x: 0, y: 0.5, w: 1, h: 0.6 },
      { t: 'crop', x: -0.1, y: 0, w: 0.5, h: 1 },
      { t: 'crop', x: 0, y: 0, w: 0.005, h: 1 },
      { t: 'crop', x: 0, y: 0, w: 1.5, h: 1 },
      { t: 'crop', x: Number.NaN, y: 0, w: 0.5, h: 1 },
      { t: 'crop', x: 0, y: 0, w: 1 },
      { t: 'rotate', q: 4 },
      { t: 'rotate', q: 0 },
      { t: 'flipH', extra: true },
      { t: 'scale', k: 2 },
    ]) {
      const r = await c.invoke({ mediaId: c.id, ops: [op] });
      expect(r, JSON.stringify(op)).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    }
    expect(await c.invoke({ mediaId: 'x', ops: [] })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(await c.invoke({ mediaId: c.id, ops: [], extra: 1 })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    // Tolerancia 1e-9 en x + w ≤ 1.
    expect(
      (await c.invoke({ mediaId: c.id, ops: [{ t: 'crop', x: 0.5, y: 0, w: 0.5 + 5e-10, h: 1 }] }))
        .ok,
    ).toBe(true);
    expect(vaultFiles(c.h.vaultDir).objects).toEqual(before.objects);
  });

  it('un vídeo → VALIDATION; un id sin fila ready → NOT_FOUND', async () => {
    const c = await setup();
    const video = newId();
    await writeObject(c.h.session, video, KIND_MEDIA, Buffer.alloc(1000, 1));
    insertRow(
      c.h.db(),
      { id: video, kind: 'video', mime: 'video/mp4', originalExt: 'mp4', durationMs: 1000 },
      { ready: true },
    );
    expect(await c.invoke({ mediaId: video, ops: [{ t: 'flipH' }] })).toEqual({
      ok: false,
      error: { code: 'VALIDATION', details: { reason: 'not-photo' } },
    });
    expect(await c.invoke({ mediaId: newId(), ops: [] })).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(editRows(c.h, video)).toEqual([]);
  });

  it('edición concurrente del mismo medio → BUSY; otro medio sí puede editarse a la vez', async () => {
    const c = await setup();
    const other = newId();
    await writeObject(c.h.session, other, KIND_MEDIA, await photoPng());
    insertRow(c.h.db(), { id: other }, { ready: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inRender = new Promise<void>((r) => (entered = r));
    c.render.hook = async (buf, s) => {
      if (c.render.hook) {
        c.render.hook = null; // solo la primera llamada espera
        entered();
        await gate;
      }
      return renderEdits(buf, s);
    };
    const first = c.invoke({ mediaId: c.id, ops: [{ t: 'flipH' }] });
    await inRender;
    expect(await c.invoke({ mediaId: c.id, ops: [{ t: 'flipV' }] })).toEqual({
      ok: false,
      error: { code: 'BUSY' },
    });
    expect((await c.invoke({ mediaId: other, ops: [{ t: 'rotate', q: 2 }] })).ok).toBe(true);
    release();
    expect(ok<{ thumbRev: number }>(await first).thumbRev).toBe(1);
    expect(editRows(c.h, c.id)).toEqual([{ t: 'flipH' }]);
    // Al terminar, se puede volver a editar.
    expect((await c.invoke({ mediaId: c.id, ops: [] })).ok).toBe(true);
  });

  it('durante un traslado (maintenance) → BUSY', async () => {
    const c = await setup();
    setSessionGate({ isUnlocked: true, inMaintenance: true });
    expect(await c.invoke({ mediaId: c.id, ops: [] })).toEqual({
      ok: false,
      error: { code: 'BUSY' },
    });
  });

  it('bloqueada → LOCKED', async () => {
    const c = await setup();
    setSessionGate({ isUnlocked: false, inMaintenance: false });
    expect(await c.invoke({ mediaId: c.id, ops: [] })).toEqual({
      ok: false,
      error: { code: 'LOCKED' },
    });
  });
});

describe('fallos (tabla de §16.5): sin cambios y sin restos', () => {
  it('el original no descifra → INTEGRITY; ediciones y miniatura intactas, sin .part', async () => {
    const c = await setup();
    ok(await c.invoke({ mediaId: c.id, ops: [{ t: 'flipH' }] }));
    const saved = row(c.h, c.id);
    const store = storeOf(c.h.session);
    // Un bit cambiado en el primer chunk: la cabecera vale (DEK en caché incluida), el tag no.
    const fd = openSync(store.objectPath(c.id), 'r+');
    writeSync(fd, Buffer.from([0x5a]), 0, 1, 300);
    closeSync(fd);
    const before = vaultFiles(c.h.vaultDir);
    expect(await c.invoke({ mediaId: c.id, ops: ROTATE_CROP })).toEqual({
      ok: false,
      error: { code: 'INTEGRITY' },
    });
    expect(editRows(c.h, c.id)).toEqual([{ t: 'flipH' }]);
    expect(row(c.h, c.id)).toEqual(saved);
    expect(vaultFiles(c.h.vaultDir)).toEqual(before);
    expect(c.h.inFlight.size).toBe(0);
  });

  it('sharp no renderiza → INTERNAL, sin cambios', async () => {
    const c = await setup();
    c.render.hook = async () => {
      throw new Error('vips');
    };
    const before = vaultFiles(c.h.vaultDir);
    expect(await c.invoke({ mediaId: c.id, ops: [{ t: 'flipH' }] })).toEqual({
      ok: false,
      error: { code: 'INTERNAL', details: { reason: 'render' } },
    });
    expect(vaultFiles(c.h.vaultDir)).toEqual(before);
    expect(row(c.h, c.id)).toEqual({ thumb_id: c.thumbId, thumb_rev: 0 });
  });

  it('el medio se borra mientras se renderiza → NOT_FOUND y la miniatura nueva se borra', async () => {
    const c = await setup();
    c.steps.hook = (s) => {
      if (s === 'commit') c.h.db().prepare('DELETE FROM media WHERE id = ?').run(c.id);
    };
    expect(await c.invoke({ mediaId: c.id, ops: [{ t: 'flipH' }] })).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    const files = vaultFiles(c.h.vaultDir);
    expect(files.thumbs).toEqual([`${c.thumbId.slice(0, 2)}/${c.thumbId}`]); // solo la antigua
    expect(files.tmp).toEqual([]);
    expect(c.h.inFlight.size).toBe(0);
  });

  it('disco lleno al escribir la miniatura → DISK_FULL, sin .part ni cambios', async () => {
    const c = await setup();
    c.steps.hook = (s) => {
      if (s === 'promote') throw Object.assign(new Error('lleno'), { code: 'ENOSPC' });
    };
    expect(await c.invoke({ mediaId: c.id, ops: [{ t: 'flipH' }] })).toEqual({
      ok: false,
      error: { code: 'DISK_FULL' },
    });
    expect(vaultFiles(c.h.vaultDir).tmp).toEqual([]);
    expect(vaultFiles(c.h.vaultDir).thumbs).toHaveLength(1);
    expect(row(c.h, c.id)).toEqual({ thumb_id: c.thumbId, thumb_rev: 0 });
  });
});

describe('bloqueo a mitad (§16.5: LOCKED, sin cambios; la reconciliación limpia)', () => {
  async function reconcileAfterUnlock(c: Ctx): Promise<void> {
    await c.h.session.cleanup.idle();
    await c.h.unlock();
    const epoch = c.h.session.epoch;
    const r = new Reconciler({ session: c.h.session, inFlight: c.h.inFlight, sweepIntervalMs: 0 });
    await r.run({
      epoch,
      profileId: c.h.profileId,
      db: c.h.db(),
      vaultDir: c.h.vaultDir,
      signal: c.h.session.getSessionSignal(epoch),
    });
    await r.backgroundIdle();
  }

  it('bloqueo durante el render: claves a cero, sin objetos nuevos ni .part, ediciones intactas', async () => {
    const c = await setup();
    ok(await c.invoke({ mediaId: c.id, ops: [{ t: 'flipH' }] }));
    const saved = row(c.h, c.id);
    const before = vaultFiles(c.h.vaultDir);
    const keys = c.h.session.getKeyRing(c.h.session.epoch);
    const kWrap = keys.kWrap;
    c.render.hook = async (buf, s) => {
      await c.h.session.lock('suspend');
      return renderEdits(buf, s);
    };
    expect(await c.invoke({ mediaId: c.id, ops: ROTATE_CROP })).toEqual({
      ok: false,
      error: { code: 'LOCKED' },
    });
    expect(keys.zeroized).toBe(true);
    expect(kWrap.every((b) => b === 0)).toBe(true);
    await c.h.session.cleanup.idle();
    expect(vaultFiles(c.h.vaultDir)).toEqual(before);
    expect(c.h.inFlight.size).toBe(0);

    c.render.hook = null;
    await reconcileAfterUnlock(c);
    expect(editRows(c.h, c.id)).toEqual([{ t: 'flipH' }]);
    expect(row(c.h, c.id)).toEqual(saved);
    expect(vaultFiles(c.h.vaultDir)).toEqual(before);
  });

  it('bloqueo tras renombrar la miniatura nueva y antes del COMMIT: la borra el barrido', async () => {
    const c = await setup();
    const saved = row(c.h, c.id);
    const before = vaultFiles(c.h.vaultDir);
    c.steps.hook = async (s) => {
      if (s === 'commit') await c.h.session.lock('suspend');
    };
    expect(await c.invoke({ mediaId: c.id, ops: ROTATE_CROP })).toEqual({
      ok: false,
      error: { code: 'LOCKED' },
    });
    // [H3-6] Tras el abort no se toca thumbs/: la nueva (sin COMMIT, ya fuera de inFlight) sigue.
    const leftover = vaultFiles(c.h.vaultDir).thumbs.filter((t) => !before.thumbs.includes(t));
    expect(leftover).toHaveLength(1);
    expect(c.h.inFlight.size).toBe(0);

    c.steps.hook = null;
    await reconcileAfterUnlock(c);
    expect(vaultFiles(c.h.vaultDir)).toEqual(before); // huérfana borrada, la antigua sigue
    expect(editRows(c.h, c.id)).toEqual([]);
    expect(row(c.h, c.id)).toEqual(saved);
    expect(readdirSync(join(c.h.vaultDir, 'tmp'))).toEqual([]);
  });

  it('bloqueo mientras se escribe la miniatura: el .part desaparece', async () => {
    const c = await setup();
    const before = vaultFiles(c.h.vaultDir);
    c.steps.hook = async (s) => {
      if (s === 'promote') await c.h.session.lock('suspend');
    };
    expect(await c.invoke({ mediaId: c.id, ops: [{ t: 'flipV' }] })).toEqual({
      ok: false,
      error: { code: 'LOCKED' },
    });
    await c.h.session.cleanup.idle();
    expect(vaultFiles(c.h.vaultDir)).toEqual(before);
  });
});
