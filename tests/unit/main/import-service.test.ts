// Servicio de importación (docs/DESIGN.md §12.3–§12.7, §12.11, §22; PLAN.md 2.9). Perfil, bóveda,
// DB y SessionManager reales bajo tests/.tmp/ (KDF rápido); ffmpeg empaquetado para los vídeos.
//
// Invariante principal: el original solo se borra en el paso 9, después de verificar, renombrar y
// confirmar; cualquier fallo anterior (inyectado en cada paso 0–7, también entre los dos renombrados
// del paso 6) lo deja intacto con el mismo SHA-256.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  writeSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppErrorException } from '@shared/errors';
import { KIND_MEDIA } from '../../../src/main/crypto/file-format';
import type { Db } from '../../../src/main/db/database';
import {
  importReplaceKey,
  kvGet,
  type ImportReplaceValue,
} from '../../../src/main/db/repos/kv-repo';
import {
  completeReplacement,
  deleteMedia,
  findByHmac,
  getMedia,
  insertPending,
  listMedia,
  renameMedia,
  undoReplacement,
  type NewMedia,
} from '../../../src/main/db/repos/media-repo';
import {
  FAULT_POINTS,
  IMPORT_PAUSES_AUTOLOCK,
  hasWin32AmbiguousSegment,
  type FaultPoint,
  type ImportFfmpeg,
} from '../../../src/main/import/import-service';
import type { SecureDeleteIo } from '../../../src/main/import/secure-delete';
import { defaultSecureDeleteIo } from '../../../src/main/import/secure-delete';
import { importHandlers } from '../../../src/main/ipc/handlers/import';
import { ObjectStore } from '../../../src/main/vault/object-store';
import { appErrorOf } from '../helpers/crypto';
import { ensureFixtures, fixturePath, type FixtureManifest } from '../helpers/fixtures';
import {
  haveFfmpeg,
  importHarness,
  mediaRows,
  missingFfmpeg,
  sha256File,
  vaultFiles,
  type ImportHarness,
} from '../helpers/import';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));
vi.mock('../../../src/main/window', () => ({
  getMainWindow: () => null,
  getRendererOrigin: () => 'app://bundle',
}));

// Cifrado, verificación y E/S reales: margen de sobra con la CPU cargada (PLAN.md, nota 112).
vi.setConfig({ testTimeout: 30_000 });

const tmp = makeTmpDir('import-service');
let manifest: FixtureManifest;
const open: ImportHarness[] = [];

beforeAll(() => {
  manifest = ensureFixtures();
}, 900_000);
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const h of open.splice(0)) await h.dispose();
});
afterAll(() => removeTmpDir(tmp));

async function harness(opts: Parameters<typeof importHarness>[1] = {}): Promise<ImportHarness> {
  const h = await importHarness(tmp, opts);
  open.push(h);
  return h;
}

/** Copia el fixture `key` a la carpeta de origen del test (con otro nombre si se pide). */
function copyFixture(h: ImportHarness, key: string, name?: string, dir = h.src): string {
  const from = fixturePath(manifest, key);
  if (!from) throw new Error(`sin fixture ${key}`);
  mkdirSync(dir, { recursive: true });
  const to = join(dir, name ?? (manifest.files[key]?.file as string));
  copyFileSync(from, to);
  return to;
}

function hmacOf(h: ImportHarness, path: string): Buffer {
  return createHmac('sha256', h.session.getKeyRing(h.session.epoch).kDedup)
    .update(readFileSync(path))
    .digest();
}

function emptyVault(h: ImportHarness): void {
  expect(vaultFiles(h.vaultDir)).toEqual({ objects: [], thumbs: [], tmp: [] });
  expect(mediaRows(h.db())).toEqual([]);
  expect(h.inFlight.size).toBe(0);
}

/** Descifra el objeto de la fila y devuelve su SHA-256. */
async function storedSha(h: ImportHarness, id: string): Promise<string> {
  const keys = h.session.getKeyRing(h.session.epoch);
  const reader = await new ObjectStore(h.vaultDir).open(id, KIND_MEDIA, keys.kWrap);
  try {
    return createHash('sha256')
      .update(await readAllOf(reader))
      .digest('hex');
  } finally {
    await reader.close();
  }
}

async function readAllOf(reader: {
  plaintextSize: number;
  createReadStream(a: number, b: number): NodeJS.ReadableStream;
}): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of reader.createReadStream(0, reader.plaintextSize - 1)) {
    parts.push(c as Buffer);
  }
  return Buffer.concat(parts);
}

const ioFault = (): never => {
  throw new AppErrorException({ code: 'IO', details: { reason: 'test-fault' } });
};

function failAt(h: ImportHarness, point: FaultPoint): void {
  h.faults.hook = (p) => {
    if (p === point) ioFault();
  };
}

/** Flip de un byte del ciphertext (offset 200, dentro del primer chunk). */
function corrupt(path: string): void {
  const fd = openSync(path, 'r+');
  try {
    const b = Buffer.alloc(1);
    readSync(fd, b, 0, 1, 200);
    b[0] = (b[0] as number) ^ 0xff;
    writeSync(fd, b, 0, 1, 200);
  } finally {
    closeSync(fd);
  }
}

describe('importación normal', () => {
  it('JPEG, PNG, WebP, GIF y AVIF: cifrados, verificados, en la galería y originales borrados', async () => {
    const h = await harness();
    const files = ['jpeg', 'png', 'webp', 'gif', 'avif'].map((k) => copyFixture(h, k));
    const report = await h.run(files);
    expect(report).toMatchObject({
      imported: 5,
      duplicates: 0,
      skipped: 0,
      failed: [],
      originalsNotDeleted: [],
      cancelled: false,
    });
    for (const f of files) expect(existsSync(f)).toBe(false);
    const items = listMedia(h.db(), { kind: 'all', sort: { field: 'name', dir: 'asc' } });
    expect(items).toHaveLength(5);
    const rows = mediaRows(h.db());
    expect(rows.every((r) => r.state === 'ready' && r.converted === 0)).toBe(true);
    const v = vaultFiles(h.vaultDir);
    expect(v.objects).toHaveLength(5);
    expect(v.thumbs).toHaveLength(5);
    expect(v.tmp).toEqual([]);
    expect(h.inFlight.size).toBe(0);
    // converted = 0: lo almacenado es el original byte a byte.
    const jpeg = items.find((i) => i.ext === 'jpg');
    expect(await storedSha(h, jpeg?.id as string)).toBe(manifest.files.jpeg?.sha256);
    // Fecha de captura del EXIF (2024:05:17 10:30:00, hora naive) y orientación 6 → vertical.
    const detail = getMedia(h.db(), jpeg?.id as string);
    expect(detail?.capturedAt).toBe(Date.UTC(2024, 4, 17, 10, 30, 0));
    expect(detail?.width).toBe(480);
    expect(detail?.height).toBe(640);
    expect(h.events.done).toHaveLength(1);
    expect(h.events.library.some((e) => e.reason === 'import')).toBe(true);
    expect(h.events.progress.at(-1)).toMatchObject({ total: 5, done: 5, imported: 5 });
  }, 60_000);

  it('una carpeta: se recorre, los originales se borran y la carpeta se conserva', async () => {
    const h = await harness();
    const dir = join(h.src, 'vacaciones');
    copyFixture(h, 'jpeg', undefined, dir);
    copyFixture(h, 'png', undefined, join(dir, 'sub'));
    writeFileSync(join(dir, 'notas.txt'), 'texto');
    const report = await h.run([dir]);
    expect(report).toMatchObject({ imported: 2, skipped: 1, failed: [] }); // .txt en carpeta: omitido
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'notas.txt'))).toBe(true);
  }, 60_000);

  it('BMP, HEIC, RAW y CR3 → UNSUPPORTED_FORMAT con el original intacto (también en carpetas)', async () => {
    const h = await harness();
    const raw = join(h.src, 'camara.NEF');
    writeFileSync(raw, Buffer.concat([Buffer.from('II*\0', 'latin1'), randomBytes(600)]));
    const files = [copyFixture(h, 'bmp'), copyFixture(h, 'heic'), copyFixture(h, 'cr3'), raw];
    const before = files.map(sha256File);
    const report = await h.run(files);
    expect(report?.imported).toBe(0);
    expect(report?.failed.map((f) => f.code)).toEqual(Array(4).fill('UNSUPPORTED_FORMAT'));
    expect(files.map(sha256File)).toEqual(before);
    emptyVault(h);

    const dir = join(h.src, 'carpeta');
    const inDir = [copyFixture(h, 'bmp', undefined, dir), copyFixture(h, 'cr3', undefined, dir)];
    const r2 = await h.run([dir]);
    expect(r2?.failed.map((f) => f.code)).toEqual(['UNSUPPORTED_FORMAT', 'UNSUPPORTED_FORMAT']);
    for (const f of inDir) expect(existsSync(f)).toBe(true);
  }, 60_000);

  it('un archivo desconocido elegido explícitamente → UNSUPPORTED_FORMAT; en carpeta, skipped', async () => {
    const h = await harness();
    const txt = join(h.src, 'nota.jpg');
    writeFileSync(txt, 'no soy una foto');
    const report = await h.run([txt]);
    expect(report?.failed).toEqual([{ name: 'nota.jpg', code: 'UNSUPPORTED_FORMAT' }]);
    expect(existsSync(txt)).toBe(true);
  });

  it('original modificado entre el escaneo y el proceso → CHANGED_DURING_IMPORT, intacto', async () => {
    const h = await harness();
    const file = copyFixture(h, 'jpeg');
    h.faults.hook = (point, ctx) => {
      if (point === 'begin' && ctx.path === file) appendFileSync(file, 'x');
    };
    const report = await h.run([file]);
    expect(report?.failed).toEqual([
      { name: manifest.files.jpeg?.file, code: 'CHANGED_DURING_IMPORT' },
    ]);
    expect(readFileSync(file).length).toBe((manifest.files.jpeg?.bytes as number) + 1);
    emptyVault(h);
  });

  it('Win32: los componentes con espacio o punto final se reconocen como ambiguos', () => {
    expect(hasWin32AmbiguousSegment('C:\\fotos\\foto.jpg ')).toBe(true);
    expect(hasWin32AmbiguousSegment('C:\\fotos.\\foto.jpg')).toBe(true);
    expect(hasWin32AmbiguousSegment('C:\\fotos\\..\\foto.jpg')).toBe(false);
    expect(hasWin32AmbiguousSegment('/home/x/foto.jpg')).toBe(false);
  });

  it('sin ffmpeg: el vídeo da FFMPEG_MISSING y la foto se importa', async () => {
    const h = await harness({ ffmpeg: missingFfmpeg });
    const photo = copyFixture(h, 'jpeg');
    const video = copyFixture(h, 'mp4Vp9Opus');
    const sha = sha256File(video);
    const report = await h.run([photo, video]);
    expect(report?.imported).toBe(1);
    expect(report?.failed).toEqual([
      { name: manifest.files.mp4Vp9Opus?.file, code: 'FFMPEG_MISSING' },
    ]);
    expect(sha256File(video)).toBe(sha);
  });

  it('[H3-11] pista sin codec_name o sin decodificador → UNSUPPORTED_FORMAT, sin D8, intacto', async () => {
    for (const stream of [{ codec_type: 'video' }, { codec_type: 'video', codec_name: 'hevc' }]) {
      const ffmpeg: ImportFfmpeg = {
        available: true,
        loadDecoders: async () => new Set(['vp9', 'h264']),
        run: async () =>
          Buffer.from(JSON.stringify({ streams: [stream], format: { duration: '4' } })),
        start: () => {
          throw new Error('no debería procesarse');
        },
      };
      const h = await harness({ ffmpeg });
      const video = copyFixture(h, 'mkvVp9Opus');
      const sha = sha256File(video);
      const report = await h.run([video]);
      expect(report?.failed.map((f) => f.code)).toEqual(['UNSUPPORTED_FORMAT']);
      expect(h.events.confirmNeeded).toEqual([]);
      expect(sha256File(video)).toBe(sha);
      emptyVault(h);
    }
  });
});

describe('inyección de fallos: el original sigue con el mismo SHA-256', () => {
  it.each([
    'begin',
    'step0',
    'step1',
    'step2',
    'step3',
    'step4',
    'step5',
    'step6',
    'step6b',
  ] as const)(
    'foto, fallo en %s → failed IO, original intacto y bóveda limpia',
    async (point) => {
      const h = await harness();
      const file = copyFixture(h, 'jpeg');
      failAt(h, point);
      const report = await h.run([file]);
      expect(report).toMatchObject({ imported: 0, failed: [{ code: 'IO' }] });
      expect(sha256File(file)).toBe(manifest.files.jpeg?.sha256);
      emptyVault(h);
    },
    30_000,
  );

  it('foto, fallo en step7 → original intacto; la fila pending y sus objetos quedan para la reconciliación', async () => {
    const h = await harness();
    const file = copyFixture(h, 'jpeg');
    failAt(h, 'step7');
    const report = await h.run([file]);
    expect(report).toMatchObject({ imported: 0, failed: [{ code: 'IO' }] });
    expect(sha256File(file)).toBe(manifest.files.jpeg?.sha256);
    const rows = mediaRows(h.db());
    expect(rows.map((r) => r.state)).toEqual(['pending']);
    const v = vaultFiles(h.vaultDir);
    expect([v.objects.length, v.thumbs.length, v.tmp.length]).toEqual([1, 1, 0]);
    expect(h.inFlight.size).toBe(0);
    // Reimportar el mismo original: el duplicado `pending` cuenta como skipped (§12.7).
    h.faults.hook = null;
    const again = await h.run([file]);
    expect(again).toMatchObject({ imported: 0, skipped: 1 });
    expect(existsSync(file)).toBe(true);
  }, 30_000);

  it('fallo en step8 → importado, el original se conserva (originalsNotDeleted IO) con su SHA-256', async () => {
    const h = await harness();
    const file = copyFixture(h, 'jpeg');
    failAt(h, 'step8');
    const report = await h.run([file]);
    expect(report).toMatchObject({
      imported: 1,
      originalsNotDeleted: [{ path: file, reason: 'IO' }],
    });
    expect(sha256File(file)).toBe(manifest.files.jpeg?.sha256);
  });

  it('fallo en step9 (el unlink del original) → originalsNotDeleted IO y la copia descifra al original', async () => {
    const h = await harness();
    const file = copyFixture(h, 'jpeg');
    failAt(h, 'step9');
    const report = await h.run([file]);
    expect(report).toMatchObject({
      imported: 1,
      originalsNotDeleted: [{ path: file, reason: 'IO' }],
    });
    const [row] = mediaRows(h.db());
    expect(row?.state).toBe('ready');
    expect(await storedSha(h, row?.id as string)).toBe(manifest.files.jpeg?.sha256);
  });

  it('secure-delete que no puede borrar (unlink falla) → originalsNotDeleted IO', async () => {
    const io: SecureDeleteIo = {
      ...defaultSecureDeleteIo,
      unlink: async () => {
        throw Object.assign(new Error('ocupado'), { code: 'EBUSY' });
      },
    };
    const h = await harness({ deps: { secureDeleteIo: io } });
    const file = copyFixture(h, 'png');
    const report = await h.run([file]);
    expect(report?.originalsNotDeleted).toEqual([{ path: file, reason: 'IO' }]);
    expect(report?.imported).toBe(1);
  });

  it('.part manipulado antes de verificar → INTEGRITY, original intacto, sin .part', async () => {
    const h = await harness();
    const file = copyFixture(h, 'png');
    h.faults.hook = (point) => {
      if (point !== 'step3') return;
      const [part] = vaultFiles(h.vaultDir).tmp;
      corrupt(join(h.vaultDir, 'tmp', part as string));
    };
    const report = await h.run([file]);
    expect(report?.failed).toEqual([{ name: manifest.files.png?.file, code: 'INTEGRITY' }]);
    expect(sha256File(file)).toBe(manifest.files.png?.sha256);
    emptyVault(h);
  });

  it('DISK_FULL antes de un archivo: se detiene el trabajo y los siguientes también fallan', async () => {
    let free = Number.MAX_SAFE_INTEGER;
    const h = await harness({ deps: { freeBytes: async () => free } });
    const a = copyFixture(h, 'jpeg');
    const b = copyFixture(h, 'png');
    h.faults.hook = (point, ctx) => {
      if (point === 'begin' && ctx.path === a) free = 1;
    };
    const report = await h.run([a, b]);
    expect(report?.failed.map((f) => f.code)).toEqual(['DISK_FULL', 'DISK_FULL']);
    expect(existsSync(a) && existsSync(b)).toBe(true);
    emptyVault(h);
  });

  it('el fault point de E2E admite exactamente los puntos documentados', () => {
    expect(FAULT_POINTS).toEqual([
      'scan',
      'begin',
      'step0',
      'step1',
      'step2',
      'step3',
      'step4',
      'step5',
      'step6',
      'step6b',
      'step7',
      'step8',
      'step9',
    ]);
  });
});

describe.skipIf(!haveFfmpeg)('vídeo', () => {
  it('MP4 VP9 tal cual (converted = 0) y MKV remultiplexado (converted = 1, MP4 fragmentado)', async () => {
    const h = await harness();
    const mp4 = copyFixture(h, 'mp4Vp9Opus');
    const mkv = copyFixture(h, 'mkvVp9Opus');
    const report = await h.run([mp4, mkv]);
    expect(report).toMatchObject({ imported: 2, failed: [], originalsNotDeleted: [] });
    expect(h.events.confirmNeeded).toEqual([]); // remultiplexar no pide confirmación (D8)
    const items = listMedia(h.db(), { kind: 'video', sort: { field: 'name', dir: 'asc' } });
    const byExt = Object.fromEntries(items.map((i) => [i.ext, getMedia(h.db(), i.id)]));
    expect(byExt.mp4).toMatchObject({ converted: false, mime: 'video/mp4' });
    expect(byExt.mkv).toMatchObject({ converted: true, mime: 'video/mp4', videoCodec: 'vp9' });
    expect(byExt.mkv?.durationMs).toBeGreaterThan(3000);
    expect(await storedSha(h, byExt.mp4?.id as string)).toBe(manifest.files.mp4Vp9Opus?.sha256);
    // converted = 1: lo almacenado no es byte a byte el original.
    expect(await storedSha(h, byExt.mkv?.id as string)).not.toBe(manifest.files.mkvVp9Opus?.sha256);
    expect(vaultFiles(h.vaultDir).thumbs).toHaveLength(2);
    expect(existsSync(mp4) || existsSync(mkv)).toBe(false);
  }, 120_000);

  it('reimportar un MKV remultiplexado → duplicates (no sustitución) y el original se borra', async () => {
    const h = await harness();
    const first = copyFixture(h, 'mkvVp9Opus', 'a.mkv');
    expect((await h.run([first]))?.imported).toBe(1);
    const [row] = mediaRows(h.db());
    const second = copyFixture(h, 'mkvVp9Opus', 'b.mkv');
    const report = await h.run([second]);
    expect(report).toMatchObject({ imported: 0, duplicates: 1, failed: [] });
    expect(existsSync(second)).toBe(false);
    expect(mediaRows(h.db())).toEqual([row]); // misma fila, sin sustituir
  }, 120_000);

  it.each(['step2', 'step3', 'step4', 'step6b'] as const)(
    'MKV remultiplexado, fallo en %s → original intacto y bóveda limpia',
    async (point) => {
      const h = await harness();
      const file = copyFixture(h, 'mkvVp9Flac');
      failAt(h, point);
      const report = await h.run([file]);
      expect(report?.failed.map((f) => f.code)).toEqual(['IO']);
      expect(sha256File(file)).toBe(manifest.files.mkvVp9Flac?.sha256);
      emptyVault(h);
    },
    120_000,
  );

  it('D8: MOV mpeg4 pide confirmación; convert: false lo omite (skipped) con el original intacto', async () => {
    const h = await harness();
    const mov = copyFixture(h, 'movMpeg4');
    const jpeg = copyFixture(h, 'jpeg');
    const { jobId, done } = h.start([mov, jpeg]);
    const ask = await h.events.nextConfirm();
    expect(ask).toEqual({ jobId, toConvert: 1, toConvertBytes: manifest.files.movMpeg4?.bytes });
    expect(h.events.progress.at(-1)?.phase).toBe('awaiting-confirmation');
    emptyVault(h); // no se ha tocado nada
    expect(existsSync(jpeg)).toBe(true);
    h.service.confirm(jobId, false);
    const report = await done;
    expect(report).toMatchObject({ imported: 1, skipped: 1, failed: [] });
    expect(sha256File(mov)).toBe(manifest.files.movMpeg4?.sha256);
    expect(existsSync(jpeg)).toBe(false);
  }, 120_000);

  it('D8: import:cancel en awaiting-confirmation no toca nada', async () => {
    const h = await harness();
    const mov = copyFixture(h, 'movMpeg4');
    const jpeg = copyFixture(h, 'jpeg');
    const { jobId, done } = h.start([mov, jpeg]);
    await h.events.nextConfirm();
    h.service.cancel(jobId);
    const report = await done;
    expect(report).toMatchObject({ imported: 0, cancelled: true, failed: [] });
    expect(sha256File(mov)).toBe(manifest.files.movMpeg4?.sha256);
    expect(sha256File(jpeg)).toBe(manifest.files.jpeg?.sha256);
    emptyVault(h);
    // Ya no está esperando: confirmar da NOT_FOUND.
    expect((await appErrorOf(() => h.service.confirm(jobId, true))).code).toBe('NOT_FOUND');
  }, 120_000);
});

describe('duplicados (§12.7)', () => {
  it('duplicado `ready` sano → duplicates y el original se borra', async () => {
    const h = await harness();
    const a = copyFixture(h, 'jpeg', 'a.jpg');
    await h.run([a]);
    const b = copyFixture(h, 'jpeg', 'b.jpg');
    const report = await h.run([b]);
    expect(report).toMatchObject({ imported: 0, duplicates: 1, originalsNotDeleted: [] });
    expect(existsSync(b)).toBe(false);
    expect(mediaRows(h.db())).toHaveLength(1);
  });

  it('la copia se borra (media:delete) mientras se comprueba → el original no se pierde', async () => {
    const h = await harness();
    const a = copyFixture(h, 'jpeg', 'a.jpg');
    await h.run([a]);
    const [row] = mediaRows(h.db());
    const oldId = row?.id as string;
    // El lector ya abierto conserva su DEK y su descriptor: la comprobación de salud sigue dando
    // "sano" aunque la fila y el objeto desaparezcan a mitad (el borrado de la galería).
    const realOpen = ObjectStore.prototype.open;
    let deleted = false;
    vi.spyOn(ObjectStore.prototype, 'open').mockImplementation(async function (
      this: ObjectStore,
      ...args: Parameters<ObjectStore['open']>
    ) {
      const reader = await realOpen.apply(this, args);
      if (!deleted && args[0] === oldId && !args[4]?.part) {
        deleted = true;
        deleteMedia(h.db(), [oldId]);
        await this.eraseObject(oldId, KIND_MEDIA);
      }
      return reader;
    });
    const b = copyFixture(h, 'jpeg', 'b.jpg');
    const report = await h.run([b]);
    expect(deleted).toBe(true);
    // La copia ya no existía: se importa como nuevo y solo entonces se borra el original.
    expect(report).toMatchObject({
      imported: 1,
      duplicates: 0,
      failed: [],
      originalsNotDeleted: [],
    });
    expect(existsSync(b)).toBe(false);
    const rows = mediaRows(h.db());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(oldId);
    expect(await storedSha(h, rows[0]?.id as string)).toBe(manifest.files.jpeg?.sha256);
    expect(h.inFlight.size).toBe(0);
  });

  it('duplicado `pending` (otro trabajo) → skipped y el original no se toca', async () => {
    const h = await harness();
    const file = copyFixture(h, 'jpeg');
    insertPending(h.db(), fakeMedia(hmacOf(h, file)));
    const report = await h.run([file]);
    expect(report).toMatchObject({ imported: 0, skipped: 1, duplicates: 0 });
    expect(sha256File(file)).toBe(manifest.files.jpeg?.sha256);
  });

  it('SQLITE_CONSTRAINT_UNIQUE en el paso 5 (fusión en paralelo) → skipped, sin .part, intacto', async () => {
    const h = await harness();
    const file = copyFixture(h, 'jpeg');
    h.faults.hook = (point) => {
      if (point === 'step5') insertPending(h.db(), fakeMedia(hmacOf(h, file)));
    };
    const report = await h.run([file]);
    expect(report).toMatchObject({ imported: 0, skipped: 1, failed: [] });
    expect(sha256File(file)).toBe(manifest.files.jpeg?.sha256);
    expect(vaultFiles(h.vaultDir)).toEqual({ objects: [], thumbs: [], tmp: [] });
    expect(mediaRows(h.db())).toHaveLength(1); // solo la de la "fusión"
  });

  /** Importa A, lo renombra, le añade ediciones y lo mete en dos playlists; corrompe su objeto. */
  async function damagedWithHistory(h: ImportHarness): Promise<{
    oldId: string;
    importedAt: number;
    hmac: Buffer;
    file: string;
  }> {
    const a = copyFixture(h, 'jpeg', 'a.jpg');
    await h.run([a]);
    const db = h.db();
    const [row] = mediaRows(db);
    const oldId = row?.id as string;
    renameMedia(db, oldId, 'Mi foto favorita');
    db.prepare(
      'INSERT INTO media_edits (media_id, seq, op_json, created_at) VALUES (?, ?, ?, ?)',
    ).run(oldId, 0, '{"t":"flipH"}', 1);
    db.prepare(
      'INSERT INTO media_edits (media_id, seq, op_json, created_at) VALUES (?, ?, ?, ?)',
    ).run(oldId, 1, '{"t":"rotate","q":1}', 2);
    for (const [i, name] of ['Viaje', 'Familia'].entries()) {
      const pid = randomBytes(16).toString('hex');
      db.prepare(
        'INSERT INTO playlists (id, name, name_fold, created_at, updated_at) VALUES (?, ?, ?, 1, 1)',
      ).run(pid, name, name.toLowerCase());
      // Otro elemento delante para que la posición no sea 0.
      const other = randomBytes(16).toString('hex');
      insertPending(db, { ...fakeMedia(randomBytes(32)), id: other });
      db.prepare("UPDATE media SET state = 'ready' WHERE id = ?").run(other);
      db.prepare(
        'INSERT INTO playlist_items (playlist_id, media_id, position, added_at) VALUES (?, ?, ?, 1)',
      ).run(pid, other, 0);
      db.prepare(
        'INSERT INTO playlist_items (playlist_id, media_id, position, added_at) VALUES (?, ?, ?, 1)',
      ).run(pid, oldId, i + 1);
    }
    const importedAt = (getMedia(db, oldId) as { importedAt: number }).importedAt;
    const objectPath = new ObjectStore(h.vaultDir).objectPath(oldId);
    corrupt(objectPath);
    const file = copyFixture(h, 'jpeg', 'a-otra-vez.jpg');
    return { oldId, importedAt, hmac: hmacOf(h, file), file };
  }

  function positions(db: Db, id: string): { name: string; position: number }[] {
    return db
      .prepare(
        `SELECT p.name, pi.position FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id
         WHERE pi.media_id = ? ORDER BY p.name`,
      )
      .all(id) as { name: string; position: number }[];
  }

  function expectReplaced(db: Db, oldId: string, newId: string, importedAt: number): void {
    const detail = getMedia(db, newId);
    expect(detail).toMatchObject({ name: 'Mi foto favorita', importedAt });
    expect(detail?.edits).toEqual([{ t: 'flipH' }, { t: 'rotate', q: 1 }]);
    expect(positions(db, newId)).toEqual([
      { name: 'Familia', position: 2 },
      { name: 'Viaje', position: 1 },
    ]);
    expect(getMedia(db, oldId)).toBeNull();
    expect(kvGet(db, importReplaceKey(newId))).toBeNull();
  }

  it('objeto dañado + reimportar → sustitución que conserva nombre, fecha, ediciones y playlists', async () => {
    const h = await harness();
    const { oldId, importedAt, file } = await damagedWithHistory(h);
    const oldObject = new ObjectStore(h.vaultDir).objectPath(oldId);
    const report = await h.run([file]);
    expect(report).toMatchObject({ imported: 1, duplicates: 0, failed: [] });
    expect(existsSync(file)).toBe(false);
    const db = h.db();
    const newId = mediaRows(db).find((r) => r.name === 'Mi foto favorita')?.id as string;
    expect(newId).not.toBe(oldId);
    expectReplaced(db, oldId, newId, importedAt);
    expect(existsSync(oldObject)).toBe(false); // borrado criptográfico tras el COMMIT de B
    expect(await storedSha(h, newId)).toBe(manifest.files.jpeg?.sha256);
  });

  it('caída entre A y B (antes del paso 7): nada se pierde; la reconciliación la termina', async () => {
    const h = await harness();
    const { oldId, importedAt, hmac, file } = await damagedWithHistory(h);
    h.faults.hook = (point) => {
      if (point === 'step7') void h.session.lock('suspend'); // la "caída": nada más se ejecuta
    };
    expect(await h.run([file])).toBeNull(); // abortado: sin import:done
    expect(sha256File(file)).toBe(manifest.files.jpeg?.sha256);
    await h.unlock();
    const db = h.db();
    // Antes de la reconciliación: la fila antigua sigue visible (dañada) con un HMAC aleatorio; la
    // nueva está `pending` (invisible) y kv guarda { old, hmac } en minúsculas.
    const visible = listMedia(db, { kind: 'all', sort: { field: 'name', dir: 'asc' } });
    expect(visible.some((i) => i.id === oldId && i.name === 'Mi foto favorita')).toBe(true);
    const pending = mediaRows(db).filter((r) => r.state === 'pending');
    expect(pending).toHaveLength(1);
    const newId = pending[0]?.id as string;
    expect(kvGet(db, importReplaceKey(newId))).toEqual({ old: oldId, hmac: hmac.toString('hex') });
    expect(findByHmac(db, hmac)?.id).toBe(newId);
    // Después (12.6 punto 2: la fila nueva existe → transacción B).
    expect(completeReplacement(db, newId, oldId)).toMatchObject({ ok: true, oldExisted: true });
    expectReplaced(db, oldId, newId, importedAt);
  });

  it('caída entre A y el renombrado: los .part se borran y la reconciliación deshace A', async () => {
    const h = await harness();
    const { oldId, hmac, file } = await damagedWithHistory(h);
    h.faults.hook = (point) => {
      if (point === 'step6') void h.session.lock('suspend');
    };
    expect(await h.run([file])).toBeNull();
    await h.session.cleanup.idle();
    expect(vaultFiles(h.vaultDir).tmp).toEqual([]); // .part borrados por KeylessCleanup
    expect(sha256File(file)).toBe(manifest.files.jpeg?.sha256);
    await h.unlock();
    const db = h.db();
    const newId = mediaRows(db).find((r) => r.state === 'pending')?.id as string;
    // 12.6: la fila nueva no tiene objeto ni .part → se borra, y A se deshace con el HMAC de kv.
    const saved = kvGet(db, importReplaceKey(newId)) as ImportReplaceValue | null;
    expect(saved).toEqual({ old: oldId, hmac: hmac.toString('hex') });
    undoReplacement(db, newId, oldId, Buffer.from(saved?.hmac as string, 'hex'));
    expect(findByHmac(db, hmac)).toEqual({ id: oldId, state: 'ready', converted: false });
    expect(getMedia(db, oldId)?.name).toBe('Mi foto favorita');
    expect(positions(db, oldId)).toHaveLength(2);
  });
});

describe('concurrencia, cancelación y bloqueo', () => {
  it('segunda importación → BUSY antes de abrir el diálogo', async () => {
    const h = await harness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    h.faults.hook = async (point) => {
      if (point === 'scan') await gate;
    };
    const first = h.start([copyFixture(h, 'jpeg')]);
    const showOpenDialog = vi.fn(async () => ({ canceled: true, filePaths: [] }));
    const handlers = importHandlers({ service: h.service, showOpenDialog });
    expect((await appErrorOf(() => handlers.chooseFiles())).code).toBe('BUSY');
    expect((await appErrorOf(() => handlers.chooseFolder())).code).toBe('BUSY');
    expect((await appErrorOf(() => handlers.paths({ paths: [h.src] }))).code).toBe('BUSY');
    expect(showOpenDialog).not.toHaveBeenCalled();
    release();
    expect((await first.done)?.imported).toBe(1);
    // Libre otra vez: el diálogo se abre (dontAddToRecent) y cancelarlo no deja nada reservado.
    expect(await handlers.chooseFiles()).toBeNull();
    expect(showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      }),
    );
    expect(await handlers.chooseFolder()).toBeNull();
    expect(showOpenDialog).toHaveBeenLastCalledWith({
      properties: ['openDirectory', 'dontAddToRecent'],
    });
    h.session.startJob('import').done(); // ya no queda ninguna reserva
  });

  it('import:cancel durante el proceso: los archivos que faltan no se tocan', async () => {
    const h = await harness();
    const a = copyFixture(h, 'jpeg');
    const b = copyFixture(h, 'png');
    let jobId = '';
    h.faults.hook = (point, ctx) => {
      if (point === 'step2' && ctx.path === a) h.service.cancel(jobId);
    };
    const job = h.start([a, b]);
    jobId = job.jobId;
    const report = await job.done;
    expect(report).toMatchObject({ imported: 0, cancelled: true, failed: [] });
    expect(sha256File(a)).toBe(manifest.files.jpeg?.sha256);
    expect(sha256File(b)).toBe(manifest.files.png?.sha256);
    emptyVault(h);
  });

  it('import:cancel después del paso 5: se completan 6–7 y el original se conserva (CANCELLED)', async () => {
    const h = await harness();
    const a = copyFixture(h, 'jpeg');
    const b = copyFixture(h, 'png');
    let jobId = '';
    h.faults.hook = (point, ctx) => {
      if (point === 'step6' && ctx.path === a) h.service.cancel(jobId);
    };
    const job = h.start([a, b]);
    jobId = job.jobId;
    const report = await job.done;
    expect(report).toMatchObject({
      imported: 1,
      cancelled: true,
      originalsNotDeleted: [{ path: a, reason: 'CANCELLED' }],
    });
    expect(sha256File(a)).toBe(manifest.files.jpeg?.sha256);
    expect(existsSync(b)).toBe(true);
    expect(mediaRows(h.db()).map((r) => r.state)).toEqual(['ready']);
  });

  it('[H3-6] lock(suspend) entre los dos renombrados del paso 6 + desbloqueo inmediato: el trabajo antiguo no toca la DB nueva y sus borrados van por KeylessCleanup', async () => {
    const h = await harness();
    const file = copyFixture(h, 'jpeg');
    const spies: ReturnType<typeof vi.spyOn>[] = [];
    const keylessRun = vi.spyOn(h.session.cleanup, 'run');
    let thumbPart = '';
    h.faults.hook = async (point) => {
      if (point !== 'step6b') return;
      thumbPart = join(h.vaultDir, 'tmp', vaultFiles(h.vaultDir).tmp[0] as string);
      void h.session.lock('suspend'); // claves a cero en el acto
      await h.unlock(); // la sesión nueva se abre mientras el trabajo antiguo sigue vivo
      const db = h.db();
      for (const m of ['prepare', 'exec', 'transaction', 'pragma'] as const) {
        spies.push(vi.spyOn(db, m));
      }
    };
    const report = await h.run([file]);
    expect(report).toBeNull(); // abortado: sin import:done a la ventana nueva
    expect(h.events.done).toEqual([]);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(keylessRun).toHaveBeenCalledWith(thumbPart, expect.any(Function));
    await h.session.cleanup.idle();
    // objects/ no se tocó (el objeto renombrado sigue); el .part de la miniatura ya no está.
    const v = vaultFiles(h.vaultDir);
    expect(v.objects).toHaveLength(1);
    expect(v.thumbs).toEqual([]);
    expect(v.tmp).toEqual([]);
    for (const s of spies) s.mockRestore();
    expect(mediaRows(h.db()).map((r) => r.state)).toEqual(['pending']); // para la reconciliación
    expect(sha256File(file)).toBe(manifest.files.jpeg?.sha256);
    expect(h.inFlight.size).toBe(0);
  }, 30_000);
});

describe('D18: auto-bloqueo durante la importación (reloj falso)', () => {
  const FAKE: Parameters<typeof vi.useFakeTimers>[0] = {
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  };

  it('IMPORT_PAUSES_AUTOLOCK es la recomendación aplicada', () => {
    expect(IMPORT_PAUSES_AUTOLOCK).toBe(true);
  });

  it.each(['scan', 'step2'] as const)(
    'sin bloqueo por inactividad tras 10 min con el trabajo parado en %s',
    async (point) => {
      vi.useFakeTimers(FAKE);
      const h = await harness();
      let release: () => void = () => undefined;
      let reached: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      const atGate = new Promise<void>((r) => (reached = r));
      h.faults.hook = async (p) => {
        if (p !== point) return;
        reached();
        await gate;
      };
      const job = h.start([copyFixture(h, 'jpeg')]);
      await atGate;
      expect(h.session.autoLockPauseReasons).toContain('job');
      vi.advanceTimersByTime(10 * 60_000);
      expect(h.session.state).toBe('unlocked');
      release();
      expect((await job.done)?.imported).toBe(1);
      expect(h.session.autoLockPauseReasons).not.toContain('job');
    },
    60_000,
  );

  it.skipIf(!haveFfmpeg)(
    'en awaiting-confirmation el temporizador corre desde cero, bloquea a los autoLockMinutes y cancela sin tocar nada',
    async () => {
      vi.useFakeTimers(FAKE);
      const h = await harness();
      const mov = copyFixture(h, 'movMpeg4');
      const jpeg = copyFixture(h, 'jpeg');
      const job = h.start([mov, jpeg]);
      await h.events.nextConfirm();
      expect(h.session.autoLockPauseReasons).not.toContain('job');
      vi.advanceTimersByTime(5 * 60_000 - 1); // prefs.autoLockMinutes = 5 por defecto
      expect(h.session.state).toBe('unlocked');
      vi.advanceTimersByTime(1);
      expect(h.session.state).not.toBe('unlocked');
      expect(await job.done).toBeNull();
      await vi.waitFor(() => expect(h.session.state).toBe('locked'));
      expect(sha256File(mov)).toBe(manifest.files.movMpeg4?.sha256);
      expect(sha256File(jpeg)).toBe(manifest.files.jpeg?.sha256);
      vi.useRealTimers();
      await h.unlock();
      emptyVault(h);
    },
    120_000,
  );
});

function fakeMedia(hmac: Buffer): NewMedia {
  return {
    id: randomBytes(16).toString('hex'),
    kind: 'photo',
    source: 'merge',
    name: 'otra',
    originalExt: 'jpg',
    mime: 'image/jpeg',
    sizeBytes: 1,
    originalSizeBytes: 1,
    width: 1,
    height: 1,
    durationMs: null,
    fps: null,
    hasAudio: null,
    videoCodec: null,
    audioCodec: null,
    converted: false,
    capturedAt: 0,
    capturedAtSource: 'generated',
    importedAt: 0,
    contentHmac: hmac,
    thumbId: null,
  };
}
