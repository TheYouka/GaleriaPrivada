// Importar música (docs/DESIGN.md §8.6.1; PLAN.md 4.2) con perfil, bóveda, DB y SessionManager
// reales bajo tests/.tmp/ (KDF rápido) y tonos generados por el ffmpeg empaquetado (nunca música
// real): el original conserva su SHA-256 y sigue en su sitio, la copia se hace en music/ con un
// nombre neutro (<32 hex>.<ext>, nada del nombre original), firmas inválidas → UNSUPPORTED_FORMAT,
// archivo ilegible → IO, > límite → TOO_LARGE, 201 archivos → VALIDATION, BUSY, DISK_FULL, bloqueo
// a mitad, music:delete y music:rename.
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenDialogOptions } from 'electron';
import { AppErrorException } from '../../../src/shared/errors';
import { KV_DEFAULT_TRACKS, kvGet, kvSet } from '../../../src/main/db/repos/kv-repo';
import { listTracks } from '../../../src/main/db/repos/music-repo';
import {
  createPlaylist,
  playlistPresentation,
  setPlaylistPresentation,
} from '../../../src/main/db/repos/playlist-repo';
import { CHOOSE_MUSIC_OPTIONS, musicHandlers } from '../../../src/main/ipc/handlers/music';
import {
  MusicService,
  parseMusicProbe,
  trackTitle,
  UNTITLED_TRACK,
  type MusicServiceDeps,
} from '../../../src/main/music/music-service';
import { DEFAULT_PRESENTATION } from '../../../src/shared/presentation';
import { writeTone, type ToneFormat } from '../helpers/audio';
import { haveFfmpeg, importHarness, realFfmpeg, type ImportHarness } from '../helpers/import';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

vi.setConfig({ testTimeout: 60_000 });

const tmp = makeTmpDir('music-service');
const open: ImportHarness[] = [];

afterEach(async () => {
  for (const h of open.splice(0)) await h.dispose();
});
afterAll(() => removeTmpDir(tmp));

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

async function harness(): Promise<ImportHarness> {
  const h = await importHarness(tmp);
  open.push(h);
  return h;
}

async function service(
  h: ImportHarness,
  deps: Partial<MusicServiceDeps> = {},
): Promise<MusicService> {
  return new MusicService({
    session: h.session,
    ffmpeg: haveFfmpeg ? await realFfmpeg() : null,
    inFlight: h.inFlight,
    ...deps,
  });
}

function musicDir(h: ImportHarness): string {
  return join(h.vaultDir, 'music');
}

function musicFiles(h: ImportHarness): string[] {
  return existsSync(musicDir(h)) ? readdirSync(musicDir(h)).sort() : [];
}

/** Carpeta de origen con un nombre de archivo que lleva un marcador aleatorio. */
function sourceDir(h: ImportHarness): string {
  const dir = join(h.src, `música-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function run(svc: MusicService, paths: string[]) {
  return svc.importFiles(svc.reserve(), paths);
}

describe.runIf(haveFfmpeg)('music:import con el ffmpeg empaquetado', () => {
  it('copia la pista a music/ con nombre neutro y el original queda intacto (mismo SHA-256)', async () => {
    const h = await harness();
    const dir = sourceDir(h);
    const marker = `CancionSecreta${Date.now().toString(36)}`;
    const original = writeTone(dir, `${marker} (directo).wav`, 'wav', 1);
    const before = { sha: sha(original), stat: statSync(original) };

    const result = await run(await service(h), [original]);

    expect(result.failed).toEqual([]);
    expect(result.imported).toHaveLength(1);
    const track = result.imported[0]!;
    expect(track.title).toBe(`${marker} (directo)`);
    expect(track.sizeBytes).toBe(before.stat.size);
    expect(track.durationMs).toBeGreaterThan(900);
    expect(track.durationMs).toBeLessThan(1100);

    // El original: en su sitio, mismo contenido, mismo tamaño y misma fecha de modificación.
    expect(existsSync(original)).toBe(true);
    expect(sha(original)).toBe(before.sha);
    expect(statSync(original).size).toBe(before.stat.size);
    expect(statSync(original).mtimeMs).toBe(before.stat.mtimeMs);
    expect(readdirSync(dir)).toEqual([`${marker} (directo).wav`]);

    // La copia: un único archivo <trackId>.wav, byte a byte igual, sin nada del nombre original.
    const files = musicFiles(h);
    expect(files).toEqual([`${track.id}.wav`]);
    expect(sha(join(musicDir(h), files[0]!))).toBe(before.sha);
    for (const f of files) expect(f.toLowerCase()).not.toContain(marker.toLowerCase());
    expect(h.inFlight.size).toBe(0);

    // La fila (en la DB cifrada) lleva el título y el MIME; music:list la devuelve.
    const row = h.db().prepare('SELECT file_name, ext, mime FROM music_tracks').get() as {
      file_name: string;
      ext: string;
      mime: string;
    };
    expect(row).toEqual({ file_name: `${track.id}.wav`, ext: 'wav', mime: 'audio/wav' });
    expect(listTracks(h.db())).toEqual([track]);
  });

  it('acepta MP3 (ID3 y sync), AAC, M4A, MP4 solo audio, Ogg (Vorbis y Opus), FLAC y WAV', async () => {
    const h = await harness();
    const dir = sourceDir(h);
    const formats: [ToneFormat, string][] = [
      ['mp3', 'mp3'],
      ['mp3-sync', 'mp3'],
      ['aac', 'aac'],
      ['m4a', 'm4a'],
      ['mp4-audio', 'm4a'],
      ['ogg', 'ogg'],
      ['opus', 'ogg'],
      ['flac', 'flac'],
      ['wav', 'wav'],
    ];
    // La extensión del usuario no cuenta: todos se llaman .dat.
    const paths = formats.map(([f]) => writeTone(dir, `pista-${f}.dat`, f, 1));
    const hashes = paths.map(sha);
    const result = await run(await service(h), paths);
    expect(result.failed).toEqual([]);
    expect(result.imported.map((t) => t.title)).toEqual(formats.map(([f]) => `pista-${f}`));
    const exts = result.imported.map((t) => musicFiles(h).find((n) => n.startsWith(t.id)));
    expect(exts).toEqual(result.imported.map((t, i) => `${t.id}.${formats[i]![1]}`));
    for (const t of result.imported) expect(t.durationMs).not.toBeNull();
    paths.forEach((p, i) => expect(sha(p)).toBe(hashes[i]));
  });

  it('un MP4 con vídeo (ftyp sin brand M4A) → UNSUPPORTED_FORMAT, sin copia', async () => {
    const h = await harness();
    const dir = sourceDir(h);
    const p = writeTone(dir, 'videoclip.mp4', 'mp4-video', 1);
    const before = sha(p);
    const result = await run(await service(h), [p]);
    expect(result).toEqual({
      imported: [],
      failed: [{ name: 'videoclip.mp4', code: 'UNSUPPORTED_FORMAT' }],
    });
    expect(musicFiles(h)).toEqual([]);
    expect(sha(p)).toBe(before);
  });

  it('sin ffmpeg: duración NULL, y un ftyp con otro brand → UNSUPPORTED_FORMAT', async () => {
    const h = await harness();
    const dir = sourceDir(h);
    const wav = writeTone(dir, 'a.wav', 'wav');
    const mp4 = writeTone(dir, 'b.m4a', 'mp4-audio');
    const result = await run(await service(h, { ffmpeg: null }), [wav, mp4]);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]?.durationMs).toBeNull();
    expect(result.failed).toEqual([{ name: 'b.m4a', code: 'UNSUPPORTED_FORMAT' }]);
  });

  it('un bloqueo a mitad de la copia: LOCKED, sin .part ni fila, y el original intacto', async () => {
    const h = await harness();
    const dir = sourceDir(h);
    const p = writeTone(dir, 'larga.wav', 'wav', 3);
    const before = sha(p);
    const svc = await service(h, {
      faults: (point) => {
        if (point === 'copy') void h.session.lock('suspend');
      },
    });
    const job = svc.reserve();
    const err = await svc.importFiles(job, [p]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppErrorException);
    expect((err as AppErrorException).error.code).toBe('LOCKED');
    expect(musicFiles(h)).toEqual([]);
    expect(sha(p)).toBe(before);
    expect(h.inFlight.size).toBe(0);
    await h.unlock();
    expect(h.db().prepare('SELECT COUNT(*) AS n FROM music_tracks').get()).toEqual({ n: 0 });
  });

  it('si falla el INSERT se borra la copia; los demás archivos siguen', async () => {
    const h = await harness();
    const dir = sourceDir(h);
    const a = writeTone(dir, 'a.wav', 'wav');
    const b = writeTone(dir, 'b.wav', 'wav');
    let n = 0;
    const svc = await service(h, {
      faults: (point) => {
        if (point === 'insert' && n++ === 0) throw Object.assign(new Error('x'), { code: 'EIO' });
      },
    });
    const result = await run(svc, [a, b]);
    expect(result.failed).toEqual([{ name: 'a.wav', code: 'IO' }]);
    expect(result.imported.map((t) => t.title)).toEqual(['b']);
    expect(musicFiles(h)).toEqual([`${result.imported[0]!.id}.wav`]);
  });
});

describe('music:import: validación y fallos (sin depender de ffmpeg)', () => {
  /** WAV mínimo válido por firma (cabecera RIFF/WAVE + silencio). */
  function writeWav(path: string, dataBytes = 400): string {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(36 + dataBytes, 4);
    header.write('WAVEfmt ', 8, 'latin1');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(16000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'latin1');
    header.writeUInt32LE(dataBytes, 40);
    writeFileSync(path, Buffer.concat([header, Buffer.alloc(dataBytes)]));
    return path;
  }

  it('firma inválida (aunque se llame .mp3) → UNSUPPORTED_FORMAT; el original no se toca', async () => {
    const h = await harness();
    const dir = sourceDir(h);
    const fake = join(dir, 'no-es-musica.mp3');
    writeFileSync(fake, 'esto es texto, no una pista de audio');
    const png = join(dir, 'foto.flac');
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
    const empty = join(dir, 'vacio.wav');
    writeFileSync(empty, '');
    const hashes = [fake, png, empty].map(sha);
    const result = await run(await service(h, { ffmpeg: null }), [fake, png, empty]);
    expect(result).toEqual({
      imported: [],
      failed: [
        { name: 'no-es-musica.mp3', code: 'UNSUPPORTED_FORMAT' },
        { name: 'foto.flac', code: 'UNSUPPORTED_FORMAT' },
        { name: 'vacio.wav', code: 'UNSUPPORTED_FORMAT' },
      ],
    });
    expect([fake, png, empty].map(sha)).toEqual(hashes);
    expect(musicFiles(h)).toEqual([]);
  });

  it('archivo ilegible → IO con un error claro, y el .part en curso se borra', async () => {
    const h = await harness();
    const dir = sourceDir(h);
    const missing = join(dir, 'ya-no-existe.wav');
    const folder = join(dir, 'carpeta.wav');
    mkdirSync(folder);
    const unreadable = writeWav(join(dir, 'falla-al-leer.wav'));
    const svc = await service(h, {
      ffmpeg: null,
      faults: (point) => {
        if (point === 'copy') throw Object.assign(new Error('x'), { code: 'EIO' });
      },
    });
    const result = await run(svc, [missing, folder, unreadable]);
    expect(result.imported).toEqual([]);
    expect(result.failed).toEqual([
      { name: 'ya-no-existe.wav', code: 'IO' },
      { name: 'carpeta.wav', code: 'UNSUPPORTED_FORMAT' },
      { name: 'falla-al-leer.wav', code: 'IO' },
    ]);
    expect(musicFiles(h)).toEqual([]);
    expect(existsSync(unreadable)).toBe(true);
  });

  it('por encima del límite de tamaño → TOO_LARGE (el límite exacto sí entra)', async () => {
    const h = await harness();
    const dir = sourceDir(h);
    const exact = writeWav(join(dir, 'justo.wav'), 956); // 1000 bytes
    const big = writeWav(join(dir, 'grande.wav'), 957); // 1001 bytes
    const result = await run(await service(h, { ffmpeg: null, maxBytes: 1000 }), [exact, big]);
    expect(result.imported.map((t) => t.title)).toEqual(['justo']);
    expect(result.failed).toEqual([{ name: 'grande.wav', code: 'TOO_LARGE' }]);
  });

  it('DISK_FULL detiene la importación: el resto cuenta como DISK_FULL', async () => {
    const h = await harness();
    const dir = sourceDir(h);
    const paths = ['a', 'b', 'c'].map((n) => writeWav(join(dir, `${n}.wav`)));
    const svc = await service(h, {
      ffmpeg: null,
      faults: (point) => {
        if (point === 'copy') throw Object.assign(new Error('x'), { code: 'ENOSPC' });
      },
    });
    const result = await run(svc, paths);
    expect(result.failed.map((f) => f.code)).toEqual(['DISK_FULL', 'DISK_FULL', 'DISK_FULL']);
    expect(musicFiles(h)).toEqual([]);
  });

  it('el título sale del nombre: NFC, sin controles, ≤ 200 code points; vacío → «Pista sin título»', () => {
    expect(trackTitle('Cancio\u0301n.mp3')).toBe('Canción');
    expect(trackTitle('  a\u0007b  .wav')).toBe('ab');
    expect(trackTitle('.wav')).toBe('.wav'); // archivo oculto: sin extensión
    expect(trackTitle('   .mp3')).toBe(UNTITLED_TRACK);
    expect([...trackTitle(`${'é'.repeat(250)}.flac`)]).toHaveLength(200);
  });

  it('parseMusicProbe: audio, vídeo (sin contar portadas) y duración', () => {
    expect(
      parseMusicProbe(
        JSON.stringify({
          streams: [
            { codec_type: 'audio' },
            { codec_type: 'video', disposition: { attached_pic: 1 } },
          ],
          format: { duration: '12.3456' },
        }),
      ),
    ).toEqual({ hasAudio: true, hasVideo: false, durationMs: 12346 });
    expect(parseMusicProbe(JSON.stringify({ streams: [{ codec_type: 'video' }] }))).toEqual({
      hasAudio: false,
      hasVideo: true,
      durationMs: null,
    });
    expect(parseMusicProbe('no es json')).toBeNull();
  });

  describe('handlers', () => {
    async function handlers(h: ImportHarness, paths: string[] | null) {
      const svc = await service(h, { ffmpeg: null });
      const dialogs: OpenDialogOptions[] = [];
      const hs = musicHandlers({
        service: svc,
        session: h.session,
        showOpenDialog: async (options) => {
          dialogs.push(options);
          return paths ? { canceled: false, filePaths: paths } : { canceled: true, filePaths: [] };
        },
      });
      return { svc, hs, dialogs };
    }

    it('el diálogo es de archivos, multiselección y sin "Recientes"; cancelar → null', async () => {
      const h = await harness();
      const { hs, dialogs, svc } = await handlers(h, null);
      expect(await hs.import()).toBeNull();
      expect(dialogs).toEqual([CHOOSE_MUSIC_OPTIONS]);
      expect(dialogs[0]?.properties).toEqual(['openFile', 'multiSelections', 'dontAddToRecent']);
      // El trabajo se liberó: se puede reservar otra vez.
      svc.release(svc.reserve());
    });

    it('201 archivos → VALIDATION antes de empezar (y libera el trabajo)', async () => {
      const h = await harness();
      const dir = sourceDir(h);
      const one = writeWav(join(dir, 'x.wav'));
      const paths = Array.from({ length: 201 }, (_, i) => {
        const p = join(dir, `p${i}.wav`);
        copyFileSync(one, p);
        return p;
      });
      const { hs, svc } = await handlers(h, paths);
      const err = await hs.import().catch((e: unknown) => e);
      expect((err as AppErrorException).error.code).toBe('VALIDATION');
      expect(musicFiles(h)).toEqual([]);
      svc.release(svc.reserve());
      // 200 sí.
      const ok = await (await handlers(h, paths.slice(0, 200))).hs.import();
      expect(ok?.imported).toHaveLength(200);
    });

    it('BUSY sin abrir el diálogo si ya hay una importación de música', async () => {
      const h = await harness();
      const { hs, svc, dialogs } = await handlers(h, []);
      const job = svc.reserve();
      const err = await hs.import().catch((e: unknown) => e);
      expect((err as AppErrorException).error.code).toBe('BUSY');
      expect(dialogs).toEqual([]);
      svc.release(job);
    });

    it('music:rename y music:delete (fila, playlist_music, kv y archivo)', async () => {
      const h = await harness();
      const dir = sourceDir(h);
      const { hs } = await handlers(h, [
        writeWav(join(dir, 'uno.wav')),
        writeWav(join(dir, 'dos.wav')),
      ]);
      const res = await hs.import();
      const [a, b] = res!.imported;
      expect(hs.rename({ id: a!.id, title: 'Nuevo título' }).title).toBe('Nuevo título');
      expect(hs.list().map((t) => t.title)).toEqual(['dos', 'Nuevo título']);

      const db = h.db();
      kvSet(db, KV_DEFAULT_TRACKS, [a!.id, b!.id]);
      const pl = createPlaylist(db, 'Vacaciones');
      setPlaylistPresentation(db, pl.id, {
        plain: { ...DEFAULT_PRESENTATION },
        trackIds: [b!.id, a!.id],
      });

      await hs.delete({ id: a!.id });
      expect(hs.list().map((t) => t.id)).toEqual([b!.id]);
      expect(kvGet(db, KV_DEFAULT_TRACKS)).toEqual([b!.id]);
      expect(playlistPresentation(db, pl.id)?.trackIds).toEqual([b!.id]);
      expect(musicFiles(h)).toEqual([`${b!.id}.wav`]);
      const again = await Promise.resolve()
        .then(() => hs.delete({ id: a!.id }))
        .catch((e: unknown) => e);
      expect((again as AppErrorException).error.code).toBe('NOT_FOUND');
      expect(() => hs.rename({ id: a!.id, title: 'x' })).toThrow(AppErrorException);
    });
  });
});
