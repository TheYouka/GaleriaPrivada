// profiles.json + .bak (docs/DESIGN.md §8.2 y §8.3): las tres reglas de lectura.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PROFILES_SCHEMA,
  ProfileStore,
  foldName,
  type ProfilesFile,
  type StoredProfile,
} from '../../../src/main/profiles/profile-store';
import { appErrorOf } from '../helpers/crypto';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('profile-store');
afterAll(() => removeTmpDir(tmp));

const b64 = (n: number): string => randomBytes(n).toString('base64');

function sampleProfile(name = 'Alberto'): StoredProfile {
  return {
    id: randomBytes(16).toString('hex'),
    name,
    avatar: { type: 'builtin', id: 'aurora' },
    createdAt: '2026-10-22T15:04:05.000Z',
    vault: { location: 'default' },
    kdf: {
      alg: 'argon2id',
      version: 19,
      memoryKiB: 8192,
      iterations: 1,
      parallelism: 1,
      salt: b64(16),
    },
    masterKeyWrap: { alg: 'A256GCM', nonce: b64(12), ciphertext: b64(32), tag: b64(16) },
  };
}

function fileWith(...profiles: StoredProfile[]): ProfilesFile {
  return { formatVersion: 1, profiles };
}

function store(): ProfileStore {
  return new ProfileStore(mkdtempSync(join(tmp, 'd-')));
}

describe('ProfileStore', () => {
  it('sin ninguno de los dos archivos: lista vacía (primer arranque) sin escribir', async () => {
    const s = store();
    expect(await s.read()).toEqual({ formatVersion: 1, profiles: [] });
    expect(existsSync(s.path)).toBe(false);
    expect(existsSync(s.bakPath)).toBe(false);
  });

  it('write deja profiles.json y su .bak idénticos', async () => {
    const s = store();
    const file = fileWith(sampleProfile());
    await s.write(file);
    expect(readFileSync(s.bakPath, 'utf8')).toBe(readFileSync(s.path, 'utf8'));
    expect(await s.read()).toEqual(file);
  });

  it('profiles.json dañado: se usa el .bak y se reescribe el principal', async () => {
    const s = store();
    const file = fileWith(sampleProfile());
    await s.write(file);
    writeFileSync(s.path, '{"formatVersion":1,"profiles":[{"id":"roto"');
    expect(await s.read()).toEqual(file);
    expect(readFileSync(s.path, 'utf8')).toBe(readFileSync(s.bakPath, 'utf8'));
  });

  it('profiles.json ausente con un .bak válido: se restaura', async () => {
    const s = store();
    const file = fileWith(sampleProfile());
    await s.write(file);
    removeTmpDir(s.path);
    expect(await s.read()).toEqual(file);
    expect(existsSync(s.path)).toBe(true);
  });

  it('los dos dañados: VAULT_CORRUPT sin escribir nada', async () => {
    const s = store();
    writeFileSync(s.path, 'basura');
    writeFileSync(s.bakPath, '{"formatVersion":2}');
    const err = await appErrorOf(() => s.read());
    expect(err.code).toBe('VAULT_CORRUPT');
    expect(readFileSync(s.path, 'utf8')).toBe('basura');
    expect(readFileSync(s.bakPath, 'utf8')).toBe('{"formatVersion":2}');
  });

  it('principal dañado y sin .bak: VAULT_CORRUPT (no se destruye lo recuperable)', async () => {
    const s = store();
    writeFileSync(s.path, 'basura');
    expect((await appErrorOf(() => s.read())).code).toBe('VAULT_CORRUPT');
    expect(existsSync(s.bakPath)).toBe(false);
  });

  it('principal válido y .bak antiguo (caída entre las dos escrituras): se reescribe el .bak', async () => {
    const s = store();
    const old = fileWith(sampleProfile());
    await s.write(old);
    const next = fileWith({ ...old.profiles[0]!, masterKeyWrap: sampleProfile().masterKeyWrap });
    writeFileSync(s.path, `${JSON.stringify(next, null, 2)}\n`);
    expect(await s.read()).toEqual(next);
    expect(readFileSync(s.bakPath, 'utf8')).toBe(readFileSync(s.path, 'utf8'));
    expect(readFileSync(s.bakPath, 'utf8')).not.toContain(
      old.profiles[0]!.masterKeyWrap.ciphertext,
    );
  });

  it('find devuelve el perfil o null', async () => {
    const s = store();
    const p = sampleProfile();
    await s.write(fileWith(p));
    expect(await s.find(p.id)).toEqual(p);
    expect(await s.find(randomBytes(16).toString('hex'))).toBeNull();
  });
});

describe('esquema de profiles.json (§8.2)', () => {
  it('acepta el ejemplo y rechaza ids o nombres (plegados) duplicados y más de 10 perfiles', () => {
    const a = sampleProfile('Álbum');
    expect(PROFILES_SCHEMA.safeParse(fileWith(a)).success).toBe(true);
    expect(PROFILES_SCHEMA.safeParse(fileWith(a, { ...a, name: 'Otro' })).success).toBe(false);
    expect(PROFILES_SCHEMA.safeParse(fileWith(a, sampleProfile('ALBUM'))).success).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => sampleProfile(`P${i}`));
    expect(PROFILES_SCHEMA.safeParse(fileWith(...eleven)).success).toBe(false);
  });

  it('rechaza nombres sin NFC, con controles o de más de 40 code points', () => {
    for (const name of ['A\u0301lbum', 'a\u0007b', 'x'.repeat(41), '']) {
      expect(PROFILES_SCHEMA.safeParse(fileWith(sampleProfile(name))).success).toBe(false);
    }
    expect(PROFILES_SCHEMA.safeParse(fileWith(sampleProfile('😀'.repeat(40)))).success).toBe(true);
  });

  it('rechaza KDF fuera de rango y envolturas con longitudes incorrectas', () => {
    const p = sampleProfile();
    const bad: StoredProfile[] = [
      { ...p, kdf: { ...p.kdf, memoryKiB: 4096 } },
      { ...p, kdf: { ...p.kdf, iterations: 9 } },
      { ...p, kdf: { ...p.kdf, salt: b64(15) } },
      { ...p, masterKeyWrap: { ...p.masterKeyWrap, tag: b64(12) } },
      { ...p, masterKeyWrap: { ...p.masterKeyWrap, nonce: b64(16) } },
    ];
    for (const profile of bad)
      expect(PROFILES_SCHEMA.safeParse(fileWith(profile)).success).toBe(false);
  });

  it('foldName ignora mayúsculas y diacríticos', () => {
    expect(foldName('Álbum')).toBe(foldName('ALBUM'));
    expect(foldName('Peña')).toBe(foldName('pena'));
  });
});
