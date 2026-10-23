// Escritura atómica de JSON, settings.json y prefs/<id>.json (docs/DESIGN.md §8.3 y §8.4).
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEFAULT_PREFS,
  DEFAULT_SETTINGS,
  PrefsStore,
  SettingsStore,
  cleanupTmpFiles,
  defaultAtomicIo,
  writeJsonAtomic,
  type AtomicIo,
} from '../../../src/main/settings/settings-store';
import { appErrorOf } from '../helpers/crypto';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('settings-store');
afterAll(() => removeTmpDir(tmp));

const newDir = (): string => mkdtempSync(join(tmp, 'd-'));
const schema = z.strictObject({ a: z.number() });

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** rename que falla `n` veces con `code` y después usa el real. */
function flakyIo(n: number, code: string): AtomicIo & { sleeps: number[] } {
  let left = n;
  const sleeps: number[] = [];
  return {
    sleeps,
    rename: async (from, to) => {
      if (left > 0) {
        left -= 1;
        throw errno(code);
      }
      await defaultAtomicIo.rename(from, to);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

describe('writeJsonAtomic', () => {
  it('escribe el JSON validado y no deja temporales', async () => {
    const dir = newDir();
    const path = join(dir, 'x.json');
    await writeJsonAtomic(path, { a: 1 }, schema);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
    expect(readdirSync(dir)).toEqual(['x.json']);
  });

  it('un valor que no valida contra su esquema no se escribe (INTERNAL)', async () => {
    const dir = newDir();
    const path = join(dir, 'x.json');
    const err = await appErrorOf(() => writeJsonAtomic(path, { a: 'no' } as never, schema));
    expect(err.code).toBe('INTERNAL');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reintenta el rename con EPERM/EBUSY (50 ms × 2)', async () => {
    const dir = newDir();
    const path = join(dir, 'x.json');
    const io = flakyIo(3, 'EPERM');
    await writeJsonAtomic(path, { a: 2 }, schema, io);
    expect(io.sleeps).toEqual([50, 100, 200]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 2 });
    const busy = flakyIo(1, 'EBUSY');
    await writeJsonAtomic(path, { a: 3 }, schema, busy);
    expect(busy.sleeps).toEqual([50]);
  });

  it('tras 5 reintentos falla con IO, borra el temporal y deja el destino como estaba', async () => {
    const dir = newDir();
    const path = join(dir, 'x.json');
    await writeJsonAtomic(path, { a: 1 }, schema);
    const io = flakyIo(6, 'EPERM');
    const err = await appErrorOf(() => writeJsonAtomic(path, { a: 9 }, schema, io));
    expect(err.code).toBe('IO');
    expect(io.sleeps).toHaveLength(5);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: 1 });
    expect(readdirSync(dir)).toEqual(['x.json']);
  });

  it('ENOSPC → DISK_FULL; otro error sin reintentos → IO', async () => {
    const dir = newDir();
    const path = join(dir, 'x.json');
    expect(
      (await appErrorOf(() => writeJsonAtomic(path, { a: 1 }, schema, flakyIo(1, 'ENOSPC')))).code,
    ).toBe('DISK_FULL');
    const io = flakyIo(1, 'EACCES');
    expect((await appErrorOf(() => writeJsonAtomic(path, { a: 1 }, schema, io))).code).toBe('IO');
    expect(io.sleeps).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('cleanupTmpFiles', () => {
  it('borra los *.tmp-<8 hex> de la raíz, prefs/ y avatars/ y nada más', () => {
    const root = newDir();
    mkdirSync(join(root, 'prefs'));
    mkdirSync(join(root, 'avatars'));
    mkdirSync(join(root, 'vaults'));
    const temps = [
      join(root, 'profiles.json.tmp-0123abcd'),
      join(root, 'settings.json.tmp-ffffffff'),
      join(root, 'prefs', `${randomBytes(16).toString('hex')}.json.tmp-12345678`),
      join(root, 'avatars', `${randomBytes(16).toString('hex')}.webp.tmp-abcdef01`),
    ];
    const keep = [
      join(root, 'profiles.json'),
      join(root, 'notas.tmp-xyz'),
      join(root, 'prefs', 'a.json'),
      join(root, 'vaults', 'vault.json.tmp-12345678'),
    ];
    for (const f of [...temps, ...keep]) writeFileSync(f, '{}');
    expect(cleanupTmpFiles(root)).toBe(4);
    for (const f of temps) expect(existsSync(f)).toBe(false);
    for (const f of keep) expect(existsSync(f)).toBe(true);
  });

  it('sin carpetas no falla', () => {
    expect(cleanupTmpFiles(join(newDir(), 'no-existe'))).toBe(0);
  });
});

describe('SettingsStore', () => {
  it('sin archivo: valores por defecto y no escribe nada', async () => {
    const root = newDir();
    const store = new SettingsStore(root);
    expect(await store.load()).toEqual({
      pickerThemeId: DEFAULT_SETTINGS.pickerThemeId,
      colorScheme: 'system',
    });
    expect(existsSync(store.path)).toBe(false);
  });

  it('archivo inválido: valores por defecto, se reescribe y se registra un warn', async () => {
    const root = newDir();
    const store = new SettingsStore(root);
    writeFileSync(store.path, '{"formatVersion":1,"pickerThemeId":"inventado"}');
    expect((await store.load()).pickerThemeId).toBe('fotos');
    expect(JSON.parse(readFileSync(store.path, 'utf8'))).toEqual({ ...DEFAULT_SETTINGS });
  });

  it('set escribe solo los campos presentes y conserva el resto (window)', async () => {
    const root = newDir();
    const store = new SettingsStore(root);
    writeFileSync(
      store.path,
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        window: { width: 1000, height: 700, maximized: true },
      }),
    );
    await store.load();
    expect(await store.set({ pickerThemeId: 'ps3' })).toEqual({
      pickerThemeId: 'ps3',
      colorScheme: 'system',
    });
    expect(await store.set({ colorScheme: 'light' })).toEqual({
      pickerThemeId: 'ps3',
      colorScheme: 'light',
    });
    const onDisk = JSON.parse(readFileSync(store.path, 'utf8'));
    expect(onDisk).toEqual({
      formatVersion: 1,
      pickerThemeId: 'ps3',
      colorScheme: 'light',
      window: { width: 1000, height: 700, maximized: true },
    });
    const reloaded = new SettingsStore(root);
    expect((await reloaded.load()).pickerThemeId).toBe('ps3');
  });

  it('si la escritura falla, la caché no cambia', async () => {
    const root = newDir();
    const store = new SettingsStore(root, flakyIo(10, 'EACCES'));
    await store.load();
    expect((await appErrorOf(() => store.set({ pickerThemeId: 'ps3' }))).code).toBe('IO');
    expect(store.get().pickerThemeId).toBe('fotos');
  });
});

describe('PrefsStore', () => {
  const id = randomBytes(16).toString('hex');

  it('sin archivo: valores por defecto de §8.4', async () => {
    const store = new PrefsStore(newDir());
    expect(await store.get(id)).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS.autoLockMinutes).toBe(5);
    expect(DEFAULT_PREFS.contentProtection).toBe(true);
    expect(DEFAULT_PREFS.themeId).toBeNull();
  });

  it('archivo inválido: valores por defecto, se reescribe y warn', async () => {
    const root = newDir();
    const store = new PrefsStore(root);
    mkdirSync(store.dir);
    writeFileSync(store.pathOf(id), '{"formatVersion":1,"autoLockMinutes":3}');
    expect(await store.get(id)).toEqual(DEFAULT_PREFS);
    expect(JSON.parse(readFileSync(store.pathOf(id), 'utf8'))).toEqual({
      formatVersion: 1,
      ...DEFAULT_PREFS,
    });
  });

  it('set mezcla con lo guardado; remove borra el archivo', async () => {
    const store = new PrefsStore(newDir());
    await store.set(id, { themeId: 'ps3' });
    const next = await store.set(id, { autoLockMinutes: 1, contentProtection: false });
    expect(next).toEqual({
      ...DEFAULT_PREFS,
      themeId: 'ps3',
      autoLockMinutes: 1,
      contentProtection: false,
    });
    expect(await store.get(id)).toEqual(next);
    await store.remove(id);
    expect(existsSync(store.pathOf(id))).toBe(false);
  });

  it('las escrituras del mismo perfil se serializan', async () => {
    const store = new PrefsStore(newDir());
    await Promise.all([
      store.set(id, { gridSize: 'small' }),
      store.set(id, { themeId: 'ps3' }),
      store.set(id, { autoLockMinutes: 10 }),
    ]);
    expect(await store.get(id)).toMatchObject({
      gridSize: 'small',
      themeId: 'ps3',
      autoLockMinutes: 10,
    });
  });

  it('rechaza ids que no son de 32 hex (nunca una ruta)', () => {
    expect(() => new PrefsStore(newDir()).pathOf('../settings')).toThrow(RangeError);
  });
});
