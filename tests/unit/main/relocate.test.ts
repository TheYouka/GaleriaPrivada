// Traslado de la bóveda, disco ausente y "Buscar la bóveda…" (docs/DESIGN.md §8.7; PLAN.md 2.11)
// con perfil, bóveda, DB y SessionManager reales bajo tests/.tmp/ (KDF rápido).
//
// Invariante principal: el traslado nunca deja ninguna bóveda sin referenciar. Una "caída" se simula
// con un punto de fallo que no vuelve nunca; después, otro SessionManager sobre la misma raíz (como
// tras reiniciar la app) tiene que abrir la bóveda que diga profiles.json con todo su contenido.
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AppErrorException } from '@shared/errors';
import type { RelocateDone, RelocateProgress } from '@shared/types';
import { KDF_FAST_TEST } from '../../../src/main/crypto/kdf';
import { listMedia } from '../../../src/main/db/repos/media-repo';
import { vaultHandlers } from '../../../src/main/ipc/handlers/vault';
import { AvatarTokens } from '../../../src/main/profiles/avatars';
import { ProfileService } from '../../../src/main/profiles/profile-service';
import { ProfileStore, vaultDirOf } from '../../../src/main/profiles/profile-store';
import { SessionManager } from '../../../src/main/session/session-manager';
import { PrefsStore } from '../../../src/main/settings/settings-store';
import {
  RELOCATE_FAULT_POINTS,
  RelocateService,
  defaultRelocateIo,
  type RelocateDeps,
  type RelocateFaultPoint,
  type RelocateIo,
  type RelocateProfiles,
  type RelocateSession,
} from '../../../src/main/vault/relocate';
import { defaultVaultDir, readVaultJson } from '../../../src/main/vault/vault-layout';
import { appErrorOf, isAllZero } from '../helpers/crypto';
import { importHarness, pw, type ImportHarness } from '../helpers/import';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';
import { addReadyMedia } from '../helpers/vault-fill';

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));
vi.mock('../../../src/main/window', () => ({
  getMainWindow: () => null,
  getRendererOrigin: () => 'app://bundle',
}));

vi.setConfig({ testTimeout: 30_000 });

const tmp = makeTmpDir('relocate');
const open: { h: ImportHarness; hangs: boolean }[] = [];

afterEach(async () => {
  for (const { h, hangs } of open.splice(0)) {
    // Con un punto que no vuelve, KeylessCleanup puede tener una tarea colgada para siempre.
    if (hangs) await h.session.lock('manual');
    else await h.dispose();
  }
});
afterAll(() => removeTmpDir(tmp));

interface Bench {
  h: ImportHarness;
  relocate: RelocateService;
  progress: RelocateProgress[];
  done: RelocateDone[];
  /** Se resuelve con el siguiente relocate:done. */
  nextDone(): Promise<RelocateDone>;
  /** SHA-256 de cada archivo de la bóveda original (ruta relativa → hex). */
  originals: Map<string, string>;
  /** Carpeta de destino elegida en el "diálogo". */
  target: string;
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Archivos de una bóveda que el traslado copia (sin tmp/ ni music/*.part) con su SHA-256. */
function vaultHashes(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (statSync(p).isDirectory()) {
        if (rel === 'tmp') continue;
        visit(p);
      } else if (!/^(library\.db-(wal|shm)|\.galeria-relocate-.*)$/.test(name)) {
        if (rel.startsWith('music') && name.endsWith('.part')) continue;
        if (rel.startsWith('tmp')) continue;
        out.set(rel, sha(p));
      }
    }
  };
  visit(dir);
  return out;
}

async function bench(
  opts: {
    io?: Partial<RelocateIo>;
    faults?: RelocateDeps['faults'];
    hangs?: boolean;
    /** Envuelve los perfiles o la sesión que ve el traslado (fallos inyectados). */
    profiles?: (real: ProfileService) => RelocateProfiles;
    session?: (real: SessionManager) => RelocateSession;
  } = {},
): Promise<Bench> {
  const h = await importHarness(tmp);
  open.push({ h, hangs: opts.hangs ?? false });
  // Contenido: 3 medios con objeto y miniatura, música en claro y un .part de música (no se copia).
  for (let i = 0; i < 3; i += 1) await addReadyMedia(h.session, randomBytes(70_000 + i));
  writeFileSync(join(h.vaultDir, 'music', `${'a'.repeat(32)}.mp3`), randomBytes(4000));
  writeFileSync(join(h.vaultDir, 'music', `${'b'.repeat(32)}.mp3.part`), randomBytes(100));
  const progress: RelocateProgress[] = [];
  const done: RelocateDone[] = [];
  let waiters: ((d: RelocateDone) => void)[] = [];
  const relocate = new RelocateService({
    dataRoot: h.root,
    session: opts.session?.(h.session) ?? h.session,
    profiles: opts.profiles?.(h.profiles) ?? h.profiles,
    events: {
      progress: (p) => progress.push(p),
      done: (d) => {
        done.push(d);
        const w = waiters;
        waiters = [];
        for (const r of w) r(d);
      },
    },
    io: opts.io,
    faults: opts.faults,
  });
  const target = join(h.root, '..', `destino-${randomBytes(4).toString('hex')}`);
  mkdirSync(target);
  // Antes de copiar, para comparar: el checkpoint del paso 3 puede cambiar library.db, así que su
  // SHA se toma después del traslado desde la bóveda de destino.
  const originals = vaultHashes(h.vaultDir);
  originals.delete('library.db');
  return {
    h,
    relocate,
    progress,
    done,
    nextDone: () => new Promise((resolve) => waiters.push(resolve)),
    originals,
    target,
  };
}

function handlersOf(b: Bench, folder: string | null) {
  return vaultHandlers({
    relocate: b.relocate,
    showOpenDialog: async () =>
      folder ? { canceled: false, filePaths: [folder] } : { canceled: true, filePaths: [] },
  });
}

/** Un punto de fallo que espera a que el test lo suelte (o que no vuelve nunca). */
function gate() {
  let release: () => void = () => undefined;
  const released = new Promise<void>((r) => {
    release = r;
  });
  let reached: () => void = () => undefined;
  const reachedP = new Promise<void>((r) => {
    reached = r;
  });
  return {
    released,
    release,
    reached: reachedP,
    hit: () => reached(),
  };
}

async function profileOf(b: Bench) {
  return b.h.profiles.storedProfile(b.h.profileId);
}

/** "Reinicio": otro SessionManager y otro ProfileService sobre la misma raíz. */
async function restartAndUnlock(b: Bench): Promise<{ count: number; vaultDir: string }> {
  const prefs = new PrefsStore(b.h.root);
  const store = new ProfileStore(b.h.root);
  const service = new ProfileService({
    dataRoot: b.h.root,
    store,
    prefs,
    tokens: new AvatarTokens(),
    session: { currentProfileId: null, lock: async () => undefined },
    isPackaged: false,
    chooseKdfParams: async () => ({ ...KDF_FAST_TEST }),
  });
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
  });
  await session.unlock(b.h.profileId, pw());
  try {
    const items = listMedia(session.getDb(session.epoch), {
      kind: 'all',
      sort: { field: 'imported', dir: 'asc' },
    });
    return { count: items.length, vaultDir: session.getVaultDir(session.epoch) };
  } finally {
    await session.lock('manual');
  }
}

/** Los objetos, miniaturas y música de `dir` son los originales, byte a byte. */
function expectOriginalContent(b: Bench, dir: string): void {
  const now = vaultHashes(dir);
  for (const [rel, hash] of b.originals) expect(now.get(rel), rel).toBe(hash);
}

describe('traslado completo', () => {
  it('copia verificada por SHA-256, cambia profiles.json, reabre la DB y borra la antigua', async () => {
    const b = await bench();
    const { h } = b;
    const oldDir = h.vaultDir;
    const handlers = handlersOf(b, b.target);
    const doneP = b.nextDone();
    const res = await handlers.relocate({ target: 'choose' });
    expect(res?.jobId).toMatch(/^[0-9a-f]{32}$/);
    const done = await doneP;
    expect(done.jobId).toBe(res?.jobId);
    expect(done.result.ok).toBe(true);

    const dest = join(b.target, `Galeria-${h.profileId.slice(0, 8)}`);
    if (done.result.ok) {
      expect(done.result.data.path).toBe(dest);
      expect(done.result.data.location).toBe('custom');
      expect(done.result.data.leftoverPath).toBeUndefined();
    }
    // Copia byte a byte (sin tmp/ ni music/*.part), con tmp/ vacía creada y sin el marcador.
    expectOriginalContent(b, dest);
    expect(existsSync(join(dest, 'music', `${'b'.repeat(32)}.mp3.part`))).toBe(false);
    expect(readdirSync(join(dest, 'tmp'))).toEqual([]);
    expect(readdirSync(dest).some((n) => n.startsWith('.galeria-relocate-'))).toBe(false);
    expect(existsSync(`${dest}.partial`)).toBe(false);
    // profiles.json: la nueva, sin pendingCleanup (la antigua se borró).
    const profile = await profileOf(b);
    expect(profile.vault).toEqual({ location: 'custom', path: dest });
    expect(existsSync(oldDir)).toBe(false);
    // La sesión sigue abierta en la nueva, fuera de mantenimiento.
    expect(h.session.getVaultDir(h.session.epoch)).toBe(dest);
    expect(h.session.inMaintenance).toBe(false);
    expect(listMedia(h.db(), { kind: 'all', sort: { field: 'name', dir: 'asc' } })).toHaveLength(3);
    // Progreso: nunca más de total, y el último marca el paso 5 (copied === total).
    expect(b.progress.length).toBeGreaterThan(0);
    for (const p of b.progress) expect(p.copiedBytes).toBeLessThanOrEqual(p.totalBytes);
    const last = b.progress.at(-1) as RelocateProgress;
    expect(last.copiedBytes).toBe(last.totalBytes);
    // Otro traslado ya no está BUSY.
    expect(() => h.session.startJob('import').done()).not.toThrow();

    // Volver a la ubicación predeterminada.
    const back = b.nextDone();
    await handlers.relocate({ target: 'default' });
    const done2 = await back;
    expect(done2.result.ok).toBe(true);
    expect((await profileOf(b)).vault).toEqual({ location: 'default' });
    expect(h.session.getVaultDir(h.session.epoch)).toBe(defaultVaultDir(h.root, h.profileId));
    expect(existsSync(dest)).toBe(false);
    expectOriginalContent(b, defaultVaultDir(h.root, h.profileId));
    const info = await handlers.getInfo();
    expect(info.location).toBe('default');
    expect(info.sizeBytes).toBeGreaterThan(200_000);
    expect(info.freeBytes).toBeGreaterThan(0);
  });

  it('una copia que no coincide → INTEGRITY, se borra el .partial y nada cambia', async () => {
    let partial = '';
    const b = await bench({
      faults: (point) => {
        if (point !== 'copied') return;
        const objects = join(partial, 'objects');
        const shard = readdirSync(objects)[0] as string;
        const file = readdirSync(join(objects, shard))[0] as string;
        appendFileSync(join(objects, shard, file), Buffer.from([1]));
      },
    });
    partial = `${join(b.target, `Galeria-${b.h.profileId.slice(0, 8)}`)}.partial`;
    const before = await profileOf(b);
    const doneP = b.nextDone();
    await handlersOf(b, b.target).relocate({ target: 'choose' });
    const done = await doneP;
    expect(done.result).toEqual({
      ok: false,
      error: { code: 'INTEGRITY', details: { reason: 'relocate-verify' } },
    });
    expect(existsSync(partial)).toBe(false);
    expect(readdirSync(b.target)).toEqual([]);
    expect((await profileOf(b)).vault).toEqual(before.vault);
    expectOriginalContent(b, b.h.vaultDir);
    expect(b.h.session.inMaintenance).toBe(false);
    expect(b.h.session.getVaultDir(b.h.session.epoch)).toBe(b.h.vaultDir);
    expect(listMedia(b.h.db(), { kind: 'all', sort: { field: 'name', dir: 'asc' } })).toHaveLength(
      3,
    );
  });
});

describe('cancelar', () => {
  it('antes del paso 5 deja todo como estaba y devuelve CANCELLED', async () => {
    const g = gate();
    let first = true;
    const b = await bench({
      faults: async (point) => {
        if (point === 'file-copied' && first) {
          first = false;
          g.hit();
          await g.released;
        }
      },
    });
    const before = await profileOf(b);
    const doneP = b.nextDone();
    const res = await handlersOf(b, b.target).relocate({ target: 'choose' });
    await g.reached;
    expect(b.h.session.inMaintenance).toBe(true);
    expect(b.h.session.getState()).toMatchObject({ maintenance: { jobId: res?.jobId } });
    b.relocate.cancel(res?.jobId as string);
    g.release();
    const done = await doneP;
    expect(done.result).toEqual({ ok: false, error: { code: 'CANCELLED' } });
    expect(readdirSync(b.target)).toEqual([]);
    expect((await profileOf(b)).vault).toEqual(before.vault);
    expectOriginalContent(b, b.h.vaultDir);
    expect(b.h.session.inMaintenance).toBe(false);
    expect(b.h.session.autoLockPauseReasons).not.toContain('maintenance');
    expect(listMedia(b.h.db(), { kind: 'all', sort: { field: 'name', dir: 'asc' } })).toHaveLength(
      3,
    );
  });

  it('desde el paso 5 se ignora y el traslado termina', async () => {
    const g = gate();
    const b = await bench({
      faults: async (point) => {
        if (point === 'renamed') {
          g.hit();
          await g.released;
        }
      },
    });
    const doneP = b.nextDone();
    const res = await handlersOf(b, b.target).relocate({ target: 'choose' });
    await g.reached;
    expect(() => b.relocate.cancel(res?.jobId as string)).not.toThrow();
    g.release();
    expect((await doneP).result.ok).toBe(true);
  });

  it('con otro jobId → NOT_FOUND', async () => {
    const b = await bench();
    expect((await appErrorOf(() => b.relocate.cancel('0'.repeat(32)))).code).toBe('NOT_FOUND');
  });
});

describe('caída simulada en cada tramo', () => {
  it.each(RELOCATE_FAULT_POINTS)(
    'caída en %s: queda referenciada la antigua o la nueva, nunca ninguna',
    async (point: RelocateFaultPoint) => {
      const g = gate();
      const b = await bench({
        hangs: true,
        faults: (p) => {
          if (p !== point) return;
          g.hit();
          return new Promise<void>(() => undefined); // el proceso "muere" aquí
        },
      });
      await handlersOf(b, b.target).relocate({ target: 'choose' });
      await g.reached;
      const profile = await profileOf(b);
      const referenced = vaultDirOf(b.h.root, profile);
      expect((await readVaultJson(referenced))?.profileId).toBe(b.h.profileId);
      expectOriginalContent(b, referenced);
      const after = await restartAndUnlock(b);
      expect(after.vaultDir).toBe(referenced);
      expect(after.count).toBe(3);
    },
  );
});

describe('bloqueo durante el traslado', () => {
  it('después del paso 6, con un removeVaultDir que no termina: claves a cero antes', async () => {
    const calls: string[] = [];
    let finished = false;
    const io: Partial<RelocateIo> = {
      removeVaultDir: (dir, id, mode, opts) => {
        calls.push(mode ?? 'vault');
        if (mode === 'vault') {
          return new Promise(() => undefined).then(() => {
            finished = true;
            return { removed: true, leftoverPath: null };
          });
        }
        return defaultRelocateIo.removeVaultDir(dir, id, mode, opts);
      },
    };
    const reached = gate();
    const b = await bench({
      io,
      hangs: true,
      faults: (p) => {
        if (p === 'reopened') reached.hit();
      },
    });
    const kWrap = b.h.session.getKeyRing(b.h.session.epoch).kWrap;
    const doneP = b.nextDone();
    await handlersOf(b, b.target).relocate({ target: 'choose' });
    await reached.reached;
    await vi.waitFor(() => expect(calls).toContain('vault'));
    const t0 = performance.now();
    await b.h.session.lock('manual');
    expect(performance.now() - t0).toBeLessThan(1500); // no espera los 2 s ni al borrado
    expect(isAllZero(kWrap)).toBe(true);
    expect(b.h.session.state).toBe('locked');
    expect(finished).toBe(false);
    // Desde el paso 6 la referencia es la nueva, con la antigua en pendingCleanup.
    const profile = await profileOf(b);
    expect(profile.vault.location).toBe('custom');
    expect(profile.vault.pendingCleanup).toBe(b.h.vaultDir);
    // Tras un bloqueo no llega relocate:done.
    const raced = await Promise.race([doneP, new Promise((r) => setTimeout(() => r('none'), 100))]);
    expect(raced).toBe('none');
  });

  it('antes del paso 5: el .partial se borra sin claves y sigue referenciada la antigua', async () => {
    const g = gate();
    const b = await bench({
      faults: async (point) => {
        if (point === 'file-copied') {
          g.hit();
          await g.released;
        }
      },
    });
    const before = await profileOf(b);
    await handlersOf(b, b.target).relocate({ target: 'choose' });
    await g.reached;
    await b.h.session.lock('suspend'); // pasos 1–4 síncronos
    expect(b.h.session.state).toBe('locked');
    g.release();
    await vi.waitFor(async () => {
      await b.h.session.cleanup.idle();
      expect(readdirSync(b.target)).toEqual([]);
    });
    expect((await profileOf(b)).vault).toEqual(before.vault);
    expect((await restartAndUnlock(b)).count).toBe(3);
  });
});

/**
 * updateVault con fallos inyectados por llamada: 'before' lanza sin escribir; 'after' escribe
 * profiles.json de verdad y después lanza (como writeFileAtomic si falla el fsync de la carpeta).
 */
function flakyProfiles(
  real: ProfileService,
  modeOf: (call: number) => 'before' | 'after' | null,
): RelocateProfiles {
  let call = 0;
  return {
    storedProfile: (id) => real.storedProfile(id),
    summarize: (p, s) => real.summarize(p, s),
    updateVault: async (id, update) => {
      const mode = modeOf(call);
      call += 1;
      if (mode === 'before') throw new AppErrorException({ code: 'IO' });
      const updated = await real.updateVault(id, update);
      if (mode === 'after') throw new AppErrorException({ code: 'IO' });
      return updated;
    },
  };
}

const destOf = (b: Bench): string => join(b.target, `Galeria-${b.h.profileId.slice(0, 8)}`);

describe('fallos en los pasos 6 y 7', () => {
  it('profiles.json se escribe y después lanza: confirmado, no se borra la referenciada', async () => {
    const b = await bench({
      profiles: (real) => flakyProfiles(real, (n) => (n === 0 ? 'after' : null)),
    });
    const { h } = b;
    const oldDir = h.vaultDir;
    const dest = destOf(b);
    const doneP = b.nextDone();
    await handlersOf(b, b.target).relocate({ target: 'choose' });
    const done = await doneP;
    expect(done.result.ok).toBe(true);
    if (done.result.ok) expect(done.result.data.leftoverPath).toBeUndefined();
    expect((await profileOf(b)).vault).toEqual({ location: 'custom', path: dest });
    expect((await readVaultJson(dest))?.profileId).toBe(h.profileId);
    expectOriginalContent(b, dest);
    expect(existsSync(oldDir)).toBe(false);
    expect(h.session.getVaultDir(h.session.epoch)).toBe(dest);
    expect(h.session.inMaintenance).toBe(false);
    await h.session.lock('manual');
    expect(await restartAndUnlock(b)).toEqual({ count: 3, vaultDir: dest });
  });

  it('y si la reescritura también falla: se conservan las dos y pendingCleanup la termina luego', async () => {
    let failing = true;
    const b = await bench({
      profiles: (real) => flakyProfiles(real, () => (failing ? 'after' : null)),
    });
    const { h } = b;
    const oldDir = h.vaultDir;
    const dest = destOf(b);
    const doneP = b.nextDone();
    await handlersOf(b, b.target).relocate({ target: 'choose' });
    const done = await doneP;
    expect(done.result.ok && done.result.data.leftoverPath).toBe(oldDir);
    expect((await profileOf(b)).vault).toEqual({
      location: 'custom',
      path: dest,
      pendingCleanup: oldDir,
    });
    expect((await readVaultJson(dest))?.profileId).toBe(h.profileId);
    expect((await readVaultJson(oldDir))?.profileId).toBe(h.profileId);
    expectOriginalContent(b, oldDir);
    await h.session.lock('manual');
    expect(await restartAndUnlock(b)).toEqual({ count: 3, vaultDir: dest });
    // pendingCleanup (al arrancar o al desbloquear) borra la antigua, nunca la referenciada.
    failing = false;
    await b.relocate.runPendingCleanup(h.profileId);
    expect(existsSync(oldDir)).toBe(false);
    expect((await profileOf(b)).vault).toEqual({ location: 'custom', path: dest });
    expect(await restartAndUnlock(b)).toEqual({ count: 3, vaultDir: dest });
  });

  it('profiles.json falla antes de escribirse: se borra el destino y la antigua sigue referenciada', async () => {
    const b = await bench({
      profiles: (real) => flakyProfiles(real, (n) => (n === 0 ? 'before' : null)),
    });
    const { h } = b;
    const before = await profileOf(b);
    const doneP = b.nextDone();
    await handlersOf(b, b.target).relocate({ target: 'choose' });
    expect((await doneP).result).toEqual({ ok: false, error: { code: 'IO' } });
    expect(readdirSync(b.target)).toEqual([]);
    expect((await profileOf(b)).vault).toEqual(before.vault);
    expectOriginalContent(b, h.vaultDir);
    expect(h.session.getVaultDir(h.session.epoch)).toBe(h.vaultDir);
    expect(h.session.inMaintenance).toBe(false);
    expect(listMedia(h.db(), { kind: 'all', sort: { field: 'name', dir: 'asc' } })).toHaveLength(3);
    await h.session.lock('manual');
    expect(await restartAndUnlock(b)).toEqual({ count: 3, vaultDir: h.vaultDir });
  });

  it('la DB no abre en el destino: profiles.json vuelve a la antigua y se borra el destino', async () => {
    const b = await bench({
      session: (real) => {
        const oldDir = real.getVaultDir(real.epoch);
        return new Proxy(real, {
          get(t, p) {
            if (p === 'reopenDb') {
              return (epoch: number, dir: string) => {
                if (dir !== oldDir) throw Object.assign(new Error('reopen'), { code: 'EIO' });
                t.reopenDb(epoch, dir);
              };
            }
            const v: unknown = Reflect.get(t, p, t);
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          },
        });
      },
    });
    const { h } = b;
    const doneP = b.nextDone();
    await handlersOf(b, b.target).relocate({ target: 'choose' });
    expect((await doneP).result).toEqual({ ok: false, error: { code: 'IO' } });
    expect((await profileOf(b)).vault).toEqual({ location: 'default' });
    expect(readdirSync(b.target)).toEqual([]);
    expectOriginalContent(b, h.vaultDir);
    expect(h.session.getVaultDir(h.session.epoch)).toBe(h.vaultDir);
    expect(h.session.inMaintenance).toBe(false);
    expect(listMedia(h.db(), { kind: 'all', sort: { field: 'name', dir: 'asc' } })).toHaveLength(3);
  });

  it('pendingCleanup no borra la antigua si la referenciada no es una bóveda de este perfil', async () => {
    const b = await bench();
    const { h } = b;
    await h.session.lock('manual');
    await h.profiles.updateVault(h.profileId, () => ({
      location: 'custom',
      path: join(b.target, 'no-existe'),
      pendingCleanup: h.vaultDir,
    }));
    await b.relocate.runPendingCleanup(h.profileId);
    expect((await readVaultJson(h.vaultDir))?.profileId).toBe(h.profileId);
    expectOriginalContent(b, h.vaultDir);
    expect((await profileOf(b)).vault.pendingCleanup).toBe(h.vaultDir);
  });
});

describe('validación (paso 1)', () => {
  it('trabajo activo → BUSY sin abrir el diálogo, y durante el traslado nada más arranca', async () => {
    const b = await bench();
    const job = b.h.session.startJob('import');
    let dialogs = 0;
    const handlers = vaultHandlers({
      relocate: b.relocate,
      showOpenDialog: async () => {
        dialogs += 1;
        return { canceled: false, filePaths: [b.target] };
      },
    });
    expect((await appErrorOf(() => handlers.relocate({ target: 'choose' }))).code).toBe('BUSY');
    expect(dialogs).toBe(0);
    job.done();

    const g = gate();
    const b2 = await bench({
      faults: async (p) => {
        if (p === 'copied') {
          g.hit();
          await g.released;
        }
      },
    });
    const doneP = b2.nextDone();
    await handlersOf(b2, b2.target).relocate({ target: 'choose' });
    await g.reached;
    expect((await appErrorOf(() => b2.h.session.startJob('import'))).code).toBe('BUSY');
    g.release();
    expect((await doneP).result.ok).toBe(true);
  });

  it('diálogo cancelado → null y la reserva se libera', async () => {
    const b = await bench();
    expect(await handlersOf(b, null).relocate({ target: 'choose' })).toBeNull();
    expect(() => b.h.session.startJob('import').done()).not.toThrow();
  });

  it('destino existente, dentro de la bóveda, sin espacio o ya en la predeterminada → sin cambios', async () => {
    const b = await bench();
    const h = handlersOf(b, b.target);
    mkdirSync(join(b.target, `Galeria-${b.h.profileId.slice(0, 8)}.partial`));
    expect(await appErrorOf(() => h.relocate({ target: 'choose' }))).toEqual({
      code: 'VALIDATION',
      reason: 'target-exists',
    });
    const inside = join(b.h.vaultDir, 'objects');
    expect(await appErrorOf(() => handlersOf(b, inside).relocate({ target: 'choose' }))).toEqual({
      code: 'VALIDATION',
      reason: 'inside-vault',
    });
    expect(await appErrorOf(() => h.relocate({ target: 'default' }))).toEqual({
      code: 'VALIDATION',
      reason: 'same-location',
    });
    const full = new RelocateService({
      dataRoot: b.h.root,
      session: b.h.session,
      profiles: b.h.profiles,
      events: { progress: () => undefined, done: () => undefined },
      io: { freeBytes: async () => 1000 },
    });
    const other = join(tmp, `otro-${randomBytes(4).toString('hex')}`);
    mkdirSync(other);
    const hf = vaultHandlers({
      relocate: full,
      showOpenDialog: async () => ({ canceled: false, filePaths: [other] }),
    });
    expect((await appErrorOf(() => hf.relocate({ target: 'choose' }))).code).toBe('DISK_FULL');
    expect(readdirSync(other)).toEqual([]);
    expect(b.h.session.inMaintenance).toBe(false);
    expect(() => b.h.session.startJob('import').done()).not.toThrow();
  });
});

describe('vault:locate (disco ausente) [H3-8]', () => {
  it('una carpeta de otro perfil → VAULT_UNAVAILABLE con details.path = la ruta configurada', async () => {
    const b = await bench();
    const { h } = b;
    const bea = await h.profiles.createProfile({
      name: 'Bea',
      avatar: { type: 'builtin', id: 'coral' },
      password: pw(),
      acknowledgeNoRecovery: true,
    });
    const configured = h.vaultDir;
    // Abierto → BUSY (no se cambia la ruta de una bóveda en uso).
    expect((await appErrorOf(() => b.relocate.locate(h.profileId, configured))).code).toBe('BUSY');
    await h.session.lock('manual');
    const locate = (folder: string) =>
      vaultHandlers({
        relocate: b.relocate,
        showOpenDialog: async () => ({ canceled: false, filePaths: [folder] }),
      }).locate({ profileId: h.profileId });
    const err = await appErrorOf(() => locate(defaultVaultDir(h.root, bea.id)));
    expect(err.code).toBe('VAULT_UNAVAILABLE');
    await expect(locate(defaultVaultDir(h.root, bea.id))).rejects.toMatchObject({
      error: { code: 'VAULT_UNAVAILABLE', details: { path: configured } },
    });
    // Una carpeta sin vault.json, tampoco.
    await expect(locate(b.target)).rejects.toMatchObject({
      error: { code: 'VAULT_UNAVAILABLE', details: { path: configured } },
    });
    expect((await profileOf(b)).vault).toEqual({ location: 'default' });
  });

  it('la bóveda movida a mano (otra letra de unidad) se encuentra y se desbloquea', async () => {
    const b = await bench();
    const { h } = b;
    await h.session.lock('manual');
    const moved = join(b.target, 'mi-boveda');
    renameSync(h.vaultDir, moved);
    expect((await appErrorOf(() => h.unlock())).code).toBe('VAULT_UNAVAILABLE');
    const summary = await vaultHandlers({
      relocate: b.relocate,
      showOpenDialog: async () => ({ canceled: false, filePaths: [moved] }),
    }).locate({ profileId: h.profileId });
    expect(summary?.id).toBe(h.profileId);
    expect(summary?.vaultStatus).toBe('ok');
    expect((await profileOf(b)).vault).toEqual({ location: 'custom', path: moved });
    await h.unlock();
    expect(h.session.getVaultDir(h.session.epoch)).toBe(moved);
    // Diálogo cancelado → null.
    await h.session.lock('manual');
    expect(
      await vaultHandlers({
        relocate: b.relocate,
        showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      }).locate({ profileId: h.profileId }),
    ).toBeNull();
  });
});

describe('pendingCleanup', () => {
  it('si el borrado de la antigua no termina: ok con leftoverPath, se conserva y se reintenta', async () => {
    let failOnce = true;
    const b = await bench({
      io: {
        removeVaultDir: (dir, id, mode, opts) => {
          if (mode === 'vault' && failOnce) {
            failOnce = false; // p. ej. un archivo bloqueado por el antivirus
            return Promise.resolve({ removed: false, leftoverPath: dir });
          }
          return defaultRelocateIo.removeVaultDir(dir, id, mode, opts);
        },
      },
    });
    const { h } = b;
    const oldDir = h.vaultDir;
    const doneP = b.nextDone();
    await handlersOf(b, b.target).relocate({ target: 'choose' });
    const done = await doneP;
    expect(done.result.ok && done.result.data.leftoverPath).toBe(oldDir);
    expect((await profileOf(b)).vault.pendingCleanup).toBe(oldDir);
    // Mientras quede, no empieza otro traslado... salvo que el reintento termine (este sí).
    await b.relocate.runPendingCleanup(h.profileId);
    expect(existsSync(oldDir)).toBe(false);
    expect((await profileOf(b)).vault.pendingCleanup).toBeUndefined();
  });

  it('archivos ajenos en la antigua: se dejan, se avisa con la ruta y pendingCleanup no se queda', async () => {
    const b = await bench();
    const oldDir = b.h.vaultDir;
    writeFileSync(join(oldDir, 'ajeno.txt'), 'del usuario');
    const doneP = b.nextDone();
    await handlersOf(b, b.target).relocate({ target: 'choose' });
    const done = await doneP;
    expect(done.result.ok && done.result.data.leftoverPath).toBe(oldDir);
    expect(readdirSync(oldDir)).toEqual(['ajeno.txt']);
    expect(readFileSync(join(oldDir, 'ajeno.txt'), 'utf8')).toBe('del usuario');
    expect((await profileOf(b)).vault.pendingCleanup).toBeUndefined();
  });
});
