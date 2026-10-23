// SessionManager (docs/DESIGN.md §13, [H3-6]) con fakes inyectados: la ventana es un registro de
// llamadas; el perfil, la bóveda y la DB son reales (KDF rápido) bajo tests/.tmp/.
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KIND_MEDIA, KIND_THUMB } from '../../../src/main/crypto/file-format';
import { KDF_FAST_TEST, deriveKek } from '../../../src/main/crypto/kdf';
import { openObject } from '../../../src/main/crypto/object-reader';
import { createObjectWriter } from '../../../src/main/crypto/object-writer';
import { log } from '../../../src/main/log';
import { AvatarTokens } from '../../../src/main/profiles/avatars';
import { ProfileService } from '../../../src/main/profiles/profile-service';
import { ProfileStore } from '../../../src/main/profiles/profile-store';
import {
  DRAIN_WAIT_MS,
  LOCK_WAIT_MS,
  SessionManager,
  VAULT_WATCH_MS,
  installLockTriggers,
  type LockTriggerEnv,
  type SessionDeps,
  type SessionUi,
} from '../../../src/main/session/session-manager';
import { PrefsStore } from '../../../src/main/settings/settings-store';
import { defaultVaultDir, tmpPartPath } from '../../../src/main/vault/vault-layout';
import { appErrorOf, isAllZero } from '../helpers/crypto';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

// Captura las DEKs sin ganchos en producción: la del writer es su primer randomOwned(32); la de un
// reader sin caché, la salida de takeOwned al desenvolverla.
const captured = vi.hoisted(() => ({ random32: [] as Buffer[], owned: [] as Buffer[] }));
vi.mock('../../../src/main/crypto/secure-buffer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/main/crypto/secure-buffer')>();
  return {
    ...mod,
    randomOwned: (n: number): Buffer => {
      const b = mod.randomOwned(n);
      if (n === 32) captured.random32.push(b);
      return b;
    },
    takeOwned: (src: Buffer): Buffer => {
      const b = mod.takeOwned(src);
      captured.owned.push(b);
      return b;
    },
  };
});

const tmp = makeTmpDir('session-manager');
afterAll(() => removeTmpDir(tmp));

const PASSWORD = 'contraseña larga';
const pw = (s = PASSWORD): Uint8Array => new TextEncoder().encode(s);
const FAKE_TIMERS: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
};

interface FakeUi extends SessionUi {
  calls: string[];
}

function fakeUi(): FakeUi {
  const calls: string[] = [];
  return {
    calls,
    sendLocking: (reason) => calls.push(`locking:${reason}`),
    hide: () => calls.push('hide'),
    sendLocked: (reason) => calls.push(`locked:${reason}`),
    replaceWindow: () => calls.push('replace'),
    setContentProtection: (on) => calls.push(`protect:${on}`),
  };
}

interface Setup {
  root: string;
  session: SessionManager;
  ui: FakeUi;
  service: ProfileService;
  prefs: PrefsStore;
  profileId: string;
  vaultDir: string;
  loadProfile: ReturnType<typeof vi.fn<SessionDeps['loadProfile']>>;
}

async function createProfile(service: ProfileService, name: string): Promise<string> {
  const summary = await service.createProfile({
    name,
    avatar: { type: 'builtin', id: 'aurora' },
    password: pw(),
    acknowledgeNoRecovery: true,
  });
  return summary.id;
}

async function setup(deps: Partial<SessionDeps> = {}): Promise<Setup> {
  const root = mkdtempSync(join(tmp, 'r-'));
  const prefs = new PrefsStore(root);
  const service = new ProfileService({
    dataRoot: root,
    store: new ProfileStore(root),
    prefs,
    tokens: new AvatarTokens(),
    session: { currentProfileId: null, lock: async () => undefined },
    isPackaged: false,
    chooseKdfParams: async () => ({ ...KDF_FAST_TEST }),
  });
  const profileId = await createProfile(service, 'Ana');
  const ui = fakeUi();
  const loadProfile = vi.fn<SessionDeps['loadProfile']>((id) => service.unlockTarget(id));
  const session = new SessionManager({
    loadProfile,
    readPrefs: (id) => prefs.get(id),
    ui,
    ...deps,
  });
  return {
    root,
    session,
    ui,
    service,
    prefs,
    profileId,
    vaultDir: defaultVaultDir(root, profileId),
    loadProfile,
  };
}

const newFileId = (): Buffer => randomBytes(16);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as { __galeriaLastZeroizeMs?: number }).__galeriaLastZeroizeMs;
});

describe('desbloqueo (§13.1)', () => {
  it('desbloquea: estado, época, DB y KeyRing; la contraseña queda a cero', async () => {
    const { session, profileId, ui } = await setup();
    expect(session.getState()).toEqual({ state: 'locked' });
    const password = pw();
    const { profile, prefs } = await session.unlock(profileId, password);
    expect(profile.id).toBe(profileId);
    expect(prefs.autoLockMinutes).toBe(5);
    expect(isAllZero(password)).toBe(true);
    expect(session.getState()).toEqual({ state: 'unlocked', profileId, maintenance: null });
    expect(session.getDb(session.epoch).prepare('SELECT count(*) FROM kv').pluck().get()).toBe(0);
    expect(session.getKeyRing().zeroized).toBe(false);
    expect(ui.calls).toEqual(['protect:true']); // D15 activado por defecto
    await session.lock('manual');
  });

  it('contraseña incorrecta → WRONG_PASSWORD, sigue bloqueada y sin llamadas a la ventana', async () => {
    const { session, profileId, ui } = await setup();
    const password = pw('otra contraseña');
    expect((await appErrorOf(() => session.unlock(profileId, password))).code).toBe(
      'WRONG_PASSWORD',
    );
    expect(isAllZero(password)).toBe(true);
    expect(session.state).toBe('locked');
    expect(ui.calls).toEqual([]);
    expect((await appErrorOf(() => session.getDb())).code).toBe('LOCKED');
  });

  it('[H3-8] bóveda ausente → VAULT_UNAVAILABLE con details.path = la ruta configurada', async () => {
    const { session, profileId, vaultDir } = await setup();
    renameSync(vaultDir, `${vaultDir}-fuera`);
    try {
      await session.unlock(profileId, pw());
      expect.unreachable();
    } catch (e) {
      expect((e as { error: unknown }).error).toEqual({
        code: 'VAULT_UNAVAILABLE',
        details: { path: vaultDir },
      });
    }
    expect(session.state).toBe('locked');
  });

  it('vault.json de otro perfil → VAULT_UNAVAILABLE', async () => {
    const { session, service, profileId, root } = await setup();
    const other = await createProfile(service, 'Bea');
    const mine = defaultVaultDir(root, profileId);
    renameSync(mine, `${mine}-x`);
    renameSync(defaultVaultDir(root, other), mine);
    expect((await appErrorOf(() => session.unlock(profileId, pw()))).code).toBe(
      'VAULT_UNAVAILABLE',
    );
  });

  it('perfil inexistente → PROFILE_NOT_FOUND', async () => {
    const { session } = await setup();
    expect(
      (await appErrorOf(() => session.unlock(randomBytes(16).toString('hex'), pw()))).code,
    ).toBe('PROFILE_NOT_FOUND');
  });

  it('desbloquear otro perfil bloquea antes el actual (manual)', async () => {
    const { session, service, profileId, ui } = await setup();
    const other = await createProfile(service, 'Bea');
    await session.unlock(profileId, pw());
    const firstRing = session.getKeyRing();
    await session.unlock(other, pw());
    expect(firstRing.zeroized).toBe(true);
    expect(ui.calls).toContain('locking:manual');
    expect(session.getState()).toMatchObject({ state: 'unlocked', profileId: other });
    await session.lock('manual');
  });

  it('un bloqueo durante Argon2 cancela el desbloqueo: LOCKED y la KEK a cero', async () => {
    let release: (kek: Buffer) => void = () => undefined;
    const derive = vi.fn<typeof deriveKek>(
      () =>
        new Promise<Buffer>((resolve) => {
          release = resolve;
        }),
    );
    const { session, profileId, ui } = await setup({ deriveKek: derive });
    const pending = session.unlock(profileId, pw());
    await vi.waitFor(() => expect(derive).toHaveBeenCalled());
    expect(session.state).toBe('unlocking');
    void session.lock('suspend');
    expect(session.state).toBe('locked');
    const kek = Buffer.alloc(32, 7);
    release(kek);
    expect((await appErrorOf(() => pending)).code).toBe('LOCKED');
    expect(isAllZero(kek)).toBe(true);
    expect(session.state).toBe('locked');
    expect(ui.calls).toEqual(['locking:suspend', 'hide', 'locked:suspend', 'replace']);
  });

  it('sin sesión: getDb, getKeyRing y startJob dan LOCKED', async () => {
    const { session } = await setup();
    expect((await appErrorOf(() => session.getDb())).code).toBe('LOCKED');
    expect((await appErrorOf(() => session.getKeyRing())).code).toBe('LOCKED');
    expect((await appErrorOf(() => session.startJob('import'))).code).toBe('LOCKED');
  });
});

describe('bloqueo (§13.3)', () => {
  it('lock(suspend) con un trabajo colgado: KeyRing, caché de DEKs y DEKs de writer y reader a cero ANTES de devolver', async () => {
    const { session, profileId, ui, vaultDir } = await setup({ exposeTestHooks: true });
    await session.unlock(profileId, pw());
    const ring = session.getKeyRing();
    const keys = [ring.mk, ring.kDb, ring.kWrap, ring.kDedup];
    expect(keys.some(isAllZero)).toBe(false);

    // Una DEK en la caché.
    const cached = randomBytes(32);
    const cachedOwned = Buffer.alloc(32);
    cached.copy(cachedOwned);
    ring.dekCache.set(newFileId(), Buffer.alloc(108, 1), cachedOwned);

    // Un reader abierto sin caché (su DEK sale de takeOwned).
    const thumbId = newFileId();
    const thumbPath = join(vaultDir, 'tmp', `${thumbId.toString('hex')}.obj`);
    const w0 = createObjectWriter({
      kind: KIND_THUMB,
      fileId: thumbId,
      kWrap: ring.kWrap,
      tmpPath: thumbPath,
    });
    await w0.write(randomBytes(70_000));
    await w0.finish();
    const ownedBefore = captured.owned.length;
    const reader = await openObject(thumbPath, { fileId: thumbId, kind: KIND_THUMB }, ring.kWrap);
    const readerDek = captured.owned[ownedBefore] as Buffer;
    expect(isAllZero(readerDek)).toBe(false);
    session.registerReader(reader, session.epoch);

    // Un trabajo colgado en un await que nunca se resuelve, con su writer registrado (sin signal:
    // la DEK la pone a cero el paso 4 de SessionManager, no el manejador del trabajo).
    const job = session.startJob('import');
    const fileId = newFileId();
    const partPath = tmpPartPath(vaultDir, fileId.toString('hex'));
    const before = captured.random32.length;
    const writer = createObjectWriter({
      kind: KIND_MEDIA,
      fileId,
      kWrap: ring.kWrap,
      tmpPath: partPath,
    });
    const writerDek = captured.random32[before] as Buffer;
    session.registerWriter(writer, partPath, job.epoch);
    await writer.write(randomBytes(200_000));
    expect(existsSync(partPath)).toBe(true);
    let finished = false;
    void (async () => {
      await new Promise<never>(() => undefined);
      finished = true;
    })();

    const promise = session.lock('suspend');
    // Comprobación síncrona, justo después de la llamada.
    expect(keys.every(isAllZero)).toBe(true);
    expect(ring.zeroized).toBe(true);
    expect(isAllZero(cachedOwned)).toBe(true);
    expect(ring.dekCache.size).toBe(0);
    expect(isAllZero(writerDek)).toBe(true);
    expect(isAllZero(readerDek)).toBe(true);
    expect(job.signal.aborted).toBe(true);
    expect(finished).toBe(false);
    expect(session.state).toBe('locked');
    expect(ui.calls.slice(1)).toEqual(['locking:suspend', 'hide', 'locked:suspend', 'replace']);
    expect(session.lastZeroizeMs).not.toBeNull();
    expect(session.lastZeroizeMs as number).toBeLessThan(200);
    expect((globalThis as { __galeriaLastZeroizeMs?: number }).__galeriaLastZeroizeMs).toBe(
      session.lastZeroizeMs,
    );
    await promise;

    // El writer y el reader están muertos; el .part se borra en segundo plano (sin claves).
    expect((await appErrorOf(() => writer.write(Buffer.from('x')))).code).toBe('LOCKED');
    expect((await appErrorOf(() => reader.readAll())).code).toBe('LOCKED');
    await session.cleanup.idle();
    expect(existsSync(partPath)).toBe(false);
    expect(finished).toBe(false);
  });

  it('lock(manual) espera como mucho 2 s a los trabajos (reloj falso)', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const { session, profileId, ui } = await setup();
    await session.unlock(profileId, pw());
    const mk = session.getKeyRing().mk;
    session.startJob('import'); // nunca llama a done()
    let resolved = false;
    const promise = session.lock('manual').then(() => {
      resolved = true;
    });
    expect(session.state).toBe('locking');
    expect(isAllZero(mk)).toBe(false); // la UI ya está tapada; las claves, durante la espera
    expect(ui.calls).toEqual(['protect:true', 'locking:manual']);
    await vi.advanceTimersByTimeAsync(LOCK_WAIT_MS - 1);
    expect(isAllZero(mk)).toBe(false);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(isAllZero(mk)).toBe(true);
    await promise;
    expect(resolved).toBe(true);
    expect(session.state).toBe('locked');
    expect(ui.calls.slice(-2)).toEqual(['locked:manual', 'replace']);
  });

  it('lock(manual) termina antes si los trabajos abortados llaman a done()', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const { session, profileId } = await setup();
    await session.unlock(profileId, pw());
    const mk = session.getKeyRing().mk;
    const job = session.startJob('merge');
    job.signal.addEventListener('abort', () => setTimeout(() => job.done(), 300));
    const promise = session.lock('inactivity');
    await vi.advanceTimersByTimeAsync(299);
    expect(isAllZero(mk)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(isAllZero(mk)).toBe(true);
    await promise;
  });

  it('un suspend durante la espera de un bloqueo manual pone las claves a cero al momento', async () => {
    vi.useFakeTimers(FAKE_TIMERS);
    const { session, profileId, ui } = await setup();
    await session.unlock(profileId, pw());
    const mk = session.getKeyRing().mk;
    session.startJob('import');
    const manual = session.lock('manual');
    await vi.advanceTimersByTimeAsync(500);
    expect(isAllZero(mk)).toBe(false);
    const suspend = session.lock('suspend');
    expect(isAllZero(mk)).toBe(true);
    expect(session.state).toBe('locked');
    expect(suspend).toBe(manual);
    expect(ui.calls).toContain('hide');
    await manual;
  });

  it('sin trabajos, lock(manual) también es síncrono', async () => {
    const { session, profileId } = await setup();
    await session.unlock(profileId, pw());
    const mk = session.getKeyRing().mk;
    void session.lock('manual');
    expect(isAllZero(mk)).toBe(true);
    expect(session.state).toBe('locked');
  });

  it('shutdown: sin sustituir la ventana', async () => {
    const { session, profileId, ui } = await setup();
    await session.unlock(profileId, pw());
    await session.lock('shutdown');
    expect(ui.calls).toEqual(['protect:true', 'locking:shutdown', 'locked:shutdown']);
  });

  it('bloquear sin sesión no hace nada', async () => {
    const { session, ui } = await setup();
    await session.lock('suspend');
    expect(ui.calls).toEqual([]);
  });

  it('registrar un writer sin sesión: destroyKeys() y LOCKED', async () => {
    const { session } = await setup();
    const writer = { destroyKeys: vi.fn() };
    expect(
      (await appErrorOf(() => session.registerWriter(writer as never, undefined, 1))).code,
    ).toBe('LOCKED');
    expect(writer.destroyKeys).toHaveBeenCalled();
  });
});

describe('épocas y drained() [H3-6]', () => {
  beforeEach(() => {
    vi.useFakeTimers(FAKE_TIMERS);
  });

  it('un trabajo de la época 1 que pide getDb(1) tras desbloquear la época 2 recibe LOCKED; el desbloqueo espera 5 s y sigue con un warn', async () => {
    const { session, profileId, loadProfile } = await setup();
    await session.unlock(profileId, pw());
    const job = session.startJob('import'); // colgado: nunca llama a done()
    const e1 = job.epoch;
    expect(session.getDb(e1)).toBe(session.getDb());
    await session.lock('suspend');
    expect((await appErrorOf(() => session.getDb(e1))).code).toBe('LOCKED');

    const warn = vi.spyOn(log, 'warn');
    loadProfile.mockClear();
    const unlocking = session.unlock(profileId, pw());
    await vi.advanceTimersByTimeAsync(DRAIN_WAIT_MS - 1);
    expect(session.state).toBe('unlocking');
    expect(loadProfile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await unlocking;
    expect(loadProfile).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('session.drain-timeout', { count: 1 });

    const e2 = session.epoch;
    expect(e2).toBeGreaterThan(e1);
    expect((await appErrorOf(() => session.getDb(e1))).code).toBe('LOCKED');
    expect((await appErrorOf(() => session.getKeyRing(e1))).code).toBe('LOCKED');
    expect(session.getDb(e2)).toBe(session.getDb());
    expect(job.signal.aborted).toBe(true);
    await session.lock('manual');
  });

  it('si los trabajos de la sesión anterior terminan antes, el desbloqueo sigue sin warn', async () => {
    const { session, profileId, loadProfile } = await setup();
    await session.unlock(profileId, pw());
    const job = session.startJob('merge');
    await session.lock('os-lock');
    const warn = vi.spyOn(log, 'warn');
    loadProfile.mockClear();
    const unlocking = session.unlock(profileId, pw());
    await vi.advanceTimersByTimeAsync(1000);
    expect(loadProfile).not.toHaveBeenCalled();
    job.done();
    await unlocking;
    expect(loadProfile).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith('session.drain-timeout', expect.anything());
    await session.lock('manual');
  });
});

describe('auto-bloqueo y vigilante (§13.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers(FAKE_TIMERS);
  });

  it('inactividad: bloquea a los autoLockMinutes (o GALERIA_TEST_AUTOLOCK_MS en E2E)', async () => {
    const { session, profileId, ui } = await setup({ testAutoLockMs: 1000 });
    await session.unlock(profileId, pw());
    await vi.advanceTimersByTimeAsync(600);
    session.activity();
    await vi.advanceTimersByTimeAsync(999);
    expect(session.state).toBe('unlocked');
    await vi.advanceTimersByTimeAsync(1);
    expect(session.state).toBe('locked');
    expect(ui.calls).toContain('locking:inactivity');
  });

  it('D12: setPlayback(true) pausa el temporizador y al quitarse empieza desde cero', async () => {
    const { session, profileId } = await setup({ testAutoLockMs: 1000 });
    await session.unlock(profileId, pw());
    session.setPlayback(true);
    expect(session.autoLockPauseReasons).toEqual(['playback']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.state).toBe('unlocked');
    session.setPlayback(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(session.state).toBe('unlocked');
    await vi.advanceTimersByTimeAsync(1);
    expect(session.state).toBe('locked');
  });

  it("D18: un trabajo con setPausesAutoLock(true) pausa con el motivo 'job'", async () => {
    const { session, profileId } = await setup({ testAutoLockMs: 1000 });
    await session.unlock(profileId, pw());
    const merge = session.startJob('merge');
    merge.setPausesAutoLock(true);
    expect(session.autoLockPauseReasons).toEqual(['job']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.state).toBe('unlocked');
    merge.done();
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.state).toBe('locked');
  });

  it('autoLockMinutes = 0 lo desactiva también con el tiempo de test', async () => {
    const { session, profileId, prefs } = await setup({ testAutoLockMs: 1000 });
    await prefs.set(profileId, { autoLockMinutes: 0 });
    await session.unlock(profileId, pw());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.state).toBe('unlocked');
    expect(session.autoLockRunning).toBe(false);
    await session.lock('manual');
  });

  it('applyPrefs cambia el tiempo y la protección de contenido al momento (D15)', async () => {
    const { session, profileId, prefs, ui } = await setup();
    await prefs.set(profileId, { autoLockMinutes: 60 });
    await session.unlock(profileId, pw());
    session.applyPrefs(
      await prefs.set(profileId, { autoLockMinutes: 1, contentProtection: false }),
    );
    expect(ui.calls).toContain('protect:false');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.state).toBe('locked');
  });

  it('vigilante: si vault.json deja de responder, bloquea con vault-unavailable', async () => {
    let available = true;
    const { session, profileId, ui } = await setup({
      statVaultJson: async () => {
        if (!available) throw Object.assign(new Error('x'), { code: 'ENOENT' });
      },
    });
    await session.unlock(profileId, pw());
    await vi.advanceTimersByTimeAsync(VAULT_WATCH_MS);
    expect(session.state).toBe('unlocked');
    available = false;
    await vi.advanceTimersByTimeAsync(VAULT_WATCH_MS);
    expect(session.state).toBe('locked');
    expect(ui.calls).toContain('locking:vault-unavailable');
  });
});

describe('disparadores (§13.2, §21.1)', () => {
  function env(): {
    env: LockTriggerEnv;
    power: EventEmitter;
    app: EventEmitter & { quit: ReturnType<typeof vi.fn> };
    proc: EventEmitter;
    dialog: { showMessageBox: ReturnType<typeof vi.fn> };
  } {
    const power = Object.assign(new EventEmitter(), { getSystemIdleState: () => 'active' });
    const app = Object.assign(new EventEmitter(), { quit: vi.fn() });
    const proc = new EventEmitter();
    const dialog = { showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })) };
    return {
      env: {
        app: app as never,
        powerMonitor: power as never,
        dialog: dialog as never,
        platform: 'win32',
        proc: proc as never,
      },
      power,
      app,
      proc,
      dialog,
    };
  }

  it('suspend y lock-screen bloquean al momento', async () => {
    const { session, profileId } = await setup();
    const t = env();
    installLockTriggers(session, t.env);
    await session.unlock(profileId, pw());
    const mk = session.getKeyRing().mk;
    t.power.emit('suspend');
    expect(isAllZero(mk)).toBe(true);
    await session.unlock(profileId, pw());
    t.power.emit('lock-screen');
    expect(session.state).toBe('locked');
  });

  it('before-quit: impide la salida, bloquea (shutdown) y vuelve a salir', async () => {
    const { session, profileId, ui } = await setup();
    const t = env();
    installLockTriggers(session, t.env);
    await session.unlock(profileId, pw());
    const event = { preventDefault: vi.fn() };
    t.app.emit('before-quit', event);
    expect(event.preventDefault).toHaveBeenCalled();
    await vi.waitFor(() => expect(t.app.quit).toHaveBeenCalled());
    expect(session.state).toBe('locked');
    expect(ui.calls).not.toContain('replace');
    const again = { preventDefault: vi.fn() };
    t.app.emit('before-quit', again);
    expect(again.preventDefault).not.toHaveBeenCalled();
  });

  it('una excepción no controlada bloquea (error) y muestra el diálogo nativo', async () => {
    const { session, profileId } = await setup();
    const t = env();
    installLockTriggers(session, t.env);
    await session.unlock(profileId, pw());
    t.proc.emit('uncaughtException', new Error('C:\\ruta\\secreta'));
    expect(session.state).toBe('locked');
    expect(t.dialog.showMessageBox).toHaveBeenCalledTimes(1);
    expect(t.dialog.showMessageBox.mock.calls[0]?.[0]).toMatchObject({
      message: 'Se produjo un error inesperado; la bóveda se ha bloqueado.',
    });
    // Ya bloqueada: solo se registra.
    t.proc.emit('unhandledRejection', new Error('x'));
    expect(t.dialog.showMessageBox).toHaveBeenCalledTimes(1);
  });
});
