// Servicio de perfiles (docs/DESIGN.md §6.6, §14.4 y §21.1, [H3-8]) con KDF rápido bajo tests/.tmp/.
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { KDF_FAST_TEST, deriveKek } from '../../../src/main/crypto/kdf';
import { deriveKeys, unwrapMasterKey } from '../../../src/main/crypto/keys';
import { closeDatabase, openDatabase } from '../../../src/main/db/database';
import { KV_DEFAULT_TRACKS, kvGet, kvSet } from '../../../src/main/db/repos/kv-repo';
import { log } from '../../../src/main/log';
import { AvatarTokens, avatarFilePath } from '../../../src/main/profiles/avatars';
import {
  ProfileService,
  type ProfileServiceDeps,
} from '../../../src/main/profiles/profile-service';
import {
  ProfileStore,
  kdfParamsOf,
  masterKeyWrapOf,
  saltOf,
  type StoredProfile,
} from '../../../src/main/profiles/profile-store';
import { PrefsStore } from '../../../src/main/settings/settings-store';
import {
  creatingVaultDir,
  defaultVaultDir,
  vaultPaths,
} from '../../../src/main/vault/vault-layout';
import { appErrorOf, isAllZero } from '../helpers/crypto';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

// Captura la MK (generateMasterKey) y las claves derivadas (deriveKeys) para comprobar que quedan a
// cero también en las rutas de error.
const captured = vi.hoisted(() => ({ mks: [] as Buffer[], derived: [] as Buffer[] }));
vi.mock('../../../src/main/crypto/keys', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/main/crypto/keys')>();
  return {
    ...mod,
    generateMasterKey: (): Buffer => {
      const mk = mod.generateMasterKey();
      captured.mks.push(mk);
      return mk;
    },
    deriveKeys: (mk: Buffer, profileId: string) => {
      const keys = mod.deriveKeys(mk, profileId);
      captured.derived.push(keys.kDb, keys.kWrap, keys.kDedup);
      return keys;
    },
  };
});

const tmp = makeTmpDir('profile-service');
afterAll(() => removeTmpDir(tmp));
afterEach(() => vi.restoreAllMocks());

const PASSWORD = 'contraseña larga';
const pw = (s = PASSWORD): Uint8Array => new TextEncoder().encode(s);

interface Ctx {
  root: string;
  service: ProfileService;
  store: ProfileStore;
  prefs: PrefsStore;
  tokens: AvatarTokens;
  session: { currentProfileId: string | null; lock: ReturnType<typeof vi.fn> };
  keks: Buffer[];
}

function context(overrides: Partial<ProfileServiceDeps> = {}, root?: string): Ctx {
  const dataRoot = root ?? mkdtempSync(join(tmp, 'r-'));
  const store = new ProfileStore(dataRoot);
  const prefs = new PrefsStore(dataRoot);
  const tokens = new AvatarTokens();
  const session = { currentProfileId: null as string | null, lock: vi.fn(async () => undefined) };
  const keks: Buffer[] = [];
  const service = new ProfileService({
    dataRoot,
    store,
    prefs,
    tokens,
    session,
    isPackaged: false,
    chooseKdfParams: async () => ({ ...KDF_FAST_TEST }),
    deriveKek: async (password, salt, params) => {
      const kek = await deriveKek(password, salt, params);
      keks.push(kek);
      return kek;
    },
    ...overrides,
  });
  return { root: dataRoot, service, store, prefs, tokens, session, keks };
}

async function create(ctx: Ctx, name = 'Ana', password = pw()): Promise<string> {
  return (
    await ctx.service.createProfile({
      name,
      avatar: { type: 'builtin', id: 'aurora' },
      password,
      acknowledgeNoRecovery: true,
    })
  ).id;
}

/** Lista de archivos (rutas relativas) y su SHA-256, para comprobar que nada cambia. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

async function stored(ctx: Ctx, id: string): Promise<StoredProfile> {
  return (await ctx.store.find(id)) as StoredProfile;
}

/** Abre la DB del perfil con la contraseña dada, como haría el desbloqueo. */
async function openWith(ctx: Ctx, id: string, password: Uint8Array) {
  const p = await stored(ctx, id);
  const kek = await deriveKek(password, saltOf(p), kdfParamsOf(p));
  const mk = unwrapMasterKey(masterKeyWrapOf(p), kek, id, kdfParamsOf(p), saltOf(p));
  const { kDb } = deriveKeys(mk, id);
  const path = vaultPaths(defaultVaultDir(ctx.root, id)).db;
  return { db: openDatabase(path, kDb, { creating: false }), mk };
}

describe('createProfile (§14.4)', () => {
  it('crea la bóveda, profiles.json y su .bak; la contraseña, la KEK, la MK y K_db quedan a cero', async () => {
    const ctx = context();
    const password = pw();
    const mksBefore = captured.mks.length;
    const summary = await ctx.service.createProfile({
      name: '  A\u0301lbum  ',
      avatar: { type: 'builtin', id: 'sol' },
      password,
      acknowledgeNoRecovery: true,
    });
    expect(summary).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      name: 'Álbum',
      avatar: { type: 'builtin', id: 'sol' },
      vaultStatus: 'ok',
      themeId: null,
    });
    const vault = defaultVaultDir(ctx.root, summary.id);
    for (const sub of ['objects', 'thumbs', 'tmp', 'music']) {
      expect(statSync(join(vault, sub)).isDirectory()).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(vault, 'vault.json'), 'utf8')).profileId).toBe(summary.id);
    expect(existsSync(join(vault, 'library.db'))).toBe(true);
    expect(existsSync(creatingVaultDir(ctx.root, summary.id))).toBe(false);
    expect(readFileSync(ctx.store.bakPath, 'utf8')).toBe(readFileSync(ctx.store.path, 'utf8'));
    const p = await stored(ctx, summary.id);
    expect(p.vault).toEqual({ location: 'default' });
    expect(p.kdf).toMatchObject({ alg: 'argon2id', version: 19, memoryKiB: 8192 });
    expect(isAllZero(password)).toBe(true);
    expect(ctx.keks.every(isAllZero)).toBe(true);
    expect(captured.mks.slice(mksBefore).every(isAllZero)).toBe(true);
    // La DB abre con la contraseña y está migrada.
    const { db } = await openWith(ctx, summary.id, pw());
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    closeDatabase(db);
  });

  it.each([2, 3, 4, 5, 6, 7] as const)(
    'un fallo inyectado en el paso %i no deja carpeta ni avatar, no cambia profiles.json y deja las claves a cero',
    async (failAt) => {
      let armed = false;
      const ctx = context({
        beforeCreateStep: (step) => {
          if (armed && step === failAt) throw Object.assign(new Error('fallo'), { code: 'EIO' });
        },
      });
      const existing = await create(ctx, 'Existente');
      armed = true;
      const profilesBefore = readFileSync(ctx.store.path, 'utf8');
      const vaultsBefore = readdirSync(join(ctx.root, 'vaults')).sort();
      // Avatar personalizado para comprobar que tampoco queda avatars/<id>.webp.
      const token = ctx.tokens.issue(Buffer.from('RIFF0000WEBPVP8 '));
      const password = pw();
      const mksBefore = captured.mks.length;
      const derivedBefore = captured.derived.length;
      const keksBefore = ctx.keks.length;
      const err = await appErrorOf(() =>
        ctx.service.createProfile({
          name: 'Nuevo',
          avatar: { type: 'custom', token },
          password,
          acknowledgeNoRecovery: true,
        }),
      );
      expect(err.code).toBe('IO');
      expect(readdirSync(join(ctx.root, 'vaults')).sort()).toEqual(vaultsBefore);
      expect(readFileSync(ctx.store.path, 'utf8')).toBe(profilesBefore);
      expect(readFileSync(ctx.store.bakPath, 'utf8')).toBe(profilesBefore);
      const avatars = existsSync(join(ctx.root, 'avatars'))
        ? readdirSync(join(ctx.root, 'avatars'))
        : [];
      expect(avatars).toEqual([]);
      expect(isAllZero(password)).toBe(true);
      expect(ctx.keks.slice(keksBefore).every(isAllZero)).toBe(true);
      expect(captured.mks.slice(mksBefore).every(isAllZero)).toBe(true);
      expect(captured.derived.slice(derivedBefore).every(isAllZero)).toBe(true);
      expect(ctx.tokens.peek(token)).not.toBeNull(); // se puede reintentar con el mismo avatar
      expect((await ctx.store.read()).profiles.map((p) => p.id)).toEqual([existing]);
    },
  );

  it('ENOSPC → DISK_FULL', async () => {
    const ctx = context({
      beforeCreateStep: (step) => {
        if (step === 4) throw Object.assign(new Error('x'), { code: 'ENOSPC' });
      },
    });
    expect((await appErrorOf(() => create(ctx))).code).toBe('DISK_FULL');
  });

  it('una caída antes del paso 6 deja vaults/<id>.creating, que el arranque borra', async () => {
    let reached: () => void = () => undefined;
    const atStep5 = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const ctx = context({
      beforeCreateStep: (step) => {
        if (step !== 5) return undefined;
        reached();
        return new Promise<void>(() => undefined); // "la app muere" aquí: nunca termina
      },
    });
    void create(ctx);
    await atStep5;
    const vaults = join(ctx.root, 'vaults');
    const creating = readdirSync(vaults).find((n) => n.endsWith('.creating')) as string;
    expect(existsSync(join(vaults, creating, 'library.db'))).toBe(true);

    const info = vi.spyOn(log, 'info');
    await context({}, ctx.root).service.startupCleanup(); // siguiente arranque
    expect(readdirSync(vaults)).toEqual([]);
    expect(info).toHaveBeenCalledWith('vault.creating-removed');
  });

  it('una caída entre los pasos 6 y 7 deja una carpeta huérfana que solo se registra', async () => {
    let reached: () => void = () => undefined;
    const atStep7 = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const ctx = context({
      beforeCreateStep: (step) => {
        if (step !== 7) return undefined;
        reached();
        return new Promise<void>(() => undefined);
      },
    });
    void create(ctx);
    await atStep7;
    const vaults = join(ctx.root, 'vaults');
    const orphan = readdirSync(vaults)[0] as string;
    expect(orphan).toMatch(/^[0-9a-f]{32}$/);
    const before = snapshot(join(vaults, orphan));
    const warn = vi.spyOn(log, 'warn');
    await context({}, ctx.root).service.startupCleanup();
    expect(warn).toHaveBeenCalledWith('vault.orphan-dir');
    expect(snapshot(join(vaults, orphan))).toEqual(before); // nunca se borra automáticamente
  });

  it('nombre duplicado sin distinguir mayúsculas ni acentos → PROFILE_NAME_TAKEN', async () => {
    const ctx = context();
    await create(ctx, 'Álvaro');
    for (const name of ['alvaro', 'ÁLVARO', 'A\u0301lvaro']) {
      expect((await appErrorOf(() => create(ctx, name))).code).toBe('PROFILE_NAME_TAKEN');
    }
  });

  it('el perfil 11 → PROFILE_LIMIT', async () => {
    const ctx = context();
    for (let i = 0; i < 10; i += 1) await create(ctx, `Perfil ${i}`);
    expect((await appErrorOf(() => create(ctx, 'Once'))).code).toBe('PROFILE_LIMIT');
    expect(readdirSync(join(ctx.root, 'vaults'))).toHaveLength(10);
  });

  it('valida el aviso, la contraseña, el nombre y el token del avatar', async () => {
    const ctx = context();
    const bad = [
      { acknowledgeNoRecovery: false },
      { password: pw('corta') },
      { name: '   ' },
      { name: 'x'.repeat(41) },
      { avatar: { type: 'custom', token: 'a'.repeat(43) } },
      { avatar: { type: 'builtin', id: 'otro' } },
    ];
    for (const patch of bad) {
      const req = {
        name: 'Ana',
        avatar: { type: 'builtin', id: 'aurora' },
        password: pw(),
        acknowledgeNoRecovery: true,
        ...patch,
      };
      expect((await appErrorOf(() => ctx.service.createProfile(req as never))).code).toBe(
        'VALIDATION',
      );
    }
    expect(existsSync(ctx.store.path)).toBe(false);
  });

  it('con avatar personalizado escribe avatars/<id>.webp y consume el token', async () => {
    const ctx = context();
    const webp = Buffer.from('RIFF0000WEBPVP8 datos');
    const token = ctx.tokens.issue(webp);
    const summary = await ctx.service.createProfile({
      name: 'Ana',
      avatar: { type: 'custom', token },
      password: pw(),
      acknowledgeNoRecovery: true,
    });
    expect(summary.avatar).toEqual({ type: 'custom', rev: 1 });
    expect(readFileSync(avatarFilePath(ctx.root, summary.id))).toEqual(webp);
    expect(ctx.tokens.peek(token)).toBeNull();
  });
});

describe('changePassword (§6.6: solo se vuelve a envolver la MK)', () => {
  it('conserva la MK (la DB abre igual), la antigua da WRONG_PASSWORD, el .bak no guarda la envoltura antigua y no se recifra nada', async () => {
    const ctx = context();
    const id = await create(ctx);
    // Un dato en la DB con la contraseña original.
    const first = await openWith(ctx, id, pw());
    const marker = randomBytes(16).toString('hex');
    kvSet(first.db, KV_DEFAULT_TRACKS, [marker]);
    closeDatabase(first.db);
    const mkBefore = Buffer.from(first.mk);
    const old = await stored(ctx, id);
    const vaultBefore = snapshot(defaultVaultDir(ctx.root, id));

    const current = pw();
    const next = pw('otra contraseña nueva');
    await ctx.service.changePassword({
      profileId: id,
      currentPassword: current,
      newPassword: next,
    });
    expect(isAllZero(current)).toBe(true);
    expect(isAllZero(next)).toBe(true);
    expect(ctx.keks.every(isAllZero)).toBe(true);

    // No se ha recifrado ni tocado ningún archivo de la bóveda.
    expect(snapshot(defaultVaultDir(ctx.root, id))).toEqual(vaultBefore);

    // profiles.json y su .bak: idénticos, con sal, parámetros y envoltura nuevos.
    const main = readFileSync(ctx.store.path, 'utf8');
    const bak = readFileSync(ctx.store.bakPath, 'utf8');
    expect(bak).toBe(main);
    for (const oldValue of [
      old.masterKeyWrap.ciphertext,
      old.masterKeyWrap.nonce,
      old.masterKeyWrap.tag,
      old.kdf.salt,
    ]) {
      expect(bak).not.toContain(oldValue);
      expect(main).not.toContain(oldValue);
    }

    // La nueva contraseña desenvuelve la misma MK y la DB abre igual.
    const reopened = await openWith(ctx, id, pw('otra contraseña nueva'));
    expect(reopened.mk.equals(mkBefore)).toBe(true);
    expect(kvGet(reopened.db, KV_DEFAULT_TRACKS)).toEqual([marker]);
    closeDatabase(reopened.db);

    // La antigua ya no sirve.
    expect((await appErrorOf(() => openWith(ctx, id, pw()))).code).toBe('WRONG_PASSWORD');
    expect(
      (
        await appErrorOf(() =>
          ctx.service.changePassword({
            profileId: id,
            currentPassword: pw(),
            newPassword: pw('tercera contraseña'),
          }),
        )
      ).code,
    ).toBe('WRONG_PASSWORD');
  });

  it('con la contraseña actual incorrecta no cambia nada', async () => {
    const ctx = context();
    const id = await create(ctx);
    const before = readFileSync(ctx.store.path, 'utf8');
    const err = await appErrorOf(() =>
      ctx.service.changePassword({
        profileId: id,
        currentPassword: pw('no es la buena'),
        newPassword: pw('otra contraseña nueva'),
      }),
    );
    expect(err.code).toBe('WRONG_PASSWORD');
    expect(readFileSync(ctx.store.path, 'utf8')).toBe(before);
  });
});

describe('deleteProfile (§14.4: siempre con la contraseña) [H3-8]', () => {
  async function withPrefsAndAvatar(ctx: Ctx, id: string): Promise<void> {
    await ctx.prefs.set(id, { themeId: 'ps3' });
    mkdirSync(join(ctx.root, 'avatars'), { recursive: true });
    writeFileSync(avatarFilePath(ctx.root, id), 'webp');
  }

  it('con la contraseña incorrecta no cambia nada', async () => {
    const ctx = context();
    const id = await create(ctx);
    await withPrefsAndAvatar(ctx, id);
    const before = snapshot(ctx.root);
    const password = pw('no es la buena');
    const err = await appErrorOf(() =>
      ctx.service.deleteProfile({ profileId: id, password, confirmName: 'Ana' }),
    );
    expect(err.code).toBe('WRONG_PASSWORD');
    expect(snapshot(ctx.root)).toEqual(before);
    expect(isAllZero(password)).toBe(true);
    expect(ctx.session.lock).not.toHaveBeenCalled();
  });

  it('con un nombre de confirmación que no coincide no cambia nada', async () => {
    const ctx = context();
    const id = await create(ctx);
    const before = snapshot(ctx.root);
    const err = await appErrorOf(() =>
      ctx.service.deleteProfile({ profileId: id, password: pw(), confirmName: 'Otro' }),
    );
    expect(err.code).toBe('VALIDATION');
    expect(snapshot(ctx.root)).toEqual(before);
  });

  it('perfil inexistente → PROFILE_NOT_FOUND', async () => {
    const ctx = context();
    await create(ctx);
    const err = await appErrorOf(() =>
      ctx.service.deleteProfile({
        profileId: randomBytes(16).toString('hex'),
        password: pw(),
        confirmName: 'Ana',
      }),
    );
    expect(err.code).toBe('PROFILE_NOT_FOUND');
  });

  it('con la correcta (y el nombre plegado) borra todo y devuelve { leftoverPath: null }', async () => {
    const ctx = context();
    const keep = await create(ctx, 'Otra');
    const id = await create(ctx, 'Ána');
    await withPrefsAndAvatar(ctx, id);
    const result = await ctx.service.deleteProfile({
      profileId: id,
      password: pw(),
      confirmName: 'ana',
    });
    expect(result).toEqual({ leftoverPath: null });
    expect(existsSync(defaultVaultDir(ctx.root, id))).toBe(false);
    expect(existsSync(ctx.prefs.pathOf(id))).toBe(false);
    expect(existsSync(avatarFilePath(ctx.root, id))).toBe(false);
    expect((await ctx.store.read()).profiles.map((p) => p.id)).toEqual([keep]);
    expect(readFileSync(ctx.store.bakPath, 'utf8')).toBe(readFileSync(ctx.store.path, 'utf8'));
    expect(existsSync(defaultVaultDir(ctx.root, keep))).toBe(true);
  });

  it('con un archivo ajeno dentro de la bóveda devuelve su ruta en leftoverPath sin borrarlo', async () => {
    const ctx = context();
    const id = await create(ctx);
    const vault = defaultVaultDir(ctx.root, id);
    writeFileSync(join(vault, 'ajeno.txt'), 'no es de la app');
    const result = await ctx.service.deleteProfile({
      profileId: id,
      password: pw(),
      confirmName: 'Ana',
    });
    expect(result).toEqual({ leftoverPath: vault });
    expect(readFileSync(join(vault, 'ajeno.txt'), 'utf8')).toBe('no es de la app');
    expect(readdirSync(vault)).toEqual(['ajeno.txt']);
    expect(await ctx.store.find(id)).toBeNull();
  });

  it('si el perfil está desbloqueado, lo bloquea antes de borrar', async () => {
    const ctx = context();
    const id = await create(ctx);
    ctx.session.currentProfileId = id;
    await ctx.service.deleteProfile({ profileId: id, password: pw(), confirmName: 'Ana' });
    expect(ctx.session.lock).toHaveBeenCalledWith('manual');
  });
});

describe('updateProfile (D14) y list', () => {
  it('editar exige la contraseña; el nombre sigue siendo único', async () => {
    const ctx = context();
    const id = await create(ctx, 'Ana');
    await create(ctx, 'Bea');
    const before = readFileSync(ctx.store.path, 'utf8');
    expect(
      (
        await appErrorOf(() =>
          ctx.service.updateProfile({
            profileId: id,
            password: pw('mala contraseña'),
            name: 'Carla',
          }),
        )
      ).code,
    ).toBe('WRONG_PASSWORD');
    expect(readFileSync(ctx.store.path, 'utf8')).toBe(before);
    expect(
      (
        await appErrorOf(() =>
          ctx.service.updateProfile({ profileId: id, password: pw(), name: 'BEA' }),
        )
      ).code,
    ).toBe('PROFILE_NAME_TAKEN');
    const updated = await ctx.service.updateProfile({
      profileId: id,
      password: pw(),
      name: 'Carla',
    });
    expect(updated.name).toBe('Carla');
  });

  it('cambiar a una foto sube rev; volver a un integrado borra el archivo', async () => {
    const ctx = context();
    const id = await create(ctx);
    const token = ctx.tokens.issue(Buffer.from('webp-1'));
    expect(
      (
        await ctx.service.updateProfile({
          profileId: id,
          password: pw(),
          avatar: { type: 'custom', token },
        })
      ).avatar,
    ).toEqual({
      type: 'custom',
      rev: 1,
    });
    const token2 = ctx.tokens.issue(Buffer.from('webp-2'));
    expect(
      (
        await ctx.service.updateProfile({
          profileId: id,
          password: pw(),
          avatar: { type: 'custom', token: token2 },
        })
      ).avatar,
    ).toEqual({
      type: 'custom',
      rev: 2,
    });
    expect(readFileSync(avatarFilePath(ctx.root, id), 'utf8')).toBe('webp-2');
    await ctx.service.updateProfile({
      profileId: id,
      password: pw(),
      avatar: { type: 'builtin', id: 'lava' },
    });
    expect(existsSync(avatarFilePath(ctx.root, id))).toBe(false);
  });

  it('list: vaultStatus y themeId de prefs; nunca la KDF ni la envoltura', async () => {
    const ctx = context();
    const a = await create(ctx, 'Ana');
    const b = await create(ctx, 'Bea');
    await ctx.prefs.set(a, { themeId: 'ps3' });
    renameSync(defaultVaultDir(ctx.root, b), `${defaultVaultDir(ctx.root, b)}-desconectado`);
    const list = await ctx.service.list();
    expect(list).toEqual([
      {
        id: a,
        name: 'Ana',
        avatar: { type: 'builtin', id: 'aurora' },
        vaultStatus: 'ok',
        themeId: 'ps3',
      },
      {
        id: b,
        name: 'Bea',
        avatar: { type: 'builtin', id: 'aurora' },
        vaultStatus: 'unavailable',
        themeId: null,
      },
    ]);
    expect(JSON.stringify(list)).not.toMatch(/kdf|masterKeyWrap|salt/);
  });
});

describe('startupCleanup', () => {
  it('solo borra .creating y registra las carpetas huérfanas sin tocarlas', async () => {
    const ctx = context();
    const id = await create(ctx);
    const vaults = join(ctx.root, 'vaults');
    const orphan = join(vaults, randomBytes(16).toString('hex'));
    mkdirSync(join(orphan, 'objects'), { recursive: true });
    writeFileSync(join(orphan, 'library.db'), 'x');
    const creating = join(vaults, `${randomBytes(16).toString('hex')}.creating`);
    mkdirSync(join(creating, 'tmp'), { recursive: true });
    const other = join(vaults, 'otra-cosa');
    mkdirSync(other);
    const before = {
      orphan: snapshot(orphan),
      other: snapshot(other),
      mine: snapshot(defaultVaultDir(ctx.root, id)),
    };
    await ctx.service.startupCleanup();
    expect(existsSync(creating)).toBe(false);
    expect(snapshot(orphan)).toEqual(before.orphan);
    expect(existsSync(other)).toBe(true);
    expect(snapshot(defaultVaultDir(ctx.root, id))).toEqual(before.mine);
  });

  it('con profiles.json dañado no registra huérfanas ni borra bóvedas', async () => {
    const ctx = context();
    const id = await create(ctx);
    writeFileSync(ctx.store.path, 'roto');
    writeFileSync(ctx.store.bakPath, 'roto');
    const warn = vi.spyOn(log, 'warn');
    await ctx.service.startupCleanup();
    expect(warn).not.toHaveBeenCalledWith('vault.orphan-dir');
    expect(existsSync(defaultVaultDir(ctx.root, id))).toBe(true);
  });
});
