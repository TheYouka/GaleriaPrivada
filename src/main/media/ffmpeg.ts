// ffmpeg/ffprobe en tiempo de ejecución (docs/DESIGN.md §19.4, PLAN.md 2.1 [H3-11]).
//
// - Único archivo de src/ que puede importar child_process (regla ESLint de §5.4, punto 10).
// - Los procesos solo se lanzan con un FfmpegCommand, y los FfmpegCommand solo los crean los
//   constructores de este módulo (símbolo privado; F5 añade mergeCommand, §18.3). Ningún constructor acepta una ruta de salida:
//   las salidas de ffmpeg van siempre a `pipe:1` (y el progreso a `pipe:2`).
// - Cada entrada lleva `-f <demuxer>` justo antes de su `-i` (sin autodetección) y cada comando
//   con entrada lleva `-protocol_whitelist`: `file,pipe` para un original del usuario y
//   `http,tcp,pipe` para un objeto de la bóveda servido por el loopback (§18.5). ffmpeg nunca lee
//   un archivo descifrado del disco: los objetos de la bóveda solo le llegan por el loopback.
// - spawn sin shell, `windowsHide`, `stdio: ['ignore', 'pipe', 'pipe']`, entorno mínimo
//   (`SystemRoot` en Windows; `LD_LIBRARY_PATH` en Linux), timeout por comando y `AbortSignal`
//   (al abortar, kill inmediato, §13.3 paso 2).
// - [H3-11] loadDecoders() ejecuta una vez `ffmpeg -hide_banner -decoders` y guarda el conjunto de
//   códecs de vídeo que FFmpeg sabe decodificar.
//
// Este módulo no importa `electron`: index.ts le pasa isPackaged y las rutas (se prueba en Vitest).
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { MERGE_RESOLUTIONS } from '@shared/constants';
import { AppErrorException, type ErrorCode } from '@shared/errors';
import type { MergeResolution } from '@shared/types';
import { log } from '../log';

export type FfmpegTool = 'ffmpeg' | 'ffprobe';

/** Demuxers que se fuerzan con `-f` (§12.4 paso 0, §19.4) y los de música de §8.6.1 (F4). */
export const DEMUXERS = ['mov', 'matroska', 'avi', 'mp3', 'aac', 'ogg', 'flac', 'wav'] as const;
export type Demuxer = (typeof DEMUXERS)[number];

/** Timeouts de §19.4. Conversión y fusión no tienen timeout (son cancelables). */
export const PROBE_TIMEOUT_MS = 30_000;
export const FRAME_TIMEOUT_MS = 30_000;
export const DECODERS_TIMEOUT_MS = 30_000;
/** Cola de stderr que se conserva (§12.5: últimas 2 KiB). */
export const STDERR_TAIL_BYTES = 2048;

/** URL del loopback: http://127.0.0.1:<puerto>/<token de 43 base64url>/<ref> (§18.5). */
export const LOOPBACK_URL_PATTERN =
  /^http:\/\/127\.0\.0\.1:\d{1,5}\/[A-Za-z0-9_-]{43}\/[a-z]{1,8}$/;

/** Original del usuario en su disco (en claro, pero no es un descifrado de la app). */
export interface FileInput {
  kind: 'file';
  path: string;
  demuxer: Demuxer;
}

/** Objeto de la bóveda descifrado al vuelo por el loopback (§18.5). */
export interface LoopbackInput {
  kind: 'loopback';
  url: string;
  demuxer: Demuxer;
}

export type FfmpegInput = FileInput | LoopbackInput;

const COMMAND: unique symbol = Symbol('FfmpegCommand');

/** Comando listo para lanzar. Solo lo crean los constructores de este módulo. */
export interface FfmpegCommand {
  readonly [COMMAND]: true;
  readonly tool: FfmpegTool;
  readonly args: readonly string[];
  /** null = sin timeout (cancelable con el AbortSignal). */
  readonly timeoutMs: number | null;
  /** true si los args llevan `-progress pipe:2` (stderr se pasa al parser de progreso). */
  readonly progress: boolean;
  /** Ruta del original, para quitarla de la cola de stderr (§12.5). */
  readonly redact: string | null;
}

function command(
  tool: FfmpegTool,
  args: string[],
  timeoutMs: number | null,
  progress: boolean,
  redact: string | null,
): FfmpegCommand {
  return Object.freeze({
    [COMMAND]: true as const,
    tool,
    args: Object.freeze(args),
    timeoutMs,
    progress,
    redact,
  });
}

function assertDemuxer(demuxer: string): asserts demuxer is Demuxer {
  if (!(DEMUXERS as readonly string[]).includes(demuxer))
    throw new RangeError('demuxer no admitido');
}

/**
 * `-protocol_whitelist <lista> -f <demuxer> -i <fuente>` para una entrada. Un original se pasa con
 * el prefijo `file:` para que ffmpeg nunca interprete el nombre como otro protocolo.
 */
function inputArgs(input: FfmpegInput): {
  whitelist: string;
  args: string[];
  redact: string | null;
} {
  assertDemuxer(input.demuxer);
  if (input.kind === 'file') {
    if (typeof input.path !== 'string' || !isAbsolute(input.path) || input.path.includes('\0')) {
      throw new RangeError('la entrada tiene que ser una ruta absoluta');
    }
    return {
      whitelist: 'file,pipe',
      args: ['-f', input.demuxer, '-i', `file:${input.path}`],
      redact: input.path,
    };
  }
  if (input.kind === 'loopback') {
    if (!LOOPBACK_URL_PATTERN.test(input.url)) throw new RangeError('URL de loopback inválida');
    return {
      whitelist: 'http,tcp,pipe',
      args: ['-f', input.demuxer, '-i', input.url],
      redact: null,
    };
  }
  throw new RangeError('tipo de entrada desconocido');
}

// ── Constructores ──────────────────────────────────────────────────────────────────────────────

/** ffprobe con el demuxer forzado; JSON por stdout (§12.4 paso 0, §18.6 paso 3). Timeout 30 s. */
export function probeCommand(input: FfmpegInput): FfmpegCommand {
  const src = inputArgs(input);
  return command(
    'ffprobe',
    [
      '-hide_banner',
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-protocol_whitelist',
      src.whitelist,
      ...src.args,
    ],
    PROBE_TIMEOUT_MS,
    false,
    src.redact,
  );
}

/**
 * Un fotograma en PNG por pipe:1 (§12.4 paso 4): solo desde un objeto de la bóveda por el
 * loopback. Timeout 30 s.
 */
export function frameCommand(opts: { input: LoopbackInput; atSeconds: number }): FfmpegCommand {
  const { atSeconds } = opts;
  if (opts.input?.kind !== 'loopback')
    throw new RangeError('el fotograma solo se lee por loopback');
  if (!Number.isFinite(atSeconds) || atSeconds < 0) throw new RangeError('instante inválido');
  const src = inputArgs(opts.input);
  return command(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-protocol_whitelist',
      src.whitelist,
      '-ss',
      atSeconds.toFixed(3),
      ...src.args,
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      'pipe:1',
    ],
    FRAME_TIMEOUT_MS,
    false,
    src.redact,
  );
}

export type VideoAction = 'copy' | 'vp9';
export type AudioAction = 'copy' | 'opus';

/**
 * Remultiplexar o recodificar a MP4 fragmentado por pipe:1 (§12.5). Sin timeout (cancelable).
 * `genpts` para AVI: `-fflags +genpts` antes de `-f avi -i`.
 */
export function transcodeCommand(opts: {
  input: FfmpegInput;
  video: VideoAction;
  audio: AudioAction;
  genpts?: boolean;
}): FfmpegCommand {
  const src = inputArgs(opts.input);
  const video =
    opts.video === 'copy'
      ? ['-c:v', 'copy']
      : opts.video === 'vp9'
        ? [
            '-c:v',
            'libvpx-vp9',
            '-deadline',
            'good',
            '-cpu-used',
            '5',
            '-row-mt',
            '1',
            '-crf',
            '31',
            '-b:v',
            '0',
            '-pix_fmt',
            'yuv420p',
            '-force_key_frames',
            'expr:gte(t,n_forced*4)',
          ]
        : null;
  const audio =
    opts.audio === 'copy'
      ? ['-c:a', 'copy']
      : opts.audio === 'opus'
        ? ['-c:a', 'libopus', '-b:a', '160k', '-ac', '2']
        : null;
  if (!video || !audio) throw new RangeError('acción de vídeo o audio desconocida');
  return command(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-progress',
      'pipe:2',
      '-nostats',
      '-protocol_whitelist',
      src.whitelist,
      ...(opts.genpts ? ['-fflags', '+genpts'] : []),
      ...src.args,
      // `V` (mayúscula): primera pista de vídeo que no es una portada (attached_pic), la misma
      // que elige summarizeProbe (PLAN.md, nota 104; §12.5 dice `0:v:0`).
      '-map',
      '0:V:0',
      '-map',
      '0:a:0?',
      '-sn',
      '-dn',
      ...video,
      ...audio,
      '-f',
      'mp4',
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof',
      'pipe:1',
    ],
    null,
    true,
    src.redact,
  );
}

/** Audio de la fusión ya resuelto (§18.3): `mix` solo si los dos lados tienen audio. */
export type MergeAudioGraph = 'left' | 'right' | 'mix' | 'none';

export interface MergeCommandOptions {
  /** Entrada 0 (izquierda) y 1 (derecha): objetos de la bóveda por el loopback. */
  left: LoopbackInput;
  right: LoopbackInput;
  /** `H` de §18.2 (la altura «Automática»): par, entre 2 y 1080. */
  height: number;
  /**
   * Resolución elegida (nota 209): 'auto' usa `height`; si no, una altura de la lista cerrada
   * MERGE_RESOLUTIONS (cualquier otro valor lanza RangeError).
   */
  resolution: MergeResolution;
  /** `FPS` de §18.2 (0 < FPS ≤ 60); se escribe con 3 decimales. */
  fps: number;
  /** `D` de §18.2 en segundos; se escribe con 3 decimales. */
  durationS: number;
  /** `Δ` de §18.2 en segundos (≥ 0); solo se usa con `pad`. */
  deltaS: number;
  /** Lado al que se añade `tpad` (el más corto con duration = longest), o null. */
  pad: 'left' | 'right' | null;
  audio: MergeAudioGraph;
}

const AUDIO_GRAPH: Readonly<Record<MergeAudioGraph, string>> = Object.freeze({
  left: ';[0:a:0]aresample=48000,apad[a]',
  right: ';[1:a:0]aresample=48000,apad[a]',
  mix: ';[0:a:0]aresample=48000[a0];[1:a:0]aresample=48000[a1];[a0][a1]amix=inputs=2:duration=longest:normalize=1,apad[a]',
  none: '',
});

/** Altura de salida: `height` con 'auto'; si no, la elegida (ya validada contra la lista cerrada). */
export function mergeOutputHeight(
  opts: Pick<MergeCommandOptions, 'height' | 'resolution'>,
): number {
  return opts.resolution === 'auto' ? opts.height : opts.resolution;
}

/** `<GRAFO>` de §18.3 (escala a `H`, hstack y el audio elegido). */
export function mergeFilterGraph(opts: MergeCommandOptions): string {
  const pad = `,tpad=stop_mode=clone:stop_duration=${opts.deltaS.toFixed(3)}`;
  const chain = (input: 0 | 1, side: 'left' | 'right', label: string): string =>
    `[${input}:v]scale=-2:${mergeOutputHeight(opts)}:flags=bicubic,setsar=1,fps=${opts.fps.toFixed(3)},` +
    `format=yuv420p${opts.pad === side ? pad : ''}[${label}]`;
  return (
    `${chain(0, 'left', 'l')};${chain(1, 'right', 'r')};[l][r]hstack=inputs=2:shortest=1[v]` +
    AUDIO_GRAPH[opts.audio]
  );
}

/**
 * Fusión de dos vídeos de la bóveda (§18.3, línea de comandos exacta): las dos entradas por el
 * loopback (`-seekable 1 -f <demuxer> -i http://127.0.0.1:…`), VP9 + Opus (nunca H.264, §19) en MP4
 * fragmentado por pipe:1 (§18.4) y progreso por pipe:2. Sin timeout (cancelable).
 */
export function mergeCommand(opts: MergeCommandOptions): FfmpegCommand {
  if (opts.left?.kind !== 'loopback' || opts.right?.kind !== 'loopback') {
    throw new RangeError('la fusión solo lee por loopback');
  }
  const { height, fps, durationS, deltaS } = opts;
  if (!Number.isInteger(height) || height < 2 || height > 1080 || height % 2 !== 0) {
    throw new RangeError('altura inválida');
  }
  if (!(MERGE_RESOLUTIONS as readonly unknown[]).includes(opts.resolution)) {
    throw new RangeError('resolución inválida');
  }
  if (!Number.isFinite(fps) || fps <= 0 || fps > 60) throw new RangeError('fps inválido');
  if (!Number.isFinite(durationS) || durationS <= 0) throw new RangeError('duración inválida');
  if (!Number.isFinite(deltaS) || deltaS < 0) throw new RangeError('Δ inválido');
  if (opts.pad !== null && opts.pad !== 'left' && opts.pad !== 'right') {
    throw new RangeError('pad inválido');
  }
  if (!(opts.audio in AUDIO_GRAPH)) throw new RangeError('audio inválido');
  const left = inputArgs(opts.left);
  const right = inputArgs(opts.right);
  const withAudio = opts.audio !== 'none';
  return command(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostdin',
      '-v',
      'error',
      '-progress',
      'pipe:2',
      '-nostats',
      '-protocol_whitelist',
      'http,tcp,pipe',
      '-seekable',
      '1',
      ...left.args,
      '-seekable',
      '1',
      ...right.args,
      '-filter_complex',
      mergeFilterGraph(opts),
      '-map',
      '[v]',
      ...(withAudio ? ['-map', '[a]'] : ['-an']),
      '-t',
      durationS.toFixed(3),
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'good',
      '-cpu-used',
      '5',
      '-row-mt',
      '1',
      '-crf',
      '32',
      '-b:v',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-force_key_frames',
      'expr:gte(t,n_forced*4)',
      ...(withAudio ? ['-c:a', 'libopus', '-b:a', '160k', '-ac', '2'] : []),
      '-map_metadata',
      '-1',
      '-map_chapters',
      '-1',
      '-f',
      'mp4',
      '-movflags',
      '+frag_keyframe+empty_moov+default_base_moof',
      'pipe:1',
    ],
    null,
    true,
    null,
  );
}

/** `ffmpeg -hide_banner -decoders` [H3-11]: sin entrada ni salida. Timeout 30 s. */
export function decodersCommand(): FfmpegCommand {
  return command(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-decoders'],
    DECODERS_TIMEOUT_MS,
    false,
    null,
  );
}

// ── Parsers ────────────────────────────────────────────────────────────────────────────────────

export interface FfmpegProgress {
  /** `out_time_us` del último bloque (null si ffmpeg dio N/A). */
  outTimeUs: number | null;
  /** `progress=end`. */
  done: boolean;
}

const PROGRESS_KEYS: ReadonlySet<string> = new Set([
  'frame',
  'fps',
  'bitrate',
  'total_size',
  'out_time_us',
  'out_time_ms',
  'out_time',
  'dup_frames',
  'drop_frames',
  'speed',
  'progress',
]);

function isProgressLine(key: string): boolean {
  return PROGRESS_KEYS.has(key) || /^stream_\d+_\d+_q$/.test(key);
}

/**
 * Parser de `-progress pipe:2`: bloques de líneas `clave=valor` que terminan en `progress=continue`
 * o `progress=end`. Las líneas que no son de progreso (errores con `-v error`) van a `onOther`.
 */
export function createProgressParser(
  onProgress: (p: FfmpegProgress) => void,
  onOther: (line: string) => void = () => undefined,
): { push(chunk: string | Buffer): void; end(): void } {
  let buffered = '';
  let outTimeUs: number | null = null;
  const line = (raw: string): void => {
    const text = raw.replace(/\r$/, '');
    const m = /^([a-z0-9_]+)=(.*)$/.exec(text);
    if (!m || !isProgressLine(m[1] as string)) {
      if (text.length > 0) onOther(text);
      return;
    }
    const key = m[1] as string;
    const value = (m[2] as string).trim();
    if (key === 'out_time_us') {
      outTimeUs = /^-?\d+$/.test(value) ? Math.max(0, Number(value)) : null;
    } else if (key === 'progress') {
      onProgress({ outTimeUs, done: value === 'end' });
    }
  };
  return {
    push(chunk) {
      buffered += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl = buffered.indexOf('\n');
      while (nl !== -1) {
        line(buffered.slice(0, nl));
        buffered = buffered.slice(nl + 1);
        nl = buffered.indexOf('\n');
      }
    },
    end() {
      if (buffered.length > 0) line(buffered);
      buffered = '';
    },
  };
}

/**
 * [H3-11] Códecs de vídeo con decodificador, a partir de `ffmpeg -decoders`. Cada línea de la
 * tabla (tras `------`) es ` V..... <decodificador> <descripción>`; se añade el nombre del
 * decodificador y, si la descripción dice `(codec <x>)` (p. ej. libdav1d → av1), también `<x>`.
 */
export function parseDecoders(text: string): Set<string> {
  const video = new Set<string>();
  let inTable = false;
  for (const raw of text.split(/\r?\n/)) {
    if (!inTable) {
      if (/^\s*-{6}\s*$/.test(raw)) inTable = true;
      continue;
    }
    const m = /^\s*([VAS])[A-Z.]{5}\s+(\S+)\s*(.*)$/.exec(raw);
    if (!m || m[1] !== 'V') continue;
    video.add(m[2] as string);
    const codec = /\(codec ([a-z0-9_]+)\)/.exec(m[3] as string);
    if (codec) video.add(codec[1] as string);
  }
  return video;
}

// ── Binarios y procesos ────────────────────────────────────────────────────────────────────────

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
  /** Linux: carpeta de las .so (LD_LIBRARY_PATH). */
  libDir: string | null;
}

/**
 * Empaquetado: `<resourcesPath>/ffmpeg/bin/…`; en desarrollo: `<appPath>/resources/ffmpeg/<os>-x64/bin/…`
 * (lo deja ahí `npm run fetch:ffmpeg`, §19.3).
 */
export function resolveFfmpegPaths(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
}): FfmpegPaths {
  const platform = opts.platform ?? process.platform;
  const exe = platform === 'win32' ? '.exe' : '';
  const base = opts.isPackaged
    ? join(opts.resourcesPath, 'ffmpeg')
    : join(opts.appPath, 'resources', 'ffmpeg', platform === 'win32' ? 'win-x64' : 'linux-x64');
  return {
    ffmpeg: join(base, 'bin', `ffmpeg${exe}`),
    ffprobe: join(base, 'bin', `ffprobe${exe}`),
    libDir: platform === 'linux' ? join(base, 'lib') : null,
  };
}

/** Entorno mínimo del proceso hijo (§19.4): nada del entorno de la app. */
export function minimalEnv(
  paths: FfmpegPaths,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform === 'win32') return { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' };
  return paths.libDir ? { LD_LIBRARY_PATH: paths.libDir } : {};
}

/** Fallo de un proceso: FFMPEG_FAILED (código ≠ 0, timeout, salida demasiado grande), CANCELLED o FFMPEG_MISSING. */
export class FfmpegError extends AppErrorException {
  /** Últimas 2 KiB de stderr, con la ruta del original sustituida por `<input>`. Nunca se registra (§21.2). */
  readonly stderrTail: string;

  constructor(code: ErrorCode, reason: string, stderrTail = '') {
    super({ code, details: { reason } });
    this.stderrTail = stderrTail;
  }
}

export interface RunningFfmpeg {
  /** Salida (pipe:1). Quien la consume aplica backpressure. */
  readonly stdout: Readable;
  /** Se resuelve con código 0; si no, rechaza con FfmpegError. */
  readonly done: Promise<void>;
  /** kill inmediato (idempotente). */
  kill(): void;
}

export interface StartOptions {
  signal?: AbortSignal;
  onProgress?: (p: FfmpegProgress) => void;
}

export type SpawnFn = (bin: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface FfmpegOptions {
  platform?: NodeJS.Platform;
  /** Solo tests. */
  spawn?: SpawnFn;
  /** Solo tests. */
  access?: (path: string) => Promise<void>;
}

/** Cola acotada de texto (las últimas `max` unidades). */
class Tail {
  private text = '';
  constructor(private readonly max: number) {}
  add(s: string): void {
    this.text = (this.text + s).slice(-this.max);
  }
  value(redact: string | null): string {
    return redact ? this.text.replaceAll(redact, '<input>') : this.text;
  }
}

export class Ffmpeg {
  private availableValue = false;
  private decoders: Promise<ReadonlySet<string> | null> | null = null;
  private readonly platform: NodeJS.Platform;
  private readonly spawnFn: SpawnFn;
  private readonly accessFn: (path: string) => Promise<void>;

  constructor(
    readonly paths: FfmpegPaths,
    options: FfmpegOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.spawnFn = options.spawn ?? ((bin, args, o) => nodeSpawn(bin, [...args], o));
    this.accessFn = options.access ?? ((p) => access(p, fsConstants.X_OK));
  }

  /** Resultado de la última comprobación (AppInfo.ffmpegAvailable). */
  get available(): boolean {
    return this.availableValue;
  }

  /** `fs.access(X_OK)` de los dos binarios (§19.4). */
  async checkAvailable(): Promise<boolean> {
    try {
      await Promise.all([this.accessFn(this.paths.ffmpeg), this.accessFn(this.paths.ffprobe)]);
      this.availableValue = true;
    } catch {
      this.availableValue = false;
      log.warn('ffmpeg.missing');
    }
    return this.availableValue;
  }

  /**
   * [H3-11] Ejecuta `-decoders` una sola vez y guarda los códecs de vídeo decodificables. null si
   * ffmpeg no está o falla (la importación de vídeo da FFMPEG_MISSING o FFMPEG_FAILED).
   */
  loadDecoders(): Promise<ReadonlySet<string> | null> {
    this.decoders ??= (async () => {
      if (!this.availableValue) return null;
      try {
        const out = await this.run(decodersCommand(), { maxStdoutBytes: 4 * 1024 * 1024 });
        return parseDecoders(out.toString('utf8'));
      } catch (err) {
        log.warn('ffmpeg.decoders-failed', {
          code: err instanceof AppErrorException ? err.error.code : 'INTERNAL',
        });
        return null;
      }
    })();
    return this.decoders;
  }

  /** Lanza el comando. FFMPEG_MISSING si no hay binarios; CANCELLED si la señal ya abortó. */
  start(cmd: FfmpegCommand, opts: StartOptions = {}): RunningFfmpeg {
    if ((cmd as Partial<FfmpegCommand>)[COMMAND] !== true)
      throw new TypeError('FfmpegCommand inválido');
    if (!this.availableValue) throw new FfmpegError('FFMPEG_MISSING', 'missing');
    if (opts.signal?.aborted) throw new FfmpegError('CANCELLED', 'aborted');
    const bin = cmd.tool === 'ffmpeg' ? this.paths.ffmpeg : this.paths.ffprobe;
    const child = this.spawnFn(bin, cmd.args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: minimalEnv(this.paths, this.platform),
    });
    const tail = new Tail(STDERR_TAIL_BYTES);
    const parser = cmd.progress
      ? createProgressParser(
          (p) => opts.onProgress?.(p),
          (l) => tail.add(`${l}\n`),
        )
      : null;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (parser) parser.push(chunk);
      else tail.add(chunk);
    });

    let reason: 'timeout' | 'aborted' | null = null;
    const kill = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const onAbort = (): void => {
      reason ??= 'aborted';
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer =
      cmd.timeoutMs === null
        ? null
        : setTimeout(() => {
            reason ??= 'timeout';
            kill();
          }, cmd.timeoutMs);

    const done = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err: FfmpegError | null): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        parser?.end();
        if (err) reject(err);
        else resolve();
      };
      child.once('error', (err: NodeJS.ErrnoException) => {
        const missing = err.code === 'ENOENT' || err.code === 'EACCES';
        if (!missing) log.warn('ffmpeg.failed', { errno: err.code, stage: 'spawn' });
        finish(new FfmpegError(missing ? 'FFMPEG_MISSING' : 'FFMPEG_FAILED', 'spawn'));
      });
      child.once('close', (code: number | null) => {
        if (reason === 'aborted') return finish(new FfmpegError('CANCELLED', 'aborted'));
        const stderr = tail.value(cmd.redact);
        if (reason === 'timeout') {
          log.warn('ffmpeg.failed', { stage: 'timeout' });
          return finish(new FfmpegError('FFMPEG_FAILED', 'timeout', stderr));
        }
        if (code !== 0) {
          log.warn('ffmpeg.failed', { stage: 'exit', count: code ?? -1 });
          return finish(new FfmpegError('FFMPEG_FAILED', 'exit', stderr));
        }
        finish(null);
      });
    });
    done.catch(() => undefined); // quien lo use recibe el rechazo; nunca queda sin manejar

    return { stdout: child.stdout as Readable, done, kill };
  }

  /** Lanza el comando y junta su stdout (ffprobe, fotograma, -decoders), como mucho `maxStdoutBytes`. */
  async run(cmd: FfmpegCommand, opts: StartOptions & { maxStdoutBytes: number }): Promise<Buffer> {
    const proc = this.start(cmd, opts);
    const parts: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    proc.stdout.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > opts.maxStdoutBytes) {
        tooLarge = true;
        proc.kill();
        return;
      }
      parts.push(chunk);
    });
    try {
      await proc.done;
    } catch (err) {
      if (tooLarge) throw new FfmpegError('FFMPEG_FAILED', 'too-large');
      throw err;
    }
    if (tooLarge) throw new FfmpegError('FFMPEG_FAILED', 'too-large');
    return Buffer.concat(parts);
  }
}
