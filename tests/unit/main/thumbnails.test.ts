// media/thumbnails.ts (docs/DESIGN.md §12.4, paso 4): miniaturas de foto (incluido AVIF, R14) y de
// vídeo desde el .part cifrado por el loopback, sin escribir nada en claro.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KIND_MEDIA } from '../../../src/main/crypto/file-format';
import { openObject } from '../../../src/main/crypto/object-reader';
import { createObjectWriter } from '../../../src/main/crypto/object-writer';
import { sniffBuffer } from '../../../src/main/import/sniff';
import { Ffmpeg, FfmpegError, resolveFfmpegPaths } from '../../../src/main/media/ffmpeg';
import { LoopbackServer } from '../../../src/main/media/loopback-server';
import { getSharp } from '../../../src/main/media/sharp-loader';
import {
  demuxerForMime,
  frameTimeSeconds,
  photoThumbnail,
  videoThumbnail,
} from '../../../src/main/media/thumbnails';
import { appErrorOf, randomKey } from '../helpers/crypto';
import { ensureFixtures, fixturePath, type FixtureManifest } from '../helpers/fixtures';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

async function dims(webp: Buffer): Promise<{ w: number; h: number; format: string }> {
  const sharp = await getSharp();
  const m = await sharp(webp).metadata();
  return { w: m.width ?? 0, h: m.height ?? 0, format: m.format ?? '' };
}

describe('miniaturas de foto', () => {
  it('JPEG con orientación 6: autoOrient y 512 inside → vertical', async () => {
    const sharp = await getSharp();
    const jpeg = await sharp({
      create: { width: 1600, height: 1200, channels: 3, background: '#808080' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const thumb = await photoThumbnail(jpeg);
    expect(sniffBuffer(thumb)).toMatchObject({ kind: 'photo', format: 'webp' });
    expect(await dims(thumb)).toEqual({ w: 384, h: 512, format: 'webp' });
  });

  it.each(['png', 'webp', 'gif', 'avif'] as const)('%s (sin ampliar las pequeñas)', async (fmt) => {
    const sharp = await getSharp();
    const base = sharp({ create: { width: 300, height: 200, channels: 4, background: '#123456' } });
    const input = await base[fmt]().toBuffer();
    const thumb = await photoThumbnail(input);
    expect(await dims(thumb)).toEqual({ w: 300, h: 200, format: 'webp' });
  });

  it('GIF animado de 4 fotogramas: un solo fotograma (el primero)', async () => {
    const sharp = await getSharp();
    const frames = await Promise.all(
      ['#ff0000', '#00ff00', '#0000ff', '#ffffff'].map((background) =>
        sharp({ create: { width: 80, height: 60, channels: 3, background } })
          .png()
          .toBuffer(),
      ),
    );
    const animated = await sharp(frames, { join: { animated: true } })
      .gif()
      .toBuffer();
    expect((await sharp(animated).metadata()).pages).toBe(4);
    const thumb = await photoThumbnail(animated);
    expect(await dims(thumb)).toEqual({ w: 80, h: 60, format: 'webp' });
    const sharpMod = await getSharp();
    const { data } = await sharpMod(thumb).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(200); // rojo
    expect(data[1]).toBeLessThan(60);
  });

  it('basura → UNSUPPORTED_FORMAT', async () => {
    expect((await appErrorOf(() => photoThumbnail(Buffer.from('no')))).code).toBe(
      'UNSUPPORTED_FORMAT',
    );
  });
});

describe('vídeo: reglas', () => {
  it('t = min(1 s, 10 %) y demuxer por MIME', () => {
    expect(frameTimeSeconds(4000)).toBeCloseTo(0.4);
    expect(frameTimeSeconds(60_000)).toBe(1);
    expect(frameTimeSeconds(null)).toBe(0);
    expect(demuxerForMime('video/mp4')).toBe('mov');
    expect(demuxerForMime('video/webm')).toBe('matroska');
    expect(() => demuxerForMime('video/x-matroska')).toThrow(RangeError);
  });

  it('si el fotograma en t falla, se reintenta en t = 0', async () => {
    const sharp = await getSharp();
    const png = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#000' } })
      .png()
      .toBuffer();
    const seen: string[] = [];
    const ffmpeg = {
      run: async (cmd: { args: readonly string[] }) => {
        const t = cmd.args[cmd.args.indexOf('-ss') + 1] as string;
        seen.push(t);
        if (t !== '0.000') return Buffer.alloc(0); // ffmpeg sin fotograma (exit 0)
        return Buffer.from(png);
      },
    };
    const url = `http://127.0.0.1:1234/${'a'.repeat(43)}/part`;
    const thumb = await videoThumbnail({
      ffmpeg: ffmpeg as never,
      url,
      mime: 'video/mp4',
      durationMs: 30_000,
    });
    expect(seen).toEqual(['1.000', '0.000']);
    expect((await dims(thumb)).format).toBe('webp');
    const failing = {
      run: async () => {
        throw new FfmpegError('FFMPEG_FAILED', 'exit');
      },
    };
    expect(
      (
        await appErrorOf(() =>
          videoThumbnail({ ffmpeg: failing as never, url, mime: 'video/mp4', durationMs: 10_000 }),
        )
      ).code,
    ).toBe('FFMPEG_FAILED');
  });
});

const ROOT = join(__dirname, '..', '..', '..');
const realPaths = resolveFfmpegPaths({ isPackaged: false, resourcesPath: '', appPath: ROOT });
const haveBinaries = existsSync(realPaths.ffmpeg) && existsSync(realPaths.ffprobe);

describe.skipIf(!haveBinaries)('vídeo: desde el .part cifrado por el loopback', () => {
  let manifest: FixtureManifest;
  let ff: Ffmpeg;
  const dir = haveBinaries ? makeTmpDir('thumbnails') : '';
  const kWrap = randomKey();

  beforeAll(async () => {
    manifest = ensureFixtures();
    ff = new Ffmpeg(realPaths);
    await ff.checkAvailable();
  }, 600_000);
  afterAll(() => {
    if (dir) removeTmpDir(dir);
  });

  it.each([
    ['mp4Vp9Opus', 'video/mp4'],
    ['webmVp9Opus', 'video/webm'],
  ])(
    '%s',
    async (key, mime) => {
      const plaintext = readFileSync(fixturePath(manifest, key) as string);
      const fileId = randomBytes(16);
      const part = join(dir, `${fileId.toString('hex')}.part`);
      const writer = createObjectWriter({ kind: KIND_MEDIA, fileId, kWrap, tmpPath: part });
      await writer.write(plaintext);
      await writer.finish();
      const before = readdirSync(dir).sort();
      const lb = await LoopbackServer.start({
        open: (t) => openObject(t.path, { fileId: t.fileId, kind: t.kind }, kWrap),
      });
      try {
        const url = lb.register('part', { path: part, fileId, kind: KIND_MEDIA, mime });
        const thumb = await videoThumbnail({ ffmpeg: ff, url, mime, durationMs: 4000 });
        const d = await dims(thumb);
        expect(d.format).toBe('webp');
        expect(Math.max(d.w, d.h)).toBeLessThanOrEqual(512);
      } finally {
        await lb.close();
      }
      // Nada nuevo junto al .part: ni fotogramas ni temporales en claro.
      expect(readdirSync(dir).sort()).toEqual(before);
      // El .part sigue cifrado: no contiene los primeros bytes del vídeo en claro.
      expect(readFileSync(part).includes(plaintext.subarray(0, 64))).toBe(false);
    },
    60_000,
  );
});
