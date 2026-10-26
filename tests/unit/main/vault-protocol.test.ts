// vault://media|thumb (docs/DESIGN.md §11) con requests simulados, una DB SQLCipher real y objetos
// cifrados reales: Range, cabeceras de §11.3, errores de §11.4 y streams cortados al bloquear (§11.5).
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppErrorException } from '@shared/errors';
import { CHUNK, KIND_MEDIA, KIND_THUMB } from '../../../src/main/crypto/file-format';
import { KeyRing } from '../../../src/main/crypto/keys';
import type { ObjectReader } from '../../../src/main/crypto/object-reader';
import { closeDatabase, type Db } from '../../../src/main/db/database';
import { migrate } from '../../../src/main/db/migrate';
import {
  handleVaultRequest,
  sessionObjectSource,
  type VaultProtocolDeps,
} from '../../../src/main/protocol/vault-protocol';
import { ObjectStore } from '../../../src/main/vault/object-store';
import { createDb } from '../helpers/db';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const ORIGIN = 'app://bundle';
const newId = (): string => randomBytes(16).toString('hex');
const locked = (): AppErrorException => new AppErrorException({ code: 'LOCKED' });

/** Sesión falsa con la forma que usa sessionObjectSource (épocas, claves, señal y readers). */
class FakeSession {
  epoch = 1;
  unlocked = true;
  maintenance = false;
  controller = new AbortController();
  readonly readers = new Set<ObjectReader>();
  constructor(
    private db: Db | null,
    private keyRing: KeyRing | null,
    private vaultDir: string,
  ) {}
  getDb(epoch?: number): Db {
    if (!this.db || epoch !== this.epoch) throw locked();
    return this.db;
  }
  getKeyRing(epoch?: number): KeyRing {
    if (!this.keyRing || epoch !== this.epoch) throw locked();
    return this.keyRing;
  }
  getVaultDir(epoch?: number): string {
    if (epoch !== this.epoch) throw locked();
    return this.vaultDir;
  }
  getSessionSignal(epoch?: number): AbortSignal {
    if (epoch !== this.epoch) throw locked();
    return this.controller.signal;
  }
  registerReader(reader: ObjectReader, epoch?: number): () => void {
    if (!this.keyRing || epoch !== this.epoch) {
      reader.destroyKeys();
      throw locked();
    }
    this.readers.add(reader);
    return () => {
      this.readers.delete(reader);
    };
  }
  /** Pasos 1, 2 y 4 de §13.3: estado locking, abortar la sesión, claves y DB a cero. */
  lock(): void {
    this.unlocked = false;
    this.controller.abort('manual');
    for (const r of this.readers) r.destroyKeys();
    this.readers.clear();
    this.keyRing?.zeroize();
    this.keyRing = null;
    this.db = null;
  }
}

const root = makeTmpDir('vault-protocol-media');
const vaultDir = join(root, 'vault');
for (const sub of ['objects', 'thumbs', 'tmp']) mkdirSync(join(vaultDir, sub), { recursive: true });
const profileId = newId();
const store = new ObjectStore(vaultDir);
let db: Db;
let keyRing: KeyRing;
let session: FakeSession;

const photo = randomBytes(3 * CHUNK + 777);
const thumb = randomBytes(5000);
const ids = {
  ready: newId(),
  thumb: newId(),
  pending: newId(),
  missing: newId(),
  tampered: newId(),
  noThumb: newId(),
  empty: newId(),
};

function insert(
  id: string,
  opts: { state?: string; thumbId?: string | null; mime?: string; size?: number },
): void {
  db.prepare(
    `INSERT INTO media (id, kind, state, source, name, name_fold, original_ext, mime, size_bytes,
       original_size_bytes, captured_at, captured_at_source, imported_at, content_hmac, thumb_id)
     VALUES (?, 'photo', ?, 'import', 'foto', 'foto', 'jpg', ?, ?, ?, 0, 'generated', 0, ?, ?)`,
  ).run(
    id,
    opts.state ?? 'ready',
    opts.mime ?? 'image/jpeg',
    opts.size ?? 0,
    opts.size ?? 0,
    randomBytes(32),
    opts.thumbId ?? null,
  );
}

async function storeObject(
  id: string,
  data: Buffer,
  kind: typeof KIND_MEDIA | typeof KIND_THUMB,
): Promise<void> {
  const writer = store.createWriter({ id, kind, kWrap: keyRing.kWrap });
  await writer.write(data);
  await writer.finish();
  await store.promote(id, kind);
}

beforeAll(async () => {
  const created = createDb(root);
  db = created.db;
  migrate(db, created.path);
  keyRing = new KeyRing(randomBytes(32), profileId);
  session = new FakeSession(db, keyRing, vaultDir);

  await storeObject(ids.ready, photo, KIND_MEDIA);
  await storeObject(ids.thumb, thumb, KIND_THUMB);
  insert(ids.ready, { thumbId: ids.thumb, size: photo.length });
  await storeObject(ids.pending, photo, KIND_MEDIA);
  insert(ids.pending, { state: 'pending' });
  insert(ids.missing, {});
  await storeObject(ids.tampered, photo, KIND_MEDIA);
  insert(ids.tampered, {});
  const path = store.objectPath(ids.tampered);
  const bytes = readFileSync(path);
  bytes[70] ^= 0x01; // wrappedDek: la cabecera ya no autentica
  writeFileSync(path, bytes);
  await storeObject(ids.noThumb, photo, KIND_MEDIA);
  insert(ids.noThumb, { thumbId: null });
  await storeObject(ids.empty, Buffer.alloc(0), KIND_MEDIA);
  insert(ids.empty, { mime: 'video/mp4' });
});

afterAll(() => {
  closeDatabase(db);
  removeTmpDir(root);
});

function deps(s: FakeSession = session): VaultProtocolDeps {
  return {
    avatarFile: () => join(root, 'nada.webp'),
    pendingAvatar: () => null,
    rendererOrigin: () => ORIGIN,
    isUnlocked: () => s.unlocked,
    inMaintenance: () => s.maintenance,
    objects: sessionObjectSource(s),
  };
}

function get(url: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Response> {
  return handleVaultRequest(new Request(url, { method, headers }), deps());
}

async function expectError(res: Response, status: number, code: string | null): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get('x-galeria-error')).toBe(code);
  expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect((await res.arrayBuffer()).byteLength).toBe(0);
}

describe('vault://media', () => {
  it('200 con los bytes exactos y las cabeceras de §11.3', async () => {
    const res = await get(`vault://media/${ids.ready}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(photo)).toBe(true);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-length')).toBe(String(photo.length));
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-range')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-expose-headers')).toBe(
      'Content-Range, Content-Length, Accept-Ranges',
    );
    expect(session.readers.size).toBe(0); // el lector se libera al terminar
  });

  it('206 con los bytes exactos del rango (cruzando chunks)', async () => {
    const P = photo.length;
    for (const [a, b] of [
      [0, 0],
      [CHUNK - 3, CHUNK + 3],
      [100, 2 * CHUNK + 50],
      [P - 1, P - 1],
    ] as const) {
      const res = await get(`vault://media/${ids.ready}`, { Range: `bytes=${a}-${b}` });
      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(`bytes ${a}-${b}/${P}`);
      expect(res.headers.get('content-length')).toBe(String(b - a + 1));
      expect(Buffer.from(await res.arrayBuffer()).equals(photo.subarray(a, b + 1))).toBe(true);
    }
    const suffix = await get(`vault://media/${ids.ready}`, { Range: 'bytes=-5' });
    expect(Buffer.from(await suffix.arrayBuffer()).equals(photo.subarray(P - 5))).toBe(true);
    const open = await get(`vault://media/${ids.ready}`, { Range: `bytes=${P - 10}-` });
    expect(open.headers.get('content-range')).toBe(`bytes ${P - 10}-${P - 1}/${P}`);
    await open.arrayBuffer();
    const many = await get(`vault://media/${ids.ready}`, { Range: 'bytes=0-1,3-4' });
    expect(many.status).toBe(200);
    expect((await many.arrayBuffer()).byteLength).toBe(P);
  });

  it('HEAD con Range → 206 con las cabeceras y sin cuerpo; HEAD sin Range → 200', async () => {
    const res = await get(`vault://media/${ids.ready}`, { Range: 'bytes=10-19' }, 'HEAD');
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 10-19/${photo.length}`);
    expect(res.headers.get('content-length')).toBe('10');
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    const head = await get(`vault://media/${ids.ready}`, {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(photo.length));
    expect(session.readers.size).toBe(0);
  });

  it('416 con Content-Range bytes */P (a ≥ P, bytes=-0, P = 0)', async () => {
    const P = photo.length;
    for (const range of [`bytes=${P}-`, 'bytes=-0']) {
      const res = await get(`vault://media/${ids.ready}`, { Range: range });
      await expectError(res, 416, null);
      expect(res.headers.get('content-range')).toBe(`bytes */${P}`);
    }
    const empty = await get(`vault://media/${ids.empty}`, { Range: 'bytes=0-' });
    await expectError(empty, 416, null);
    expect(empty.headers.get('content-range')).toBe('bytes */0');
    const full = await get(`vault://media/${ids.empty}`);
    expect(full.status).toBe(200);
    expect(full.headers.get('content-length')).toBe('0');
    expect(full.headers.get('content-type')).toBe('video/mp4');
  });

  it('id con formato inválido → 400 VALIDATION', async () => {
    for (const url of [
      'vault://media/no-es-un-id',
      `vault://media/${ids.ready.toUpperCase()}`,
      `vault://media/${ids.ready}/extra`,
      `vault://media/`,
      `vault://thumb/${ids.ready}?rev=x`,
      `vault://media/..%2F${ids.ready}`,
    ]) {
      await expectError(await get(url), 400, 'VALIDATION');
    }
  });

  it('id inexistente, fila pending o archivo ausente → 404 NOT_FOUND', async () => {
    await expectError(await get(`vault://media/${newId()}`), 404, 'NOT_FOUND');
    await expectError(await get(`vault://media/${ids.pending}`), 404, 'NOT_FOUND');
    await expectError(await get(`vault://media/${ids.missing}`), 404, 'NOT_FOUND');
  });

  it('objeto manipulado → 500 INTEGRITY', async () => {
    await expectError(await get(`vault://media/${ids.tampered}`), 500, 'INTEGRITY');
    expect(session.readers.size).toBe(0);
  });

  it('maintenance → 503 BUSY', async () => {
    session.maintenance = true;
    try {
      await expectError(await get(`vault://media/${ids.ready}`), 503, 'BUSY');
      await expectError(await get(`vault://thumb/${ids.ready}`), 503, 'BUSY');
    } finally {
      session.maintenance = false;
    }
  });
});

describe('vault://thumb', () => {
  it('sirve la miniatura de thumb_id como image/webp; sin thumb_id → 404', async () => {
    const res = await get(`vault://thumb/${ids.ready}?rev=2`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(Buffer.from(await res.arrayBuffer()).equals(thumb)).toBe(true);
    await expectError(await get(`vault://thumb/${ids.noThumb}`), 404, 'NOT_FOUND');
    // El id de la miniatura no es un mediaId.
    await expectError(await get(`vault://thumb/${ids.thumb}`), 404, 'NOT_FOUND');
  });
});

describe('vault:// con la bóveda bloqueada (§11.5)', () => {
  it('un stream en curso termina con error al bloquear y después todo responde 423', async () => {
    const big = newId();
    const data = randomBytes(40 * CHUNK);
    await storeObject(big, data, KIND_MEDIA);
    insert(big, { size: data.length, mime: 'video/mp4' });

    const res = await get(`vault://media/${big}`);
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value as Uint8Array).equals(data.subarray(0, CHUNK))).toBe(true);
    expect(session.readers.size).toBe(1);

    session.lock();
    let failed: unknown = null;
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch (err) {
      failed = err;
    }
    expect(failed).toMatchObject({ error: { code: 'LOCKED' } });

    for (const url of [
      `vault://media/${ids.ready}`,
      `vault://thumb/${ids.ready}`,
      `vault://music/${ids.ready}`,
    ]) {
      await expectError(await get(url), 423, 'LOCKED');
    }
    // Aunque isUnlocked dijera true, la sesión ya no entrega DB ni claves: 423.
    session.unlocked = true;
    await expectError(await get(`vault://media/${ids.ready}`), 423, 'LOCKED');
    session.unlocked = false;
  });
});
