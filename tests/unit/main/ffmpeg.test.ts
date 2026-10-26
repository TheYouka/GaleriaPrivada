// media/ffmpeg.ts (docs/DESIGN.md §19.4, PLAN.md 2.1 [H3-11]): constructores de argumentos,
// parsers de -progress y -decoders, spawn endurecido y, si `npm run fetch:ffmpeg` dejó los
// binarios, ffprobe y -decoders reales.
import { execFileSync, spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createProgressParser,
  decodersCommand,
  Ffmpeg,
  FfmpegError,
  frameCommand,
  minimalEnv,
  parseDecoders,
  probeCommand,
  resolveFfmpegPaths,
  transcodeCommand,
  type FfmpegCommand,
  type FfmpegInput,
  type FfmpegProgress,
  type SpawnFn,
} from '../../../src/main/media/ffmpeg';
import { makeTmpDir, removeTmpDir } from '../helpers/tmp';

const ROOT = join(__dirname, '..', '..', '..');
const isWin = process.platform === 'win32';
const ORIGINAL = isWin ? 'C:\\Users\\ana\\Vídeos\\viaje a.mov' : '/home/ana/Vídeos/viaje a.mov';
const LOOPBACK = `http://127.0.0.1:50123/${'A'.repeat(43)}/src`;

const fileInput: FfmpegInput = { kind: 'file', path: ORIGINAL, demuxer: 'mov' };
const loopInput = { kind: 'loopback', url: LOOPBACK, demuxer: 'matroska' } as const;

/** Todos los comandos con entrada que pueden construirse. */
function commandsWithInput(): FfmpegCommand[] {
  return [
    probeCommand(fileInput),
    probeCommand(loopInput),
    frameCommand({ input: loopInput, atSeconds: 1 }),
    transcodeCommand({ input: fileInput, video: 'copy', audio: 'copy' }),
    transcodeCommand({ input: fileInput, video: 'vp9', audio: 'opus' }),
    transcodeCommand({
      input: { kind: 'file', path: ORIGINAL, demuxer: 'avi' },
      video: 'copy',
      audio: 'opus',
      genpts: true,
    }),
    transcodeCommand({ input: loopInput, video: 'copy', audio: 'copy' }),
  ];
}

function looksLikePath(arg: string): boolean {
  return /[\\/]/.test(arg) && !arg.startsWith('expr:') && arg !== '0:V:0' && arg !== '0:a:0?';
}

describe('constructores de argumentos', () => {
  it('cada -i va precedido de -f <demuxer> y la entrada aparece una sola vez', () => {
    for (const cmd of commandsWithInput()) {
      const { args } = cmd;
      const inputs = args.flatMap((a, i) => (a === '-i' ? [i] : []));
      expect(inputs).toHaveLength(1);
      const i = inputs[0] as number;
      expect(args[i - 2]).toBe('-f');
      expect(['mov', 'matroska', 'avi']).toContain(args[i - 1]);
      const pathLike = args.filter(looksLikePath);
      expect(pathLike).toEqual([args[i + 1]]);
    }
  });

  it('siempre llevan -protocol_whitelist antes de la entrada, según su origen', () => {
    for (const cmd of commandsWithInput()) {
      const w = cmd.args.indexOf('-protocol_whitelist');
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThan(cmd.args.indexOf('-i'));
      const src = cmd.args[cmd.args.indexOf('-i') + 1] as string;
      expect(cmd.args[w + 1]).toBe(src.startsWith('http:') ? 'http,tcp,pipe' : 'file,pipe');
    }
  });

  it('las salidas de ffmpeg van siempre a pipe:1; ffprobe no tiene salida', () => {
    for (const cmd of commandsWithInput()) {
      if (cmd.tool === 'ffmpeg') {
        expect(cmd.args.at(-1)).toBe('pipe:1');
        expect(cmd.args.filter((a) => a === 'pipe:1')).toHaveLength(1);
      } else {
        expect(cmd.args.at(-1)).toMatch(/^(file:|http:)/);
      }
    }
    expect(decodersCommand().args).toEqual(['-hide_banner', '-nostdin', '-decoders']);
  });

  it('ningún constructor admite una ruta de salida (campos extra se ignoran)', () => {
    const out = isWin ? 'C:\\Users\\ana\\salida.mp4' : '/home/ana/salida.mp4';
    const sneaky = { output: out, outputPath: out, out, dest: out } as Record<string, string>;
    const cmds = [
      probeCommand({ ...fileInput, ...sneaky } as FfmpegInput),
      frameCommand({ input: loopInput, atSeconds: 0, ...sneaky }),
      transcodeCommand({ input: fileInput, video: 'copy', audio: 'copy', ...sneaky }),
    ];
    for (const cmd of cmds) {
      expect(cmd.args.some((a) => a.includes('salida'))).toBe(false);
    }
  });

  it('el original va con el prefijo file: y la URL del loopback tal cual', () => {
    const probe = probeCommand(fileInput);
    expect(probe.args.at(-1)).toBe(`file:${ORIGINAL}`);
    expect(probe.redact).toBe(ORIGINAL);
    expect(probeCommand(loopInput).args.at(-1)).toBe(LOOPBACK);
  });

  it('rechaza entradas que no son una ruta absoluta o una URL de loopback válida', () => {
    expect(() => probeCommand({ kind: 'file', path: 'relativo.mov', demuxer: 'mov' })).toThrow(
      RangeError,
    );
    expect(() => probeCommand({ kind: 'file', path: `${ORIGINAL}\0x`, demuxer: 'mov' })).toThrow(
      RangeError,
    );
    for (const url of [
      'http://localhost:1/aaa/src',
      `http://127.0.0.1:1/${'A'.repeat(42)}/src`,
      `https://127.0.0.1:1/${'A'.repeat(43)}/src`,
      `http://127.0.0.1:1/${'A'.repeat(43)}/src?x=1`,
      `file:///${'A'.repeat(43)}`,
    ]) {
      expect(() => probeCommand({ kind: 'loopback', url, demuxer: 'mov' })).toThrow(RangeError);
    }
    expect(() =>
      probeCommand({ kind: 'file', path: ORIGINAL, demuxer: 'concat' as 'mov' }),
    ).toThrow(RangeError);
    expect(() =>
      frameCommand({ input: fileInput as unknown as typeof loopInput, atSeconds: 1 }),
    ).toThrow(RangeError);
    expect(() => frameCommand({ input: loopInput, atSeconds: Number.NaN })).toThrow(RangeError);
  });

  it('transcode: -fflags +genpts antes de -f avi y comando de §12.5', () => {
    const avi = transcodeCommand({
      input: { kind: 'file', path: ORIGINAL, demuxer: 'avi' },
      video: 'vp9',
      audio: 'opus',
      genpts: true,
    });
    const a = avi.args;
    expect(a.indexOf('-fflags')).toBeLessThan(a.indexOf('-f'));
    expect(a[a.indexOf('-fflags') + 1]).toBe('+genpts');
    expect(a).toContain('libvpx-vp9');
    expect(a[a.indexOf('-force_key_frames') + 1]).toBe('expr:gte(t,n_forced*4)');
    expect(a.slice(-5)).toEqual([
      '-f',
      'mp4',
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof',
      'pipe:1',
    ]);
    expect(avi.progress).toBe(true);
    expect(avi.timeoutMs).toBeNull();
    const copy = transcodeCommand({ input: fileInput, video: 'copy', audio: 'copy' }).args;
    expect(copy).toContain('-progress');
    expect(copy[copy.indexOf('-c:v') + 1]).toBe('copy');
    expect(copy[copy.indexOf('-c:a') + 1]).toBe('copy');
    expect(copy).not.toContain('-fflags');
    // `V` mayúscula: la primera pista de vídeo que no es una portada (nota 104).
    const maps = copy.flatMap((x, i) => (x === '-map' ? [copy[i + 1]] : []));
    expect(maps).toEqual(['0:V:0', '0:a:0?']);
  });

  it('frame: -ss antes de la entrada y PNG por image2pipe', () => {
    const a = frameCommand({ input: loopInput, atSeconds: 0.75 }).args;
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'));
    expect(a[a.indexOf('-ss') + 1]).toBe('0.750');
    expect(a.slice(-7)).toEqual(['-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1']);
  });

  it('timeouts de §19.4: ffprobe, fotograma y -decoders 30 s', () => {
    expect(probeCommand(fileInput).timeoutMs).toBe(30_000);
    expect(frameCommand({ input: loopInput, atSeconds: 0 }).timeoutMs).toBe(30_000);
    expect(decodersCommand().timeoutMs).toBe(30_000);
  });

  it('los comandos están congelados', () => {
    const cmd = probeCommand(fileInput);
    expect(Object.isFrozen(cmd)).toBe(true);
    expect(Object.isFrozen(cmd.args)).toBe(true);
  });
});

describe('parser de -progress', () => {
  it('emite out_time_us en cada bloque, con trozos cortados en cualquier sitio', () => {
    const text =
      'frame=10\nfps=0.0\nstream_0_0_q=-1.0\nbitrate=N/A\ntotal_size=48\nout_time_us=400000\n' +
      'out_time_ms=400000\nout_time=00:00:00.400000\ndup_frames=0\ndrop_frames=0\nspeed=0.8x\n' +
      'progress=continue\nout_time_us=N/A\nprogress=continue\r\nError while decoding stream #0:0\n' +
      'out_time_us=1000000\nprogress=end\n';
    const events: FfmpegProgress[] = [];
    const other: string[] = [];
    const parser = createProgressParser(
      (p) => events.push(p),
      (l) => other.push(l),
    );
    for (let i = 0; i < text.length; i += 7) parser.push(Buffer.from(text.slice(i, i + 7)));
    parser.end();
    expect(events).toEqual([
      { outTimeUs: 400000, done: false },
      { outTimeUs: null, done: false },
      { outTimeUs: 1000000, done: true },
    ]);
    expect(other).toEqual(['Error while decoding stream #0:0']);
  });

  it('una última línea sin salto se procesa en end()', () => {
    const events: FfmpegProgress[] = [];
    const parser = createProgressParser((p) => events.push(p));
    parser.push('out_time_us=5\nprogress=end');
    expect(events).toEqual([]);
    parser.end();
    expect(events).toEqual([{ outTimeUs: 5, done: true }]);
  });
});

describe('parser de -decoders [H3-11]', () => {
  const SAMPLE = [
    'Decoders:',
    ' V..... = Video',
    ' A..... = Audio',
    ' S..... = Subtitle',
    ' .F.... = Frame-level multithreading',
    ' ------',
    ' V....D 012v                 Uncompressed 4:2:2 10-bit',
    ' VFS..D h264                 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
    ' VFS..D hevc                 HEVC (High Efficiency Video Coding)',
    ' V....D libdav1d             dav1d AV1 decoder by VideoLAN (codec av1)',
    ' V....D libvpx-vp9           libvpx VP9 (codec vp9)',
    ' A....D aac                  AAC (Advanced Audio Coding)',
    ' S..... ass                  ASS (Advanced SubStation Alpha) subtitle',
    '',
  ].join('\r\n');

  it('solo vídeo, con el códec de los decodificadores externos', () => {
    const set = parseDecoders(SAMPLE);
    expect([...set].sort()).toEqual(
      ['012v', 'av1', 'h264', 'hevc', 'libdav1d', 'libvpx-vp9', 'vp9'].sort(),
    );
    expect(set.has('=')).toBe(false);
    expect(set.has('aac')).toBe(false);
  });

  it('sin tabla, conjunto vacío', () => {
    expect(parseDecoders('Decoders:\n V..... = Video\n').size).toBe(0);
  });
});

describe('rutas y entorno', () => {
  it('empaquetado y desarrollo, Windows y Linux (§19.4)', () => {
    const win = resolveFfmpegPaths({
      isPackaged: true,
      resourcesPath: 'C:\\App\\resources',
      appPath: 'C:\\App\\resources\\app.asar',
      platform: 'win32',
    });
    expect(win.ffmpeg).toBe(join('C:\\App\\resources', 'ffmpeg', 'bin', 'ffmpeg.exe'));
    expect(win.ffprobe).toBe(join('C:\\App\\resources', 'ffmpeg', 'bin', 'ffprobe.exe'));
    expect(win.libDir).toBeNull();
    const dev = resolveFfmpegPaths({
      isPackaged: false,
      resourcesPath: '/x',
      appPath: '/repo',
      platform: 'linux',
    });
    expect(dev.ffmpeg).toBe(join('/repo', 'resources', 'ffmpeg', 'linux-x64', 'bin', 'ffmpeg'));
    expect(dev.libDir).toBe(join('/repo', 'resources', 'ffmpeg', 'linux-x64', 'lib'));
  });

  it('entorno mínimo: SystemRoot en Windows, LD_LIBRARY_PATH en Linux', () => {
    const paths = { ffmpeg: 'f', ffprobe: 'p', libDir: '/opt/lib' };
    const win = minimalEnv(paths, 'win32');
    expect(Object.keys(win)).toEqual(['SystemRoot']);
    expect(minimalEnv(paths, 'linux')).toEqual({ LD_LIBRARY_PATH: '/opt/lib' });
  });
});

/** spawn falso que lanza `node -e <script>` y guarda las opciones recibidas. */
function fakeSpawn(
  script: string,
  seen: { bin?: string; args?: readonly string[]; options?: SpawnOptions }[],
): SpawnFn {
  return (bin, args, options) => {
    seen.push({ bin, args, options });
    return spawn(process.execPath, ['-e', script], { ...options, env: process.env });
  };
}

function fakeFfmpeg(script: string, seen: Parameters<typeof fakeSpawn>[1] = []): Ffmpeg {
  return new Ffmpeg(
    { ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe', libDir: null },
    { spawn: fakeSpawn(script, seen), access: async () => undefined },
  );
}

describe('Ffmpeg: disponibilidad y procesos', () => {
  it('sin binarios: available = false, FFMPEG_MISSING al lanzar y decoders null', async () => {
    const ff = new Ffmpeg(
      { ffmpeg: '/no/ffmpeg', ffprobe: '/no/ffprobe', libDir: null },
      { access: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })) },
    );
    expect(await ff.checkAvailable()).toBe(false);
    expect(ff.available).toBe(false);
    expect(() => ff.start(probeCommand(fileInput))).toThrow(FfmpegError);
    try {
      ff.start(probeCommand(fileInput));
    } catch (err) {
      expect((err as FfmpegError).error.code).toBe('FFMPEG_MISSING');
    }
    expect(await ff.loadDecoders()).toBeNull();
  });

  it('spawn sin shell, windowsHide, stdio fijo y entorno mínimo', async () => {
    const seen: Parameters<typeof fakeSpawn>[1] = [];
    const ff = fakeFfmpeg("process.stdout.write('{}')", seen);
    await ff.checkAvailable();
    const out = await ff.run(probeCommand(fileInput), { maxStdoutBytes: 100 });
    expect(out.toString()).toBe('{}');
    const [call] = seen;
    expect(call?.bin).toBe('/bin/ffprobe');
    expect(call?.options).toMatchObject({
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(call?.options?.env).toEqual(minimalEnv(ff.paths));
  });

  it('código ≠ 0 → FFMPEG_FAILED con la cola de stderr sin la ruta del original', async () => {
    const script = `process.stderr.write(${JSON.stringify(`Error opening input file:${ORIGINAL}.\n`)}); process.exit(1)`;
    const ff = fakeFfmpeg(script);
    await ff.checkAvailable();
    const err = await ff
      .run(probeCommand(fileInput), { maxStdoutBytes: 100 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FfmpegError);
    expect((err as FfmpegError).error.code).toBe('FFMPEG_FAILED');
    expect((err as FfmpegError).stderrTail).toBe('Error opening input file:<input>.\n');
    expect((err as FfmpegError).stderrTail).not.toContain('viaje');
  });

  it('abortar mata el proceso al momento → CANCELLED', async () => {
    const ff = fakeFfmpeg('setTimeout(() => {}, 60000)');
    await ff.checkAvailable();
    const ac = new AbortController();
    const proc = ff.start(transcodeCommand({ input: fileInput, video: 'copy', audio: 'copy' }), {
      signal: ac.signal,
    });
    const t0 = performance.now();
    setTimeout(() => ac.abort(), 50);
    const err = await proc.done.catch((e: unknown) => e);
    expect((err as FfmpegError).error.code).toBe('CANCELLED');
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(() => ff.start(probeCommand(fileInput), { signal: ac.signal })).toThrow(FfmpegError);
  });

  it('progreso por stderr con -progress pipe:2', async () => {
    const script =
      "process.stderr.write('out_time_us=250000\\nprogress=continue\\nout_time_us=500000\\nprogress=end\\n')";
    const ff = fakeFfmpeg(script);
    await ff.checkAvailable();
    const events: FfmpegProgress[] = [];
    const proc = ff.start(transcodeCommand({ input: fileInput, video: 'copy', audio: 'copy' }), {
      onProgress: (p) => events.push(p),
    });
    proc.stdout.resume();
    await proc.done;
    expect(events).toEqual([
      { outTimeUs: 250000, done: false },
      { outTimeUs: 500000, done: true },
    ]);
  });

  it('stdout por encima del límite → FFMPEG_FAILED too-large', async () => {
    const ff = fakeFfmpeg(
      'process.stdout.write(Buffer.alloc(100000)); setTimeout(() => {}, 60000)',
    );
    await ff.checkAvailable();
    const err = await ff
      .run(probeCommand(fileInput), { maxStdoutBytes: 1000 })
      .catch((e: unknown) => e);
    expect((err as FfmpegError).error.code).toBe('FFMPEG_FAILED');
    expect((err as FfmpegError).error.details?.reason).toBe('too-large');
  });

  it('un objeto que no sale de los constructores no se lanza', async () => {
    const ff = fakeFfmpeg('');
    await ff.checkAvailable();
    const forged = {
      tool: 'ffmpeg',
      args: ['-i', 'x', 'out.mp4'],
      timeoutMs: null,
      progress: false,
      redact: null,
    };
    expect(() => ff.start(forged as unknown as FfmpegCommand)).toThrow(TypeError);
  });
});

// ── Con los binarios reales (si existen) ─────────────────────────────────────────────────────────

const realPaths = resolveFfmpegPaths({ isPackaged: false, resourcesPath: '', appPath: ROOT });
const haveBinaries = existsSync(realPaths.ffmpeg) && existsSync(realPaths.ffprobe);

describe.skipIf(!haveBinaries)('binarios empaquetados', () => {
  const dir = haveBinaries ? makeTmpDir('ffmpeg') : '';
  afterAll(() => {
    if (dir) removeTmpDir(dir);
  });

  it('available y -decoders con h264, hevc, vp9, av1 y mpeg4 [H3-11]', async () => {
    const ff = new Ffmpeg(realPaths);
    expect(await ff.checkAvailable()).toBe(true);
    const decoders = await ff.loadDecoders();
    for (const codec of ['h264', 'hevc', 'vp9', 'vp8', 'av1', 'mpeg4']) {
      expect(decoders?.has(codec)).toBe(true);
    }
    expect(decoders?.has('aac')).toBe(false);
    expect(await ff.loadDecoders()).toBe(decoders); // una sola vez
  });

  it('ffprobe con el demuxer forzado sobre un MKV generado (ruta no ASCII)', async () => {
    const mkv = join(dir, 'prueba á.mkv');
    execFileSync(
      realPaths.ffmpeg,
      [
        '-hide_banner',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=64x48:rate=10:duration=1',
        '-c:v',
        'libvpx-vp9',
        '-y',
        mkv,
      ],
      { env: minimalEnv(realPaths), windowsHide: true },
    );
    const ff = new Ffmpeg(realPaths);
    await ff.checkAvailable();
    const out = await ff.run(probeCommand({ kind: 'file', path: mkv, demuxer: 'matroska' }), {
      maxStdoutBytes: 1024 * 1024,
    });
    const json = JSON.parse(out.toString('utf8')) as {
      streams: { codec_name: string; width: number }[];
    };
    expect(json.streams[0]?.codec_name).toBe('vp9');
    expect(json.streams[0]?.width).toBe(64);

    // Con el demuxer equivocado, ffprobe no autodetecta: falla.
    const err = await ff
      .run(probeCommand({ kind: 'file', path: mkv, demuxer: 'avi' }), {
        maxStdoutBytes: 1024 * 1024,
      })
      .catch((e: unknown) => e);
    expect((err as FfmpegError).error.code).toBe('FFMPEG_FAILED');
    expect((err as FfmpegError).stderrTail).not.toContain('prueba');
  });
});
