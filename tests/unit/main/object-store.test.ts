// vault/object-store.ts y vault/in-flight.ts (docs/DESIGN.md §8.5, §12.4 paso 6, §12.6 y §12.10).
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  decodeHeader,
  HEADER_LEN,
  KIND_MEDIA,
  KIND_THUMB,
} from '../../../src/main/crypto/file-format';
import { InFlight } from '../../../src/main/vault/in-flight';
import {
  defaultStoreIo,
  fileIdOf,
  ObjectStore,
  RENAME_RETRIES,
  type StoreIo,
} from '../../../src/main/vault/object-store';
import { appErrorOf, collect, randomKey } from '../helpers/crypto';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const root = makeTmpDir('object-store');
afterAll(() => removeTmpDir(root));

const newId = (): string => randomBytes(16).toString('hex');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

function newVault(): string {
  const dir = join(root, newId());
  for (const sub of ['objects', 'thumbs', 'tmp']) mkdirSync(join(dir, sub), { recursive: true });
  return dir;
}

async function writePart(
  store: ObjectStore,
  id: string,
  data: Buffer,
  kWrap: Buffer,
  kind: typeof KIND_MEDIA | typeof KIND_THUMB = KIND_MEDIA,
): Promise<void> {
  const writer = store.createWriter({ id, kind, kWrap });
  await writer.write(data);
  await writer.finish();
}

describe('ObjectStore: rutas', () => {
  it('rutas solo por id, con el shard de los 2 primeros hex', () => {
    const vault = newVault();
    const store = new ObjectStore(vault);
    const id = newId();
    expect(store.objectPath(id)).toBe(join(vault, 'objects', id.slice(0, 2), id));
    expect(store.thumbPath(id)).toBe(join(vault, 'thumbs', id.slice(0, 2), id));
    expect(store.partPath(id)).toBe(join(vault, 'tmp', `${id}.part`));
    expect(store.finalPath(id, KIND_THUMB)).toBe(store.thumbPath(id));
    for (const bad of ['', '../x', 'A'.repeat(32), `${id.slice(0, 31)}g`, `${id}0`]) {
      expect(() => store.objectPath(bad)).toThrow(RangeError);
      expect(() => store.partPath(bad)).toThrow(RangeError);
      expect(() => fileIdOf(bad)).toThrow(RangeError);
    }
    expect(fileIdOf(id).toString('hex')).toBe(id);
  });
});

describe('ObjectStore: escritura única y promote', () => {
  it('cifra en tmp/<id>.part, lo promueve a objects/<aa>/<id> y se lee igual', async () => {
    const vault = newVault();
    const store = new ObjectStore(vault);
    const kWrap = randomKey();
    const id = newId();
    const data = randomBytes(200_000);
    await writePart(store, id, data, kWrap);
    expect(existsSync(store.partPath(id))).toBe(true);
    const part = await store.open(id, KIND_MEDIA, kWrap, undefined, { part: true });
    expect((await part.readAll()).equals(data)).toBe(true);
    await part.close();
    const final = await store.promote(id, KIND_MEDIA);
    expect(final).toBe(store.objectPath(id));
    expect(existsSync(store.partPath(id))).toBe(false);
    const reader = await store.open(id, KIND_MEDIA, kWrap);
    expect((await collect(reader.createReadStream(0, data.length - 1))).equals(data)).toBe(true);
    await reader.close();
  });

  it('nunca reabre un .part existente para escribir', async () => {
    const vault = newVault();
    const store = new ObjectStore(vault);
    const kWrap = randomKey();
    const id = newId();
    writeFileSync(store.partPath(id), 'ajeno');
    const writer = store.createWriter({ id, kind: KIND_MEDIA, kWrap });
    await expect(writer.write(Buffer.from('x'))).rejects.toBeTruthy();
    await writer.abort();
    expect(readFileSync(store.partPath(id), 'utf8')).toBe('ajeno');
  });

  it('promote nunca sustituye un objeto existente', async () => {
    const vault = newVault();
    const store = new ObjectStore(vault);
    const kWrap = randomKey();
    const id = newId();
    await writePart(store, id, Buffer.from('primero'), kWrap);
    await store.promote(id, KIND_MEDIA);
    const before = sha(readFileSync(store.objectPath(id)));
    await writePart(store, id, Buffer.from('segundo'), kWrap);
    await expect(store.promote(id, KIND_MEDIA)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(sha(readFileSync(store.objectPath(id)))).toBe(before);
    expect(existsSync(store.partPath(id))).toBe(true);
  });

  it('promote de una miniatura va a thumbs/<aa>/<id>', async () => {
    const vault = newVault();
    const store = new ObjectStore(vault);
    const kWrap = randomKey();
    const id = newId();
    await writePart(store, id, Buffer.from('webp'), kWrap, KIND_THUMB);
    expect(await store.promote(id, KIND_THUMB)).toBe(store.thumbPath(id));
    const reader = await store.open(id, KIND_THUMB, kWrap);
    expect((await reader.readAll()).toString()).toBe('webp');
    await reader.close();
    // Como original no existe: las miniaturas no están en objects/.
    expect((await appErrorOf(() => store.open(id, KIND_MEDIA, kWrap))).code).toBe('NOT_FOUND');
  });

  it(`rename con EPERM/EBUSY se reintenta hasta ${RENAME_RETRIES} veces`, async () => {
    const vault = newVault();
    const kWrap = randomKey();
    let failures = 2;
    const sleeps: number[] = [];
    const io: StoreIo = {
      ...defaultStoreIo,
      rename: async (from, to) => {
        if (failures > 0) {
          failures -= 1;
          throw Object.assign(new Error('busy'), { code: failures % 2 ? 'EPERM' : 'EBUSY' });
        }
        await defaultStoreIo.rename(from, to);
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    };
    const store = new ObjectStore(vault, io);
    const id = newId();
    await writePart(store, id, Buffer.from('x'), kWrap);
    await store.promote(id, KIND_MEDIA);
    expect(existsSync(store.objectPath(id))).toBe(true);
    expect(sleeps).toHaveLength(2);

    failures = RENAME_RETRIES + 1;
    const id2 = newId();
    await writePart(store, id2, Buffer.from('y'), kWrap);
    const err = (await store.promote(id2, KIND_MEDIA).catch((e: unknown) => e)) as {
      code?: string;
    };
    expect(['EPERM', 'EBUSY']).toContain(err.code);
    expect(sleeps).toHaveLength(2 + RENAME_RETRIES);
    expect(existsSync(store.partPath(id2))).toBe(true);
  });
});

describe('ObjectStore: borrado criptográfico (§12.10)', () => {
  it('los 108 primeros bytes dejan de ser la cabecera, fsync y el archivo desaparece', async () => {
    const vault = newVault();
    const kWrap = randomKey();
    let seenBeforeUnlink: Buffer | null = null;
    const order: string[] = [];
    const io: StoreIo = {
      ...defaultStoreIo,
      openForErase: async (p) => {
        const fh = await defaultStoreIo.openForErase(p);
        return {
          write: fh.write.bind(fh),
          sync: async () => {
            order.push('sync');
            await fh.sync();
          },
          close: fh.close.bind(fh),
        } as Awaited<ReturnType<StoreIo['openForErase']>>;
      },
      unlink: async (p) => {
        order.push('unlink');
        seenBeforeUnlink = readFileSync(p);
        await defaultStoreIo.unlink(p);
      },
    };
    const store = new ObjectStore(vault, io);
    const id = newId();
    const data = randomBytes(150_000);
    await writePart(store, id, data, kWrap);
    await store.promote(id, KIND_MEDIA);
    const original = readFileSync(store.objectPath(id));
    expect(() => decodeHeader(original.subarray(0, HEADER_LEN))).not.toThrow();

    expect(await store.eraseObject(id, KIND_MEDIA)).toBe('erased');
    expect(order).toEqual(['sync', 'unlink']);
    expect(existsSync(store.objectPath(id))).toBe(false);
    const after = seenBeforeUnlink as unknown as Buffer;
    expect(after.length).toBe(original.length);
    expect(after.subarray(0, HEADER_LEN).equals(original.subarray(0, HEADER_LEN))).toBe(false);
    expect(after.subarray(HEADER_LEN).equals(original.subarray(HEADER_LEN))).toBe(true);
    expect(() => decodeHeader(after.subarray(0, HEADER_LEN))).toThrow();

    // Con la cabecera destruida, el objeto ya no se puede abrir aunque quedara en disco.
    const copy = join(vault, 'tmp', 'copia');
    writeFileSync(copy, after);
    const { openObject } = await import('../../../src/main/crypto/object-reader');
    const res = await appErrorOf(() =>
      openObject(copy, { fileId: fileIdOf(id), kind: KIND_MEDIA }, kWrap),
    );
    expect(res.code).toBe('INTEGRITY');
  });

  it('un .part, un archivo inexistente y un unlink que falla', async () => {
    const vault = newVault();
    const kWrap = randomKey();
    const store = new ObjectStore(vault);
    const id = newId();
    await writePart(store, id, Buffer.from('parcial'), kWrap);
    expect(await store.erasePart(id)).toBe('erased');
    expect(existsSync(store.partPath(id))).toBe(false);
    expect(await store.eraseObject(newId(), KIND_MEDIA)).toBe('missing');

    const failing = new ObjectStore(vault, {
      ...defaultStoreIo,
      unlink: async () => Promise.reject(Object.assign(new Error('x'), { code: 'EBUSY' })),
    });
    const id2 = newId();
    await writePart(failing, id2, Buffer.from('z'), kWrap);
    expect(await failing.erasePart(id2)).toBe('failed');
    expect(existsSync(failing.partPath(id2))).toBe(true);
  });

  it('si la sobrescritura falla, borra igual y lo indica', async () => {
    const vault = newVault();
    const kWrap = randomKey();
    const store = new ObjectStore(vault, {
      ...defaultStoreIo,
      openForErase: async () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })),
    });
    const id = newId();
    await writePart(store, id, Buffer.from('z'), kWrap);
    expect(await store.erasePart(id)).toBe('unlinked');
    expect(existsSync(store.partPath(id))).toBe(false);
  });

  it('no toca algo que no es un archivo', async () => {
    const vault = newVault();
    const store = new ObjectStore(vault);
    const id = newId();
    mkdirSync(store.objectPath(id), { recursive: true });
    expect(await store.eraseObject(id, KIND_MEDIA)).toBe('failed');
    expect(existsSync(store.objectPath(id))).toBe(true);
  });
});

describe('InFlight', () => {
  it('track/has/liberar, con referencias y liberación idempotente', () => {
    const set = new InFlight();
    const a = newId();
    const b = newId();
    const release1 = set.track(a, b, null, undefined);
    const release2 = set.track(a);
    expect(set.has(a)).toBe(true);
    expect(set.has(b)).toBe(true);
    expect(set.size).toBe(2);
    release1();
    release1();
    expect(set.has(a)).toBe(true);
    expect(set.has(b)).toBe(false);
    release2();
    expect(set.has(a)).toBe(false);
    expect(set.size).toBe(0);
    expect(() => set.track('no-es-un-id')).toThrow(RangeError);
  });
});
