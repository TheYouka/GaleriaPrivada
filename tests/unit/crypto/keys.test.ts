// Jerarquía de claves: envoltura de la MK, HKDF, KeyRing y caché de DEKs (docs/DESIGN.md §6.2–§6.7).
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DekCache,
  HKDF_INFO,
  KeyRing,
  deriveKeys,
  generateMasterKey,
  mkWrapAad,
  profileIdBytes,
  rewrapMasterKey,
  unwrapMasterKey,
  wrapMasterKey,
  type MasterKeyWrap,
} from '../../../src/main/crypto/keys';
import {
  KDF_FAST_TEST,
  KDF_TARGET,
  deriveKek,
  newSalt,
  type KdfParams,
} from '../../../src/main/crypto/kdf';
import { KIND_MEDIA } from '../../../src/main/crypto/file-format';
import { openObject } from '../../../src/main/crypto/object-reader';
import { appErrorOf, isAllZero, randomKey, writeObject } from '../helpers/crypto';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const SLOW = process.env.GALERIA_SLOW_TESTS === '1';
const PROFILE = '3fa9c2d41b7e4f0a9c8d2e1f00a1b2c3';
const OTHER_PROFILE = '0123456789abcdef0123456789abcdef';
const PARAMS: KdfParams = { memoryKiB: 262144, iterations: 8, parallelism: 4 };
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const tmp = makeTmpDir('keys');
afterAll(() => removeTmpDir(tmp));

function copyWrap(w: MasterKeyWrap): MasterKeyWrap {
  return {
    nonce: Buffer.from(w.nonce),
    ciphertext: Buffer.from(w.ciphertext),
    tag: Buffer.from(w.tag),
  };
}

describe('envoltura de la MK (§6.2)', () => {
  it('envolver y desenvolver devuelve la misma MK', () => {
    const mk = generateMasterKey();
    const kek = randomKey();
    const salt = newSalt();
    const wrap = wrapMasterKey(mk, kek, PROFILE, PARAMS, salt);
    expect(wrap.nonce).toHaveLength(12);
    expect(wrap.ciphertext).toHaveLength(32);
    expect(wrap.tag).toHaveLength(16);
    expect(wrap.ciphertext.equals(mk)).toBe(false);
    expect(unwrapMasterKey(wrap, kek, PROFILE, PARAMS, salt).equals(mk)).toBe(true);
  });

  it('cada envoltura usa un nonce nuevo', () => {
    const mk = generateMasterKey();
    const kek = randomKey();
    const salt = newSalt();
    const a = wrapMasterKey(mk, kek, PROFILE, PARAMS, salt);
    const b = wrapMasterKey(mk, kek, PROFILE, PARAMS, salt);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('contraseña incorrecta (Argon2id real, parámetros de test) → WRONG_PASSWORD', async () => {
    const mk = generateMasterKey();
    const salt = newSalt();
    const good = await deriveKek(utf8('contraseña buena'), salt, KDF_FAST_TEST);
    const bad = await deriveKek(utf8('contraseña mala'), salt, KDF_FAST_TEST);
    const wrap = wrapMasterKey(mk, good, PROFILE, KDF_FAST_TEST, salt);
    expect(
      await appErrorOf(() => unwrapMasterKey(wrap, bad, PROFILE, KDF_FAST_TEST, salt)),
    ).toEqual({ code: 'WRONG_PASSWORD', reason: undefined });
    expect(unwrapMasterKey(wrap, good, PROFILE, KDF_FAST_TEST, salt).equals(mk)).toBe(true);
  });

  it('KEK distinta → WRONG_PASSWORD', async () => {
    const salt = newSalt();
    const wrap = wrapMasterKey(generateMasterKey(), randomKey(), PROFILE, PARAMS, salt);
    expect(
      (await appErrorOf(() => unwrapMasterKey(wrap, randomKey(), PROFILE, PARAMS, salt))).code,
    ).toBe('WRONG_PASSWORD');
  });

  it('cambiar profileId, m, t, p o la sal en la AAD hace fallar el tag', async () => {
    const mk = generateMasterKey();
    const kek = randomKey();
    const salt = newSalt();
    const wrap = wrapMasterKey(mk, kek, PROFILE, PARAMS, salt);
    const variants: [string, () => unknown][] = [
      ['profileId', () => unwrapMasterKey(wrap, kek, OTHER_PROFILE, PARAMS, salt)],
      ['m', () => unwrapMasterKey(wrap, kek, PROFILE, { ...PARAMS, memoryKiB: 131072 }, salt)],
      ['t', () => unwrapMasterKey(wrap, kek, PROFILE, { ...PARAMS, iterations: 3 }, salt)],
      ['p', () => unwrapMasterKey(wrap, kek, PROFILE, { ...PARAMS, parallelism: 1 }, salt)],
      ['sal', () => unwrapMasterKey(wrap, kek, PROFILE, PARAMS, newSalt())],
    ];
    for (const [, fn] of variants) expect((await appErrorOf(fn)).code).toBe('WRONG_PASSWORD');
    // Control: con los valores originales sí abre.
    expect(unwrapMasterKey(wrap, kek, PROFILE, PARAMS, salt).equals(mk)).toBe(true);
  });

  it('nonce, ciphertext o tag manipulados, o un tag de 12 bytes → WRONG_PASSWORD', async () => {
    const kek = randomKey();
    const salt = newSalt();
    const wrap = wrapMasterKey(generateMasterKey(), kek, PROFILE, PARAMS, salt);
    for (const field of ['nonce', 'ciphertext', 'tag'] as const) {
      const w = copyWrap(wrap);
      w[field][0] = (w[field][0] as number) ^ 0x80;
      expect((await appErrorOf(() => unwrapMasterKey(w, kek, PROFILE, PARAMS, salt))).code).toBe(
        'WRONG_PASSWORD',
      );
    }
    const truncated = { ...copyWrap(wrap), tag: wrap.tag.subarray(0, 12) };
    expect(
      (await appErrorOf(() => unwrapMasterKey(truncated, kek, PROFILE, PARAMS, salt))).code,
    ).toBe('WRONG_PASSWORD');
  });

  it('AAD_mk con el formato exacto de §6.2', () => {
    const salt = Buffer.alloc(16, 0xab);
    const aad = mkWrapAad(PROFILE, PARAMS, salt);
    const expected = Buffer.concat([
      Buffer.from('galeria/v1/mk-wrap', 'utf8'),
      Buffer.from([0]),
      Buffer.from(PROFILE, 'hex'),
      Buffer.from('argon2id$v=19$m=262144,t=8,p=4', 'utf8'),
      Buffer.from([0]),
      salt,
    ]);
    expect(aad.equals(expected)).toBe(true);
    expect(profileIdBytes(PROFILE).toString('hex')).toBe(PROFILE);
    expect(() => profileIdBytes('XYZ')).toThrow(RangeError);
  });
});

describe('claves derivadas por HKDF (§6.3)', () => {
  it('las tres claves son distintas entre sí, de la MK y entre perfiles', () => {
    const mk = generateMasterKey();
    const a = deriveKeys(mk, PROFILE);
    const b = deriveKeys(mk, OTHER_PROFILE);
    const all = [a.kDb, a.kWrap, a.kDedup, b.kDb, b.kWrap, b.kDedup, mk].map((k) =>
      k.toString('hex'),
    );
    expect(new Set(all).size).toBe(7);
    for (const k of [a.kDb, a.kWrap, a.kDedup]) expect(k).toHaveLength(32);
  });

  it('son deterministas y usan HKDF-SHA256(salt = profileId, info = galeria/v1/…)', () => {
    const mk = generateMasterKey();
    const keys = deriveKeys(mk, PROFILE);
    const ref = (info: string): Buffer =>
      Buffer.from(hkdfSync('sha256', mk, Buffer.from(PROFILE, 'hex'), info, 32));
    expect(keys.kDb.equals(ref('galeria/v1/db'))).toBe(true);
    expect(keys.kWrap.equals(ref('galeria/v1/file-wrap'))).toBe(true);
    expect(keys.kDedup.equals(ref('galeria/v1/dedup'))).toBe(true);
    expect(HKDF_INFO).toEqual({
      db: 'galeria/v1/db',
      wrap: 'galeria/v1/file-wrap',
      dedup: 'galeria/v1/dedup',
    });
    expect(deriveKeys(mk, PROFILE).kWrap.equals(keys.kWrap)).toBe(true);
  });
});

describe('KeyRing (§6.7)', () => {
  it('zeroize() deja las cuatro claves a cero y después da LOCKED', async () => {
    const mk = generateMasterKey();
    const ring = new KeyRing(mk, PROFILE);
    const held = [ring.mk, ring.kDb, ring.kWrap, ring.kDedup];
    expect(held.every((k) => !isAllZero(k))).toBe(true);
    const cached = randomKey();
    ring.dekCache.set(randomBytes(16), Buffer.alloc(108), cached);

    ring.zeroize();

    expect(held.every(isAllZero)).toBe(true);
    expect(isAllZero(mk)).toBe(true); // tomó posesión de la MK
    expect(isAllZero(cached)).toBe(true);
    expect(ring.dekCache.size).toBe(0);
    expect(ring.zeroized).toBe(true);
    for (const get of [() => ring.mk, () => ring.kDb, () => ring.kWrap, () => ring.kDedup]) {
      expect((await appErrorOf(get)).code).toBe('LOCKED');
    }
    expect(() => ring.zeroize()).not.toThrow(); // idempotente
  });
});

describe('DekCache (§6.7)', () => {
  const header = (n: number): Buffer => Buffer.alloc(108, n);
  const id = (n: number): Buffer => Buffer.alloc(16, n);

  it('LRU de 64: la DEK expulsada queda a cero', () => {
    const cache = new DekCache();
    expect(cache.max).toBe(64);
    const deks = Array.from({ length: 65 }, () => randomKey());
    for (let i = 0; i < 64; i += 1) cache.set(id(i), header(i), deks[i] as Buffer);
    expect(cache.size).toBe(64);
    cache.set(id(64), header(64), deks[64] as Buffer);
    expect(cache.size).toBe(64);
    expect(isAllZero(deks[0] as Buffer)).toBe(true); // la menos usada
    expect(cache.get(id(0), header(0))).toBeNull();
    expect(deks.slice(1).every((d) => !isAllZero(d))).toBe(true);
  });

  it('get() renueva el uso y devuelve una copia propia', () => {
    const cache = new DekCache(2);
    const a = randomKey();
    const b = randomKey();
    const c = randomKey();
    const aValue = Buffer.from(a);
    cache.set(id(1), header(1), a);
    cache.set(id(2), header(2), b);
    const copy = cache.get(id(1), header(1));
    expect(copy?.equals(aValue)).toBe(true);
    copy?.fill(0); // ponerla a cero no afecta a la caché
    expect(cache.get(id(1), header(1))?.equals(aValue)).toBe(true);
    cache.set(id(3), header(3), c); // expulsa b (a se usó después)
    expect(isAllZero(b)).toBe(true);
    expect(isAllZero(a)).toBe(false);
  });

  it('solo acierta con la misma cabecera byte a byte', () => {
    const cache = new DekCache();
    cache.set(id(1), header(1), randomKey());
    const tampered = header(1);
    tampered[12] = 0x7f;
    expect(cache.get(id(1), tampered)).toBeNull();
    expect(cache.get(id(1), header(1))).not.toBeNull();
  });

  it('sustituir, borrar y vaciar ponen a cero', () => {
    const cache = new DekCache();
    const first = randomKey();
    const second = randomKey();
    cache.set(id(1), header(1), first);
    cache.set(id(1), header(1), second);
    expect(isAllZero(first)).toBe(true);
    cache.delete(id(1));
    expect(isAllZero(second)).toBe(true);
    const many = Array.from({ length: 5 }, (_, i) => {
      const k = randomKey();
      cache.set(id(10 + i), header(10 + i), k);
      return k;
    });
    cache.clear();
    expect(many.every(isAllZero)).toBe(true);
    expect(cache.size).toBe(0);
  });
});

describe('cambio de contraseña al nivel de claves (§6.6)', () => {
  it('solo se vuelve a envolver: la MK y las claves derivadas no cambian y nada se recifra', async () => {
    const salt1 = newSalt();
    const kek1 = await deriveKek(utf8('contraseña antigua'), salt1, KDF_FAST_TEST);
    const mk = generateMasterKey();
    const mkValue = Buffer.from(mk);
    const wrap1 = wrapMasterKey(mk, kek1, PROFILE, KDF_FAST_TEST, salt1);
    const before = deriveKeys(mk, PROFILE);
    const plaintext = randomBytes(150000);
    const obj = await writeObject(tmp, plaintext, before.kWrap);
    const fileHash = createHash('sha256').update(readFileSync(obj.path)).digest('hex');

    const salt2 = newSalt();
    const params2: KdfParams = { ...KDF_FAST_TEST, iterations: 2 };
    const kek2 = await deriveKek(utf8('contraseña nueva'), salt2, params2);
    const wrap2 = rewrapMasterKey(
      PROFILE,
      { wrap: wrap1, kek: kek1, params: KDF_FAST_TEST, salt: salt1 },
      { kek: kek2, params: params2, salt: salt2 },
    );

    // La nueva contraseña abre la misma MK y deriva las mismas claves.
    const mk2 = unwrapMasterKey(wrap2, kek2, PROFILE, params2, salt2);
    expect(mk2.equals(mkValue)).toBe(true);
    const after = deriveKeys(mk2, PROFILE);
    expect(after.kDb.equals(before.kDb)).toBe(true);
    expect(after.kWrap.equals(before.kWrap)).toBe(true);
    expect(after.kDedup.equals(before.kDedup)).toBe(true);

    // La antigua ya no abre la envoltura nueva (con sus parámetros antiguos ni con los nuevos).
    expect(
      (await appErrorOf(() => unwrapMasterKey(wrap2, kek1, PROFILE, KDF_FAST_TEST, salt1))).code,
    ).toBe('WRONG_PASSWORD');
    expect(
      (await appErrorOf(() => unwrapMasterKey(wrap2, kek1, PROFILE, params2, salt2))).code,
    ).toBe('WRONG_PASSWORD');

    // El objeto no se ha tocado y se sigue leyendo con la K_wrap derivada tras el cambio.
    expect(createHash('sha256').update(readFileSync(obj.path)).digest('hex')).toBe(fileHash);
    const reader = await openObject(
      obj.path,
      { fileId: obj.fileId, kind: KIND_MEDIA },
      after.kWrap,
    );
    expect((await reader.readAll()).equals(plaintext)).toBe(true);
    await reader.close();
  });

  it('con la contraseña actual incorrecta → WRONG_PASSWORD y no hay envoltura nueva', async () => {
    const salt = newSalt();
    const kek = randomKey();
    const wrap = wrapMasterKey(generateMasterKey(), kek, PROFILE, PARAMS, salt);
    const err = await appErrorOf(() =>
      rewrapMasterKey(
        PROFILE,
        { wrap, kek: randomKey(), params: PARAMS, salt },
        { kek: randomKey(), params: PARAMS, salt: newSalt() },
      ),
    );
    expect(err.code).toBe('WRONG_PASSWORD');
  });
});

describe.runIf(SLOW)('Argon2id con los parámetros de producción (lento)', () => {
  it('desbloquear, contraseña incorrecta y cambio de contraseña', { timeout: 60_000 }, async () => {
    const salt = newSalt();
    const kek = await deriveKek(utf8('una contraseña larga'), salt, KDF_TARGET);
    const mk = generateMasterKey();
    const mkValue = Buffer.from(mk);
    const wrap = wrapMasterKey(mk, kek, PROFILE, KDF_TARGET, salt);
    const again = await deriveKek(utf8('una contraseña larga'), salt, KDF_TARGET);
    expect(unwrapMasterKey(wrap, again, PROFILE, KDF_TARGET, salt).equals(mkValue)).toBe(true);
    const wrong = await deriveKek(utf8('una contraseña larga!'), salt, KDF_TARGET);
    expect(
      (await appErrorOf(() => unwrapMasterKey(wrap, wrong, PROFILE, KDF_TARGET, salt))).code,
    ).toBe('WRONG_PASSWORD');
    const salt2 = newSalt();
    const kek2 = await deriveKek(utf8('otra contraseña larga'), salt2, KDF_TARGET);
    const wrap2 = rewrapMasterKey(
      PROFILE,
      { wrap, kek: again, params: KDF_TARGET, salt },
      { kek: kek2, params: KDF_TARGET, salt: salt2 },
    );
    expect(unwrapMasterKey(wrap2, kek2, PROFILE, KDF_TARGET, salt2).equals(mkValue)).toBe(true);
    expect(
      (await appErrorOf(() => unwrapMasterKey(wrap2, again, PROFILE, KDF_TARGET, salt))).code,
    ).toBe('WRONG_PASSWORD');
  });
});
