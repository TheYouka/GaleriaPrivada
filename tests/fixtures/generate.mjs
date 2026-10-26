// Generador de fixtures de test (docs/PLAN.md P12 y 2.8, docs/DESIGN.md §23.2). Nunca usa fotos
// reales: todo se sintetiza con sharp y con el ffmpeg empaquetado (`npm run fetch:ffmpeg`).
//
//   node tests/fixtures/generate.mjs        (también lo llaman tests/e2e/global-setup.ts y los
//                                            unitarios que lo necesitan, con generateFixtures())
//
// Escribe en tests/.tmp/fixtures/ y deja allí fixtures.json con la lista, los SHA-256 y el
// marcador. Si ya está todo, no regenera nada (idempotente). El MP4 de ≥ 1 GiB solo se genera con
// GALERIA_SLOW_TESTS=1.
//
// Marcador (§22, disco): 32 caracteres ASCII aleatorios (32 bytes), distintos en cada
// generación. Aparece en claro en el EXIF del JPEG (ImageDescription), en los píxeles del PNG (sin
// compresión, así sus bytes están literalmente en el archivo) y en el nombre de los dos archivos.
// Los E2E comprueban que, tras importar y bloquear, no aparece en ningún archivo de la raíz de datos.
import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const FIXTURES_DIR = join(ROOT, 'tests', '.tmp', 'fixtures');
export const FIXTURES_MANIFEST = join(FIXTURES_DIR, 'fixtures.json');
/** Sube con cualquier cambio de los fixtures: fuerza una regeneración completa. */
const GENERATOR_VERSION = 1;
/** Duración de los vídeos sintéticos (s): los E2E comparan la duración ± 0,5 s. */
export const VIDEO_SECONDS = 4;
const SLOW_BYTES = 1075 * 1024 * 1024; // > 1 GiB tras -fs

const isWin = process.platform === 'win32';
const ffmpegDir = join(ROOT, 'resources', 'ffmpeg', isWin ? 'win-x64' : 'linux-x64');
const ffmpegBin = join(ffmpegDir, 'bin', isWin ? 'ffmpeg.exe' : 'ffmpeg');
const ffmpegEnv = isWin
  ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }
  : { LD_LIBRARY_PATH: join(ffmpegDir, 'lib') };

function log(msg) {
  console.log(`fixtures: ${msg}`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function newMarker() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 32; i += 1) s += alphabet[randomInt(alphabet.length)];
  return s;
}

function ffmpeg(args, { bin = ffmpegBin, env = ffmpegEnv } = {}) {
  execFileSync(bin, ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 10 * 60 * 1000,
  });
}

/** testsrc2 + sine de VIDEO_SECONDS como entradas lavfi. */
function synthInputs(size = '320x240', rate = 25, seconds = VIDEO_SECONDS) {
  return [
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
  ];
}

const VP9 = [
  '-c:v',
  'libvpx-vp9',
  '-deadline',
  'realtime',
  '-cpu-used',
  '8',
  '-b:v',
  '400k',
  '-g',
  '25',
];

// ── Fotos ───────────────────────────────────────────────────────────────────────────────────────

async function photos(dir, marker) {
  const sharp = (await import('sharp')).default;
  const files = {};
  const noise = (w, h, channels) => {
    const buf = Buffer.alloc(w * h * channels);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const o = (y * w + x) * channels;
        buf[o] = (x * 255) / w;
        buf[o + 1] = (y * 255) / h;
        buf[o + 2] = (x ^ y) & 0xff;
        if (channels === 4) buf[o + 3] = 255;
      }
    }
    return buf;
  };

  // JPEG 640×480 con EXIF DateTimeOriginal, orientación 6 y el marcador (ImageDescription).
  const jpeg = `foto-${marker}.jpg`;
  await sharp(noise(640, 480, 3), { raw: { width: 640, height: 480, channels: 3 } })
    .jpeg({ quality: 85 })
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { ImageDescription: marker, Make: 'Galeria', Model: 'Fixture' },
      IFD2: { DateTimeOriginal: '2024:05:17 10:30:00' },
    })
    .toFile(join(dir, jpeg));
  files.jpeg = { file: jpeg, kind: 'photo' };

  // PNG con el marcador en los píxeles: compressionLevel 0 (bloques deflate almacenados) y sin
  // filtro adaptativo, así la fila 0 contiene los 32 bytes del marcador tal cual.
  const w = 64;
  const h = 48;
  const raw = noise(w, h, 4);
  Buffer.from(marker, 'ascii').copy(raw, 0);
  const png = `pixeles-${marker}.png`;
  await sharp(raw, { raw: { width: w, height: h, channels: 4 } })
    .png({ compressionLevel: 0, adaptiveFiltering: false })
    .toFile(join(dir, png));
  if (!readFileSync(join(dir, png)).includes(Buffer.from(marker, 'ascii'))) {
    throw new Error('el marcador no quedó en claro en los píxeles del PNG');
  }
  files.png = { file: png, kind: 'photo' };

  files.webp = { file: 'imagen.webp', kind: 'photo' };
  await sharp(noise(300, 200, 3), { raw: { width: 300, height: 200, channels: 3 } })
    .webp({ quality: 80 })
    .toFile(join(dir, files.webp.file));

  // GIF animado de 6 fotogramas.
  const frames = [];
  for (let i = 0; i < 6; i += 1) {
    frames.push(
      await sharp({
        create: {
          width: 96,
          height: 72,
          channels: 4,
          background: { r: i * 40, g: 120, b: 255 - i * 40, alpha: 1 },
        },
      })
        .png()
        .toBuffer(),
    );
  }
  files.gif = { file: 'animado.gif', kind: 'photo' };
  await sharp(frames, { join: { animated: true } })
    .gif()
    .toFile(join(dir, files.gif.file));

  files.avif = { file: 'imagen.avif', kind: 'photo' };
  await sharp(noise(320, 240, 3), { raw: { width: 320, height: 240, channels: 3 } })
    .avif({ quality: 60 })
    .toFile(join(dir, files.avif.file));

  return files;
}

// ── Formatos rechazados (§12.3): solo cabeceras escritas a mano ─────────────────────────────────

function bmp24(width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const buf = Buffer.alloc(54 + pixelBytes);
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10); // offset de los píxeles
  buf.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26); // planos
  buf.writeUInt16LE(24, 28); // bits por píxel
  buf.writeUInt32LE(0, 30); // BI_RGB
  buf.writeUInt32LE(pixelBytes, 34);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = 54 + y * rowSize + x * 3;
      buf[o] = x * 16;
      buf[o + 1] = y * 16;
      buf[o + 2] = 128;
    }
  }
  return buf;
}

/** Caja ftyp ISO-BMFF con la marca indicada y algo de relleno. */
function ftyp(major, compatible) {
  const brands = [major, ...compatible];
  const size = 16 + brands.length * 4;
  const box = Buffer.alloc(size);
  box.writeUInt32BE(size, 0);
  box.write('ftyp', 4, 'ascii');
  box.write(major, 8, 'ascii');
  box.writeUInt32BE(0, 12);
  brands.forEach((b, i) => box.write(b, 16 + i * 4, 'ascii'));
  return Buffer.concat([
    box,
    Buffer.from('\0\0\0\x10free fixture', 'latin1'),
    Buffer.alloc(256, 0x5a),
  ]);
}

function rejected(dir) {
  const files = {
    bmp: { file: 'mapa.bmp', kind: 'rejected' },
    cr3: { file: 'camara.CR3', kind: 'rejected' },
    heic: { file: 'movil.heic', kind: 'rejected' },
  };
  writeFileSync(join(dir, files.bmp.file), bmp24(16, 12));
  writeFileSync(join(dir, files.cr3.file), ftyp('crx ', ['crx ', 'isom']));
  writeFileSync(join(dir, files.heic.file), ftyp('heic', ['mif1', 'heic']));
  return files;
}

// ── Vídeos (testsrc2 + sine con el ffmpeg empaquetado) ──────────────────────────────────────────

function videos(dir) {
  const files = {};
  const make = (key, file, args, extra = {}) => {
    ffmpeg([...synthInputs(), ...args, join(dir, file)]);
    files[key] = { file, kind: 'video', seconds: VIDEO_SECONDS, ...extra };
  };
  make(
    'mp4Vp9Opus',
    'video-vp9-opus.mp4',
    [...VP9, '-c:a', 'libopus', '-b:a', '96k', '-f', 'mp4'],
    {
      action: 'as-is',
    },
  );
  make(
    'webmVp9Opus',
    'video-vp9-opus.webm',
    [...VP9, '-c:a', 'libopus', '-b:a', '96k', '-f', 'webm'],
    {
      action: 'as-is',
    },
  );
  make(
    'mkvVp9Opus',
    'video-vp9-opus.mkv',
    [...VP9, '-c:a', 'libopus', '-b:a', '96k', '-f', 'matroska'],
    {
      action: 'remux',
    },
  );
  make('mkvVp9Flac', 'video-vp9-flac.mkv', [...VP9, '-c:a', 'flac', '-f', 'matroska'], {
    action: 'remux',
  });
  make(
    'movMpeg4',
    'video-mpeg4.mov',
    ['-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'aac', '-b:a', '96k', '-f', 'mov'],
    {
      action: 'convert',
    },
  );
  make(
    'aviMpeg4',
    'video-mpeg4.avi',
    ['-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libmp3lame', '-b:a', '96k', '-f', 'avi'],
    {
      action: 'convert',
    },
  );
  return files;
}

/**
 * H.264 solo como herramienta de test (§23.2, nota 19 de PLAN.md): Windows → h264_mf; Linux → el
 * ffmpeg de la distro si trae libx264; en los dos, después, libopenh264 del build empaquetado. Si no
 * hay ningún codificador, null (los tests H.264 se marcan skip).
 */
function h264(dir) {
  const attempts = [];
  if (isWin) attempts.push({ encoder: 'h264_mf', args: ['-c:v', 'h264_mf', '-b:v', '600k'] });
  else {
    attempts.push({
      encoder: 'libx264',
      args: ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'],
      bin: 'ffmpeg',
      env: process.env,
    });
  }
  attempts.push({
    encoder: 'libopenh264',
    args: ['-c:v', 'libopenh264', '-b:v', '600k', '-pix_fmt', 'yuv420p'],
  });
  for (const a of attempts) {
    const mp4 = join(dir, 'video-h264-aac.mp4');
    try {
      ffmpeg([...synthInputs(), ...a.args, '-c:a', 'aac', '-b:a', '96k', '-f', 'mp4', mp4], a);
      ffmpeg([
        '-f',
        'mov',
        '-i',
        mp4,
        '-map',
        '0',
        '-c',
        'copy',
        '-f',
        'matroska',
        join(dir, 'video-h264-aac.mkv'),
      ]);
      return {
        encoder: a.encoder,
        files: {
          mp4H264Aac: {
            file: 'video-h264-aac.mp4',
            kind: 'video',
            seconds: VIDEO_SECONDS,
            action: 'as-is',
          },
          mkvH264Aac: {
            file: 'video-h264-aac.mkv',
            kind: 'video',
            seconds: VIDEO_SECONDS,
            action: 'remux',
          },
        },
      };
    } catch {
      rmSync(mp4, { force: true });
      log(`sin codificador H.264 ${a.encoder}`);
    }
  }
  return null;
}

/** MP4 de ≥ 1 GiB (bloqueo durante la importación, 2.13): -stream_loop -1 -c copy -fs. */
function slowVideo(dir) {
  const file = 'video-grande.mp4';
  const target = join(dir, file);
  if (existsSync(target) && statSync(target).size >= 1024 ** 3)
    return { file, kind: 'video', action: 'as-is' };
  const base = join(dir, 'base-grande.tmp.mp4');
  // Base de 10 s a 1280×720 y ~20 Mb/s: unas 45 vueltas hasta pasar de 1 GiB.
  ffmpeg([
    ...synthInputs('1280x720', 30, 10),
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-b:v',
    '20M',
    '-minrate',
    '20M',
    '-maxrate',
    '20M',
    '-g',
    '60',
    '-c:a',
    'libopus',
    '-b:a',
    '128k',
    '-f',
    'mp4',
    base,
  ]);
  const partial = `${target}.tmp`;
  ffmpeg([
    '-stream_loop',
    '-1',
    '-f',
    'mov',
    '-i',
    base,
    '-map',
    '0',
    '-c',
    'copy',
    '-fs',
    String(SLOW_BYTES),
    '-f',
    'mp4',
    partial,
  ]);
  rmSync(base, { force: true });
  if (statSync(partial).size < 1024 ** 3) throw new Error('el MP4 grande no llega a 1 GiB');
  renameSync(partial, target);
  return { file, kind: 'video', action: 'as-is' };
}

// ── Principal ───────────────────────────────────────────────────────────────────────────────────

function readManifest() {
  try {
    return JSON.parse(readFileSync(FIXTURES_MANIFEST, 'utf8'));
  } catch {
    return null;
  }
}

function complete(manifest, haveFfmpeg) {
  if (!manifest || manifest.version !== GENERATOR_VERSION) return false;
  if (haveFfmpeg !== manifest.ffmpeg) return false;
  return Object.values(manifest.files).every(
    (f) =>
      existsSync(join(FIXTURES_DIR, f.file)) &&
      statSync(join(FIXTURES_DIR, f.file)).size === f.bytes,
  );
}

function describe(files) {
  for (const f of Object.values(files)) {
    const path = join(FIXTURES_DIR, f.file);
    f.bytes = statSync(path).size;
    f.sha256 = sha256(path);
    f.first64Hex = readFileSync(path).subarray(0, 64).toString('hex');
  }
  return files;
}

/** Genera lo que falte. Devuelve el manifiesto (también escrito en fixtures.json). */
export async function generateFixtures({ slow = process.env.GALERIA_SLOW_TESTS === '1' } = {}) {
  const haveFfmpeg = existsSync(ffmpegBin);
  let manifest = readManifest();
  if (complete(manifest, haveFfmpeg)) {
    log('ya generados, no se regenera nada');
  } else {
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
    mkdirSync(FIXTURES_DIR, { recursive: true });
    const marker = newMarker();
    const files = { ...(await photos(FIXTURES_DIR, marker)), ...rejected(FIXTURES_DIR) };
    let h264Encoder = null;
    if (haveFfmpeg) {
      Object.assign(files, videos(FIXTURES_DIR));
      const h = h264(FIXTURES_DIR);
      if (h) {
        Object.assign(files, h.files);
        h264Encoder = h.encoder;
      }
    } else {
      log('sin ffmpeg empaquetado (npm run fetch:ffmpeg): solo fotos y formatos rechazados');
    }
    manifest = {
      version: GENERATOR_VERSION,
      marker,
      ffmpeg: haveFfmpeg,
      h264Encoder,
      videoSeconds: VIDEO_SECONDS,
      files: describe(files),
      slow: null,
    };
    writeFileSync(FIXTURES_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    log(
      `generados ${Object.keys(files).length} fixtures en tests/.tmp/fixtures/ (H.264: ${h264Encoder ?? 'no'})`,
    );
  }
  if (slow && haveFfmpeg) {
    const big =
      manifest.slow && existsSync(join(FIXTURES_DIR, manifest.slow.file))
        ? null
        : slowVideo(FIXTURES_DIR);
    if (big) {
      big.bytes = statSync(join(FIXTURES_DIR, big.file)).size;
      manifest.slow = big; // sin SHA-256 completo: lo calcula el test que lo usa
      writeFileSync(FIXTURES_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
      log(`MP4 de ${big.bytes} bytes generado`);
    }
  }
  return manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await generateFixtures();
}
