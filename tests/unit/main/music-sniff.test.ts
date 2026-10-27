// Firmas de música (docs/DESIGN.md §8.6.1; PLAN.md 4.2): MP3 (ID3 y sync de Layer III), AAC ADTS,
// M4A, `ftyp` con otro brand (ffprobe decide), Ogg, FLAC y WAV; cualquier otra → desconocida. La
// extensión no cuenta. Con bytes construidos a mano y con tonos generados por el ffmpeg empaquetado.
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { MUSIC_FILE_NAME, MUSIC_PART_NAME, sniffMusic } from '../../../src/main/music/music-sniff';
import { writeTone, type ToneFormat } from '../helpers/audio';
import { haveFfmpeg } from '../helpers/import';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const tmp = makeTmpDir('music-sniff');
afterAll(() => removeTmpDir(tmp));

const bytes = (...parts: (string | number[])[]): Uint8Array =>
  Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))),
  );

function ftyp(major: string, compatible: string[]): Uint8Array {
  const size = 16 + 4 * compatible.length;
  const head = Buffer.alloc(4);
  head.writeUInt32BE(size);
  return bytes([...head], 'ftyp', major, [0, 0, 2, 0], ...compatible);
}

describe('sniffMusic: tabla de §8.6.1', () => {
  it('MP3 con ID3 y MP3 por el sync de Layer III', () => {
    expect(sniffMusic(bytes('ID3', [4, 0, 0, 0, 0, 0, 0]))).toMatchObject({
      kind: 'audio',
      ext: 'mp3',
      mime: 'audio/mpeg',
      demuxer: 'mp3',
      needsProbe: false,
    });
    // FF FB: MPEG-1 Layer III; FF F3: MPEG-2 Layer III; FF E3: MPEG-2.5 Layer III.
    for (const b1 of [0xfb, 0xfa, 0xf3, 0xe3]) {
      expect(sniffMusic(bytes([0xff, b1, 0x90, 0x00]))).toMatchObject({ ext: 'mp3' });
    }
  });

  it('AAC ADTS (sync de 12 bits y capa 00) y no confunde con MP3', () => {
    for (const b1 of [0xf1, 0xf9, 0xf0, 0xf8]) {
      expect(sniffMusic(bytes([0xff, b1, 0x50, 0x80]))).toMatchObject({
        ext: 'aac',
        mime: 'audio/aac',
        demuxer: 'aac',
      });
    }
    // FF + capa I/II (no es Layer III ni ADTS) → desconocida.
    expect(sniffMusic(bytes([0xff, 0xff, 0x90, 0x00])).kind).toBe('unknown'); // capa I
    expect(sniffMusic(bytes([0xff, 0xfd, 0x90, 0x00])).kind).toBe('unknown'); // capa II
    expect(sniffMusic(bytes([0xff, 0xd8, 0xff, 0xe0])).kind).toBe('unknown'); // JPEG
  });

  it('M4A por brand mayor o compatible; otro brand pide ffprobe', () => {
    expect(sniffMusic(ftyp('M4A ', ['M4A ', 'mp42', 'isom']))).toMatchObject({
      ext: 'm4a',
      mime: 'audio/mp4',
      demuxer: 'mov',
      needsProbe: false,
    });
    expect(sniffMusic(ftyp('mp42', ['isom', 'M4B ']))).toMatchObject({ needsProbe: false });
    expect(sniffMusic(ftyp('isom', ['iso2', 'mp41']))).toMatchObject({
      ext: 'm4a',
      needsProbe: true,
    });
  });

  it('Ogg, FLAC y WAV', () => {
    expect(sniffMusic(bytes('OggS', [0, 2]))).toMatchObject({ ext: 'ogg', mime: 'audio/ogg' });
    expect(sniffMusic(bytes('fLaC', [0, 0, 0, 34]))).toMatchObject({
      ext: 'flac',
      mime: 'audio/flac',
    });
    expect(sniffMusic(bytes('RIFF', [0x24, 0, 0, 0], 'WAVEfmt '))).toMatchObject({
      ext: 'wav',
      mime: 'audio/wav',
    });
    // RIFF que no es WAVE (AVI, WebP) → desconocida.
    expect(sniffMusic(bytes('RIFF', [0, 0, 0, 0], 'AVI LIST')).kind).toBe('unknown');
    expect(sniffMusic(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')).kind).toBe('unknown');
  });

  it('cualquier otra firma, vacío o corto → desconocida', () => {
    for (const b of [
      bytes([]),
      bytes('I'),
      bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]),
      bytes('%PDF-1.7'),
      bytes('BM', [0, 0, 0, 0]),
      bytes([0x1a, 0x45, 0xdf, 0xa3]),
      bytes('hola, esto es texto'),
    ]) {
      expect(sniffMusic(b).kind).toBe('unknown');
    }
  });

  it('solo mira los 64 primeros bytes', () => {
    const late = Buffer.concat([Buffer.alloc(64), Buffer.from('ID3')]);
    expect(sniffMusic(late).kind).toBe('unknown');
  });

  it('nombres de music/: <32 hex>.<ext> y su .part; nada más', () => {
    const id = 'a'.repeat(32);
    expect(MUSIC_FILE_NAME.test(`${id}.mp3`)).toBe(true);
    expect(MUSIC_PART_NAME.test(`${id}.flac.part`)).toBe(true);
    for (const bad of [`${id}.exe`, `canción.mp3`, `${id}.mp3.part.x`, `${id.slice(1)}.mp3`]) {
      expect(MUSIC_FILE_NAME.test(bad) || MUSIC_PART_NAME.test(bad)).toBe(false);
    }
  });
});

describe.runIf(haveFfmpeg)('sniffMusic con tonos generados por el ffmpeg empaquetado', () => {
  const cases: [ToneFormat, string, boolean][] = [
    ['mp3', 'mp3', false],
    ['mp3-sync', 'mp3', false],
    ['aac', 'aac', false],
    ['m4a', 'm4a', false],
    ['mp4-audio', 'm4a', true],
    ['ogg', 'ogg', false],
    ['opus', 'ogg', false],
    ['flac', 'flac', false],
    ['wav', 'wav', false],
  ];
  it.each(cases)('%s → %s (needsProbe %s)', (format, ext, needsProbe) => {
    // La extensión del archivo no cuenta: todos se llaman .bin.
    const path = writeTone(tmp, `${format}.bin`, format);
    expect(sniffMusic(readFileSync(path).subarray(0, 64))).toMatchObject({
      kind: 'audio',
      ext,
      needsProbe,
    });
  });
});
