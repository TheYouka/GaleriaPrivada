// video-pipeline.ts (docs/DESIGN.md §12.5, §12.5.1, §12.4 pasos 0, 2 y 3; PLAN.md 2.7 [H3-11]).
// Sin comprobación de pix_fmt: v3-1 está descartado por el usuario.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KIND_MEDIA } from '../../../src/main/crypto/file-format';
import { openObject } from '../../../src/main/crypto/object-reader';
import { createObjectWriter } from '../../../src/main/crypto/object-writer';
import {
  confirmationSummary,
  decideVideoAction,
  durationMatches,
  parseProbe,
  prescanVideo,
  probeVideo,
  summarizeProbe,
  transcodeToSink,
  verifyProcessedVideo,
  type VideoDecision,
  type VideoProbe,
} from '../../../src/main/import/video-pipeline';
import { dispositionOf, sniffBuffer, sniffFile } from '../../../src/main/import/sniff';
import { Ffmpeg, resolveFfmpegPaths } from '../../../src/main/media/ffmpeg';
import { LoopbackServer } from '../../../src/main/media/loopback-server';
import type { VideoContainer } from '../../../src/shared/constants';
import { appErrorOf, randomKey } from '../helpers/crypto';
import { ensureFixtures, fixturePath, type FixtureManifest } from '../helpers/fixtures';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const DECODERS: ReadonlySet<string> = new Set([
  'h264',
  'hevc',
  'vp8',
  'vp9',
  'av1',
  'mpeg4',
  'mpeg2video',
  'wmv3',
]);

function probe(video: Record<string, unknown> | null, audio: string | null = null): VideoProbe {
  const streams: Record<string, unknown>[] = [];
  if (video) streams.push({ index: 0, codec_type: 'video', width: 1920, height: 1080, ...video });
  if (audio) streams.push({ index: 1, codec_type: 'audio', codec_name: audio });
  return parseProbe(JSON.stringify({ streams, format: { duration: '4.000000' } }));
}

function decide(container: VideoContainer, v: string | null, a: string | null): VideoDecision {
  return decideVideoAction(
    container,
    summarizeProbe(probe(v === null ? {} : { codec_name: v }, a)),
    DECODERS,
  );
}

const store = (mime: 'video/mp4' | 'video/webm'): VideoDecision => ({ kind: 'store', mime });
const remux = (genpts = false): VideoDecision => ({
  kind: 'process',
  mime: 'video/mp4',
  video: 'copy',
  audio: 'copy',
  genpts,
  reencode: false,
});

describe('tabla de acciones de §12.5 (por codec_name)', () => {
  it('MP4 con h264/vp9/av1 y aac/mp3/opus/flac o sin audio → tal cual', () => {
    for (const v of ['h264', 'vp9', 'av1']) {
      for (const a of ['aac', 'mp3', 'opus', 'flac', null]) {
        expect(decide('mp4', v, a)).toEqual(store('video/mp4'));
      }
    }
  });

  it('WebM con vp8/vp9/av1 y vorbis/opus o sin audio → tal cual', () => {
    for (const v of ['vp8', 'vp9', 'av1']) {
      for (const a of ['vorbis', 'opus', null]) {
        expect(decide('webm', v, a)).toEqual(store('video/webm'));
      }
    }
  });

  it('MOV/MKV/AVI con vídeo copiable y audio de MP4 → remultiplexar -c copy (AVI con +genpts)', () => {
    expect(decide('mov', 'h264', 'aac')).toEqual(remux());
    expect(decide('mkv', 'vp9', 'opus')).toEqual(remux());
    expect(decide('mkv', 'vp9', 'flac')).toEqual(remux());
    expect(decide('mkv', 'av1', null)).toEqual(remux());
    expect(decide('avi', 'h264', 'mp3')).toEqual(remux(true));
    // Un WebM fuera de su fila se trata como MKV (nota 98).
    expect(decide('webm', 'vp9', 'aac')).toEqual(remux());
  });

  it('vídeo copiable con otro audio (pcm, ac3, dts, vorbis en MP4…) → copiar vídeo y audio a Opus (D8)', () => {
    for (const [c, a] of [
      ['mkv', 'ac3'],
      ['mov', 'pcm_s16le'],
      ['mp4', 'vorbis'],
      ['avi', 'dts'],
      ['webm', 'pcm_s16le'],
    ] as const) {
      expect(decide(c, 'h264', a)).toEqual({
        kind: 'process',
        mime: 'video/mp4',
        video: 'copy',
        audio: 'opus',
        genpts: c === 'avi',
        reencode: true,
      });
    }
  });

  it('otro vídeo (hevc, mpeg4, mpeg2, wmv, vp8 fuera de WebM) → VP9 (+ audio según la fila anterior)', () => {
    expect(decide('mp4', 'hevc', 'aac')).toMatchObject({
      video: 'vp9',
      audio: 'copy',
      reencode: true,
    });
    expect(decide('mov', 'mpeg4', 'aac')).toMatchObject({ video: 'vp9', audio: 'copy' });
    expect(decide('avi', 'mpeg4', 'mp3')).toMatchObject({ video: 'vp9', genpts: true });
    expect(decide('mkv', 'mpeg2video', 'ac3')).toMatchObject({ video: 'vp9', audio: 'opus' });
    expect(decide('mp4', 'vp8', null)).toMatchObject({ video: 'vp9', reencode: true });
    expect(decide('avi', 'wmv3', 'wmav2')).toMatchObject({ video: 'vp9', audio: 'opus' });
  });

  it('sin pista de vídeo → no-video ("cualquier otra")', () => {
    expect(decideVideoAction('mp4', summarizeProbe(probe(null, 'aac')), DECODERS)).toEqual({
      kind: 'no-video',
    });
  });

  it('las portadas (attached_pic = 1) no cuentan como pista de vídeo (nota 104)', () => {
    const cover = {
      codec_type: 'video',
      codec_name: 'png',
      width: 600,
      height: 600,
      disposition: { default: 0, attached_pic: 1 },
    };
    // .m4a con carátula: audio + png attached_pic → no-video, nunca D8.
    const m4a = parseProbe(
      JSON.stringify({
        streams: [{ codec_type: 'audio', codec_name: 'aac' }, cover],
        format: { duration: '4.0' },
      }),
    );
    const sm = summarizeProbe(m4a);
    expect(sm).toMatchObject({ hasVideo: false, videoCodec: null, width: null, hasAudio: true });
    const noVideo = decideVideoAction('mp4', sm, new Set([...DECODERS, 'png']));
    expect(noVideo).toEqual({ kind: 'no-video' });
    expect(confirmationSummary([{ decision: noVideo, sizeBytes: 5000 }])).toEqual({
      toConvert: 0,
      toConvertBytes: 0,
    });
    const sniffed = sniffBuffer(Buffer.from('0000001c667479704d34412000000000', 'hex'));
    expect(dispositionOf(sniffed, { explicit: false, probe: m4a })).toEqual({ action: 'skip' });
    expect(dispositionOf(sniffed, { explicit: true, probe: m4a })).toEqual({
      action: 'fail',
      code: 'UNSUPPORTED_FORMAT',
    });
    // MP4 h264 + portada (aunque vaya primero) → tal cual, con las dimensiones del h264.
    const withCover = parseProbe(
      JSON.stringify({
        streams: [
          cover,
          { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
      }),
    );
    const sv = summarizeProbe(withCover);
    expect(sv).toMatchObject({ hasVideo: true, videoCodec: 'h264', width: 1920, height: 1080 });
    expect(decideVideoAction('mp4', sv, DECODERS)).toEqual(store('video/mp4'));
  });
});

describe('[H3-11] pista sin codec_name o sin decodificador', () => {
  it('→ UNSUPPORTED_FORMAT (unsupported) y fuera de toConvert', () => {
    const noCodec = decide('mkv', null, 'aac');
    const noDecoder = decide('mov', 'prores', 'pcm_s16le');
    expect(noCodec).toEqual({ kind: 'unsupported', reason: 'no-codec' });
    expect(noDecoder).toEqual({ kind: 'unsupported', reason: 'no-decoder' });
    expect(decide('mp4', '', 'aac')).toEqual({ kind: 'unsupported', reason: 'no-codec' });
    const convert = decide('mov', 'mpeg4', 'aac');
    expect(
      confirmationSummary([
        { decision: noCodec, sizeBytes: 1000 },
        { decision: noDecoder, sizeBytes: 2000 },
        { decision: convert, sizeBytes: 300 },
        { decision: remux(), sizeBytes: 50 },
        { decision: store('video/mp4'), sizeBytes: 7 },
      ]),
    ).toEqual({ toConvert: 1, toConvertBytes: 300 });
  });
});

describe('resumen de ffprobe', () => {
  it('rotación ±90° intercambia ancho y alto (Display Matrix y, si no, tags.rotate)', () => {
    const dims = (video: Record<string, unknown>): [number | null, number | null, number] => {
      const s = summarizeProbe(probe({ codec_name: 'h264', ...video }));
      return [s.width, s.height, s.rotation];
    };
    expect(dims({})).toEqual([1920, 1080, 0]);
    expect(dims({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] })).toEqual(
      [1080, 1920, 270],
    );
    expect(dims({ side_data_list: [{ rotation: 90 }] })).toEqual([1080, 1920, 90]);
    expect(dims({ tags: { rotate: '90' } })).toEqual([1080, 1920, 90]);
    expect(dims({ tags: { rotate: '-270' } })).toEqual([1080, 1920, 90]);
    expect(dims({ side_data_list: [{ rotation: 180 }], tags: { rotate: '90' } })).toEqual([
      1920, 1080, 180,
    ]);
  });

  it('duración, fps, audio y creation_time', () => {
    const p = parseProbe(
      JSON.stringify({
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            avg_frame_rate: '30000/1001',
            duration: '3.5',
          },
          { codec_type: 'audio', codec_name: 'aac' },
        ],
        format: { duration: '4.25', tags: { creation_time: '2026-10-25T00:30:00.000000Z' } },
      }),
    );
    expect(summarizeProbe(p)).toMatchObject({
      hasVideo: true,
      videoCodec: 'h264',
      hasAudio: true,
      audioCodec: 'aac',
      durationMs: 4250,
      creationTime: '2026-10-25T00:30:00.000000Z',
    });
    expect(summarizeProbe(p).fps).toBeCloseTo(29.97, 2);
    expect(
      summarizeProbe(parseProbe('{"streams":[{"codec_type":"video","avg_frame_rate":"0/0"}]}')),
    ).toMatchObject({ fps: null, durationMs: null, videoCodec: null });
  });

  it('salida inválida → FFMPEG_FAILED probe-output', async () => {
    for (const bad of ['no es json', '{}', '{"streams":{}}', '{"streams":[{"width":-1}]}']) {
      expect(await appErrorOf(() => parseProbe(bad))).toEqual({
        code: 'FFMPEG_FAILED',
        reason: 'probe-output',
      });
    }
  });

  it('±max(1 s, 2 %)', () => {
    expect(durationMatches(4000, 4999)).toBe(true);
    expect(durationMatches(4000, 5001)).toBe(false);
    expect(durationMatches(100_000, 102_000)).toBe(true);
    expect(durationMatches(100_000, 102_001)).toBe(false);
  });
});

describe('prescanVideo sin binarios', () => {
  const original = { path: 'C:\\x.mp4', container: 'mp4' as const, demuxer: 'mov' as const };
  it('FFMPEG_MISSING sin ffmpeg; FFMPEG_FAILED si -decoders falló', async () => {
    const missing = {
      available: false,
      loadDecoders: async () => null,
      run: async () => Buffer.alloc(0),
      start: () => {
        throw new Error('no');
      },
    };
    expect((await appErrorOf(() => prescanVideo(missing, original))).code).toBe('FFMPEG_MISSING');
    expect(
      (await appErrorOf(() => prescanVideo({ ...missing, available: true }, original))).code,
    ).toBe('FFMPEG_FAILED');
  });
});

// ── Con los binarios reales y los fixtures (2.1, 2.8) ───────────────────────────────────────────

const ROOT = join(__dirname, '..', '..', '..');
const realPaths = resolveFfmpegPaths({ isPackaged: false, resourcesPath: '', appPath: ROOT });
const haveBinaries = existsSync(realPaths.ffmpeg) && existsSync(realPaths.ffprobe);

describe.skipIf(!haveBinaries)('con ffmpeg y los fixtures', () => {
  let manifest: FixtureManifest;
  let ff: Ffmpeg;
  const dir = haveBinaries ? makeTmpDir('video-pipeline') : '';
  const kWrap = randomKey();

  beforeAll(async () => {
    manifest = ensureFixtures();
    ff = new Ffmpeg(realPaths);
    await ff.checkAvailable();
  }, 600_000);
  afterAll(() => {
    if (dir) removeTmpDir(dir);
  });

  const prescan = (key: string, container: VideoContainer) => {
    const path = fixturePath(manifest, key) as string;
    const demuxer =
      container === 'avi' ? 'avi' : container === 'mov' || container === 'mp4' ? 'mov' : 'matroska';
    return prescanVideo(ff, { path, container, demuxer });
  };

  it('preescaneo de los fixtures: la acción esperada por el generador', async () => {
    const cases: [string, VideoContainer, VideoDecision['kind'], boolean][] = [
      ['mp4Vp9Opus', 'mp4', 'store', false],
      ['webmVp9Opus', 'webm', 'store', false],
      ['mkvVp9Opus', 'mkv', 'process', false],
      ['mkvVp9Flac', 'mkv', 'process', false],
      ['movMpeg4', 'mov', 'process', true],
      ['aviMpeg4', 'avi', 'process', true],
    ];
    for (const [key, container, kind, reencode] of cases) {
      const { decision, summary } = await prescan(key, container);
      expect(decision.kind, key).toBe(kind);
      if (decision.kind === 'process') expect(decision.reencode, key).toBe(reencode);
      expect(summary.durationMs, key).toBeGreaterThan(3500);
    }
  }, 60_000);

  /** Cifra la salida de ffmpeg en un .part y la verifica por el loopback. */
  async function processToPart(key: string, container: VideoContainer) {
    const { decision, summary } = await prescan(key, container);
    if (decision.kind !== 'process') throw new Error('se esperaba procesar');
    const fileId = randomBytes(16);
    const tmpPath = join(dir, `${fileId.toString('hex')}.part`);
    const writer = createObjectWriter({ kind: KIND_MEDIA, fileId, kWrap, tmpPath });
    const progress: number[] = [];
    const input = {
      kind: 'file' as const,
      path: fixturePath(manifest, key) as string,
      demuxer:
        container === 'avi'
          ? ('avi' as const)
          : container === 'mkv'
            ? ('matroska' as const)
            : ('mov' as const),
    };
    await transcodeToSink({
      ffmpeg: ff,
      input,
      decision,
      sink: writer,
      durationMs: summary.durationMs,
      onProgress: (f) => progress.push(f),
    });
    const result = await writer.finish();
    const lb = await LoopbackServer.start({
      open: (t) => openObject(t.path, { fileId: t.fileId, kind: t.kind }, kWrap),
    });
    try {
      const url = lb.register('part', {
        path: tmpPath,
        fileId,
        kind: KIND_MEDIA,
        mime: 'video/mp4',
      });
      const verified = await verifyProcessedVideo({
        ffmpeg: ff,
        url,
        expectedDurationMs: summary.durationMs,
      });
      return { url, lb, verified, summary, result, progress, tmpPath, fileId };
    } catch (err) {
      await lb.close();
      throw err;
    }
  }

  it('MKV VP9 + Opus y MKV VP9 + FLAC se remultiplexan (sin -strict) y pasan el paso 3', async () => {
    for (const key of ['mkvVp9Opus', 'mkvVp9Flac']) {
      const r = await processToPart(key, 'mkv');
      try {
        expect(r.verified.videoCodec).toBe('vp9');
        expect(r.verified.hasAudio).toBe(true);
        expect(r.result.plaintextSize).toBeGreaterThan(0);
        expect(r.progress.at(-1)).toBe(1);
      } finally {
        await r.lb.close();
      }
    }
    // Nada en claro junto a los .part.
    expect(readdirSync(dir).every((n) => n.endsWith('.part'))).toBe(true);
  }, 120_000);

  it('MOV mpeg4 se convierte a VP9 en MP4 fragmentado y verifica la duración', async () => {
    const r = await processToPart('movMpeg4', 'mov');
    try {
      expect(r.verified.videoCodec).toBe('vp9');
      expect(durationMatches(r.summary.durationMs as number, r.verified.durationMs as number)).toBe(
        true,
      );
      // Una duración esperada muy distinta (remultiplexado truncado) → INTEGRITY.
      expect(
        await appErrorOf(() =>
          verifyProcessedVideo({ ffmpeg: ff, url: r.url, expectedDurationMs: 60_000 }),
        ),
      ).toEqual({ code: 'INTEGRITY', reason: 'duration' });
    } finally {
      await r.lb.close();
    }
  }, 180_000);

  it('si el writer falla, ffmpeg se mata y el error del writer se propaga', async () => {
    const { decision, summary } = await prescan('mkvVp9Opus', 'mkv');
    if (decision.kind !== 'process') throw new Error('se esperaba procesar');
    const boom = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    let calls = 0;
    const err = await transcodeToSink({
      ffmpeg: ff,
      input: {
        kind: 'file',
        path: fixturePath(manifest, 'mkvVp9Opus') as string,
        demuxer: 'matroska',
      },
      decision,
      sink: {
        write: async () => {
          calls += 1;
          throw boom;
        },
      },
      durationMs: summary.durationMs,
    }).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(calls).toBe(1);
  }, 60_000);

  it('cancelar con la señal → CANCELLED', async () => {
    const { decision, summary } = await prescan('movMpeg4', 'mov');
    if (decision.kind !== 'process') throw new Error('se esperaba procesar');
    const ac = new AbortController();
    const err = await transcodeToSink({
      ffmpeg: ff,
      input: { kind: 'file', path: fixturePath(manifest, 'movMpeg4') as string, demuxer: 'mov' },
      decision,
      sink: {
        write: async () => {
          ac.abort();
        },
      },
      durationMs: summary.durationMs,
      signal: ac.signal,
    }).catch((e: unknown) => e);
    expect((err as { error?: { code?: string } }).error?.code).toBe('CANCELLED');
  }, 60_000);

  it('portadas reales (nota 104): .m4a con carátula se omite; MP4/MKV con carátula usan su vídeo', async () => {
    const covers = makeTmpDir('video-pipeline-covers');
    const gen = (args: string[]): void => {
      execFileSync(realPaths.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...args], {
        stdio: 'ignore',
      });
    };
    try {
      const png = join(covers, 'portada.png');
      const m4a = join(covers, 'cancion.m4a');
      const mp4 = join(covers, 'con-portada.mp4');
      const mkv = join(covers, 'con-portada.mkv');
      gen(['-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1', '-frames:v', '1', png]);
      gen([
        ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-i', png],
        ...['-map', '0:a', '-map', '1:v', '-c:a', 'aac', '-c:v', 'copy'],
        ...['-disposition:v:0', 'attached_pic', '-f', 'ipod', m4a],
      ]);
      const vp9mp4 = fixturePath(manifest, 'mp4Vp9Opus') as string;
      gen([
        ...['-i', vp9mp4, '-i', png, '-map', '0:v', '-map', '0:a', '-map', '1:v', '-c', 'copy'],
        ...['-disposition:v:1', 'attached_pic', '-f', 'mp4', mp4],
      ]);
      const vp9mkv = fixturePath(manifest, 'mkvVp9Opus') as string;
      gen([
        ...['-i', vp9mkv, '-attach', png, '-map', '0', '-c', 'copy'],
        ...['-metadata:s:t', 'mimetype=image/png', '-metadata:s:t', 'filename=portada.png'],
        ...['-f', 'matroska', mkv],
      ]);

      // .m4a (ftyp M4A → vídeo por firma) con portada: no-video → skipped / UNSUPPORTED_FORMAT.
      const sm = await sniffFile(m4a);
      expect(sm).toMatchObject({ kind: 'video', container: 'mp4' });
      const a = await prescanVideo(ff, { path: m4a, container: 'mp4', demuxer: 'mov' });
      expect(a.probe.streams.some((s) => s.disposition?.attached_pic === 1)).toBe(true);
      expect(a.decision).toEqual({ kind: 'no-video' });
      expect(dispositionOf(sm, { explicit: false, probe: a.probe })).toEqual({ action: 'skip' });
      expect(dispositionOf(sm, { explicit: true, probe: a.probe })).toEqual({
        action: 'fail',
        code: 'UNSUPPORTED_FORMAT',
      });

      // MP4 VP9 + Opus + portada → tal cual.
      const b = await prescanVideo(ff, { path: mp4, container: 'mp4', demuxer: 'mov' });
      expect(b.summary).toMatchObject({ videoCodec: 'vp9', width: 320, height: 240 });
      expect(b.decision).toEqual(store('video/mp4'));

      // MKV VP9 + Opus + portada adjunta → remultiplexar; la salida lleva solo el VP9 (-map 0:V:0).
      const c = await prescanVideo(ff, { path: mkv, container: 'mkv', demuxer: 'matroska' });
      expect(c.probe.streams.some((s) => s.disposition?.attached_pic === 1)).toBe(true);
      expect(c.decision).toEqual(remux());
      if (c.decision.kind !== 'process') throw new Error('se esperaba procesar');
      const fileId = randomBytes(16);
      const tmpPath = join(covers, `${fileId.toString('hex')}.part`);
      const writer = createObjectWriter({ kind: KIND_MEDIA, fileId, kWrap, tmpPath });
      await transcodeToSink({
        ffmpeg: ff,
        input: { kind: 'file', path: mkv, demuxer: 'matroska' },
        decision: c.decision,
        sink: writer,
        durationMs: c.summary.durationMs,
      });
      await writer.finish();
      const lb = await LoopbackServer.start({
        open: (t) => openObject(t.path, { fileId: t.fileId, kind: t.kind }, kWrap),
      });
      try {
        const url = lb.register('part', {
          path: tmpPath,
          fileId,
          kind: KIND_MEDIA,
          mime: 'video/mp4',
        });
        await verifyProcessedVideo({ ffmpeg: ff, url, expectedDurationMs: c.summary.durationMs });
        const out = await probeVideo(ff, { kind: 'loopback', url, demuxer: 'mov' });
        expect(
          out.probe.streams.filter((s) => s.codec_type === 'video').map((s) => s.codec_name),
        ).toEqual(['vp9']);
      } finally {
        await lb.close();
      }
    } finally {
      removeTmpDir(covers);
    }
  }, 120_000);
});
