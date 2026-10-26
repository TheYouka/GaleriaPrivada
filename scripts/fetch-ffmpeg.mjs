// Descarga, verifica y coloca ffmpeg/ffprobe (docs/DESIGN.md §19.2–§19.3, PLAN.md 2.1 [H3-9]).
// Herramienta de desarrollo: la app nunca usa la red. Uso:
//
//   node scripts/fetch-ffmpeg.mjs [--platform win|linux] [--record-sources] [--offline]
//
// 1. Busca el artefacto fijado en GALERIA_FFMPEG_ARCHIVE_DIR o en .cache/ffmpeg/; si no está, lo
//    descarga (salvo con --offline).
// 2. Comprueba su SHA-256 contra resources/ffmpeg/manifest.json ANTES de extraer o usar nada.
// 3. Extrae con el bsdtar del sistema (en Windows, %SystemRoot%\System32\tar.exe, que admite zip)
//    a una carpeta de preparación en .cache/ffmpeg/.
// 4. (Solo en la plataforma actual) ejecuta los binarios preparados: -encoders con libvpx-vp9 y
//    libopus, ffprobe -version, y [H3-9] ffmpeg -L y -version: licencia detectada y línea
//    `configuration:`. Falla con --enable-gpl, --enable-nonfree o una licencia que no sea LGPL.
// 5. Descarga (o toma de la caché) los dos paquetes de código fuente a .cache/ffmpeg/sources/ y
//    comprueba su SHA-256; con --record-sources escribe los que falten en el manifiesto.
// 6. Copia a resources/ffmpeg/<os>-x64/ bin/ffmpeg(.exe), bin/ffprobe(.exe), las DLL (Windows) o
//    lib/*.so* (Linux) y LICENSE.txt; copia a resources/licenses/ffmpeg/ el texto de la licencia
//    sacado del paquete de código fuente y escribe BUILDINFO.json.
//
// Los binarios de Linux solo se pueden ejecutar en Linux: con --platform linux en Windows se
// descarga y verifica el SHA-256 del artefacto y de las fuentes, y nada más (7.4).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST_PATH = join(ROOT, 'resources', 'ffmpeg', 'manifest.json');
const CACHE_DIR = join(ROOT, '.cache', 'ffmpeg');
const SOURCES_DIR = join(CACHE_DIR, 'sources');
const LICENSES_DIR = join(ROOT, 'resources', 'licenses', 'ffmpeg');
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const RUN_TIMEOUT_MS = 30_000;

function fail(message) {
  console.error(`fetch-ffmpeg: ERROR: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`fetch-ffmpeg: ${message}`);
}

// ── Argumentos ──────────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const hostPlatform =
    process.platform === 'win32' ? 'win' : process.platform === 'linux' ? 'linux' : null;
  const opts = { platform: hostPlatform, recordSources: false, offline: false, hostPlatform };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--record-sources') opts.recordSources = true;
    else if (arg === '--offline') opts.offline = true;
    else if (arg === '--platform') {
      opts.platform = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--platform=')) opts.platform = arg.slice('--platform='.length);
    else fail(`argumento desconocido: ${arg}`);
  }
  if (opts.platform !== 'win' && opts.platform !== 'linux') {
    fail('--platform tiene que ser win o linux (o ejecutarse en Windows o Linux)');
  }
  return opts;
}

// ── SHA-256, caché y descarga ───────────────────────────────────────────────────────────────────

async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Devuelve la ruta local de `entry` con su SHA-256 ya comprobado. `expected` vacío solo se admite
 * con `allowRecord` (fuentes con --record-sources): entonces devuelve el SHA-256 calculado.
 */
async function obtain(entry, dir, { offline, allowRecord }) {
  const expected = entry.sha256;
  if (expected !== '' && !HEX64.test(expected)) fail(`SHA-256 mal formado para ${entry.file}`);
  if (expected === '' && !allowRecord) {
    fail(`${entry.file} no tiene SHA-256 en el manifiesto; ejecuta con --record-sources`);
  }
  mkdirSync(dir, { recursive: true });
  const archiveDir = process.env.GALERIA_FFMPEG_ARCHIVE_DIR;
  const candidates = [];
  if (archiveDir) candidates.push({ path: join(archiveDir, entry.file), from: 'archivo propio' });
  candidates.push({ path: join(dir, entry.file), from: 'caché' });

  for (const c of candidates) {
    if (!existsSync(c.path)) continue;
    const actual = await sha256File(c.path);
    if (expected !== '' && actual !== expected) {
      fail(
        `SHA-256 de ${entry.file} (${c.from}) no coincide: esperado ${expected}, obtenido ` +
          `${actual}. No se usa. Borra el archivo o restaura la copia correcta.`,
      );
    }
    info(`${entry.file}: SHA-256 verificado (${c.from}, sin red)`);
    return { path: c.path, sha256: actual };
  }

  if (offline) fail(`${entry.file} no está en la caché y se pidió --offline`);
  info(`descargando ${entry.url}`);
  const partial = join(dir, `${entry.file}.download`);
  rmSync(partial, { force: true });
  let res;
  try {
    res = await fetch(entry.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    fail(`no se pudo descargar ${entry.file}: ${err?.cause?.code ?? err?.name ?? 'error'}`);
  }
  if (!res.ok || !res.body) fail(`descarga de ${entry.file}: HTTP ${res.status} (R9)`);
  const hash = createHash('sha256');
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => hash.update(chunk));
  await pipeline(body, createWriteStream(partial, { flags: 'wx' }));
  const actual = hash.digest('hex');
  if (expected !== '' && actual !== expected) {
    rmSync(partial, { force: true });
    fail(
      `SHA-256 de la descarga de ${entry.file} no coincide: esperado ${expected}, obtenido ` +
        `${actual}. Se borró la descarga y no se usa.`,
    );
  }
  const final = join(dir, entry.file);
  renameSync(partial, final);
  info(`${entry.file}: descargado (${statSync(final).size} bytes), SHA-256 ${actual}`);
  return { path: final, sha256: actual };
}

// ── Extracción y ejecución ──────────────────────────────────────────────────────────────────────

function tarBin() {
  // En Windows, el bsdtar del sistema (admite zip y xz); el tar de Git for Windows no admite zip.
  if (process.platform === 'win32') {
    return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  }
  return 'tar';
}

function run(bin, args, env) {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    env,
    windowsHide: true,
    timeout: RUN_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function extract(archive, into) {
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  run(tarBin(), ['-xf', archive, '-C', into], process.env);
  const entries = readdirSync(into);
  if (entries.length !== 1) fail(`estructura inesperada en ${archive}`);
  return join(into, entries[0]);
}

/** Entorno mínimo, como en src/main/media/ffmpeg.ts (§19.4). */
function minimalEnv(platform, top) {
  if (platform === 'win') return { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' };
  return { LD_LIBRARY_PATH: join(top, 'lib') };
}

/** [H3-9] Licencia a partir de `ffmpeg -L` y de la línea `configuration:` de `ffmpeg -version`. */
function detectLicense(licenseText, configuration) {
  const flags = new Set(configuration.split(/\s+/).filter(Boolean));
  if (flags.has('--enable-nonfree') || /nonfree parts compiled in/i.test(licenseText)) {
    fail('el build trae --enable-nonfree: no es redistribuible');
  }
  if (flags.has('--enable-gpl')) fail('el build trae --enable-gpl: no es el build LGPL (D4)');
  const text = licenseText.replace(/\s+/g, ' ');
  if (!/GNU Lesser General Public License/.test(text)) {
    fail('ffmpeg -L no declara la GNU Lesser General Public License');
  }
  const v3 = /either version 3 of the License/.test(text);
  const v21 = /either version 2\.1 of the License/.test(text);
  if (v3 === v21) fail('ffmpeg -L no permite saber la versión de la LGPL');
  if (v3 !== flags.has('--enable-version3')) {
    fail('ffmpeg -L y --enable-version3 no coinciden');
  }
  return v3
    ? { license: 'LGPL-3.0-or-later', texts: ['COPYING.LGPLv3', 'COPYING.GPLv3'] }
    : { license: 'LGPL-2.1-or-later', texts: ['COPYING.LGPLv2.1'] };
}

function checkBuild(platform, top) {
  const exe = platform === 'win' ? '.exe' : '';
  const ffmpeg = join(top, 'bin', `ffmpeg${exe}`);
  const ffprobe = join(top, 'bin', `ffprobe${exe}`);
  const env = minimalEnv(platform, top);
  const encoders = run(ffmpeg, ['-hide_banner', '-encoders'], env);
  for (const name of ['libvpx-vp9', 'libopus']) {
    if (!new RegExp(`^\\s*[VAS][A-Z.]{5}\\s+${name}\\s`, 'm').test(encoders)) {
      fail(`ffmpeg -encoders no incluye ${name}`);
    }
  }
  run(ffprobe, ['-version'], env); // lanza si el código de salida no es 0
  const licenseText = run(ffmpeg, ['-hide_banner', '-L'], env);
  const versionText = run(ffmpeg, ['-version'], env);
  const versionLine = versionText.split(/\r?\n/)[0] ?? '';
  const configLine = versionText.split(/\r?\n/).find((l) => l.startsWith('configuration:'));
  if (!configLine) fail('ffmpeg -version no tiene la línea configuration:');
  const configuration = configLine.slice('configuration:'.length).trim();
  const detected = detectLicense(licenseText, configuration);
  return {
    ...detected,
    licenseStatement: licenseText.replace(/\s+/g, ' ').trim(),
    versionLine,
    configuration,
  };
}

/** Copia del paquete de código fuente de FFmpeg los textos de la licencia detectada. */
function copyLicenseTexts(sourceArchive, commit, texts) {
  const into = join(CACHE_DIR, 'license-extract');
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  const members = texts.map((t) => `FFmpeg-${commit}/${t}`);
  run(tarBin(), ['-xf', sourceArchive, '-C', into, ...members], process.env);
  rmSync(LICENSES_DIR, { recursive: true, force: true });
  mkdirSync(LICENSES_DIR, { recursive: true });
  for (const t of texts) {
    cpSync(join(into, `FFmpeg-${commit}`, t), join(LICENSES_DIR, t));
  }
  rmSync(into, { recursive: true, force: true });
}

function install(platform, top, destDir) {
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(join(destDir, 'bin'), { recursive: true });
  const exe = platform === 'win' ? '.exe' : '';
  for (const name of ['ffmpeg', 'ffprobe']) {
    cpSync(join(top, 'bin', `${name}${exe}`), join(destDir, 'bin', `${name}${exe}`));
  }
  if (platform === 'win') {
    for (const f of readdirSync(join(top, 'bin'))) {
      if (f.toLowerCase().endsWith('.dll')) cpSync(join(top, 'bin', f), join(destDir, 'bin', f));
    }
  } else {
    mkdirSync(join(destDir, 'lib'), { recursive: true });
    for (const f of readdirSync(join(top, 'lib'))) {
      if (/\.so(\.|$)/.test(f)) {
        cpSync(join(top, 'lib', f), join(destDir, 'lib', f), { verbatimSymlinks: true });
      }
    }
  }
  cpSync(join(top, 'LICENSE.txt'), join(destDir, 'LICENSE.txt'));
}

// ── Principal ───────────────────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const artifact = manifest.artifacts?.[opts.platform];
  if (!artifact) fail(`el manifiesto no tiene artefacto para ${opts.platform}`);

  // 1–2. Artefacto con su SHA-256 comprobado antes de extraerlo.
  const archive = await obtain(artifact, CACHE_DIR, { offline: opts.offline, allowRecord: false });

  // 5. Código fuente (LGPL, §19.1).
  let manifestChanged = false;
  const sources = {};
  for (const [key, entry] of Object.entries(manifest.sources)) {
    const got = await obtain(entry, SOURCES_DIR, {
      offline: opts.offline,
      allowRecord: opts.recordSources,
    });
    if (entry.sha256 === '') {
      entry.sha256 = got.sha256;
      manifestChanged = true;
      info(`${entry.file}: SHA-256 registrado en el manifiesto (${got.sha256})`);
    }
    sources[key] = got;
  }
  if (manifestChanged) writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  if (opts.platform !== opts.hostPlatform) {
    info(
      `artefacto de ${opts.platform} y fuentes verificados por SHA-256; la extracción y la ` +
        `ejecución solo se pueden comprobar en ${opts.platform} (PLAN.md 7.4)`,
    );
    return;
  }

  // 3–4. Extraer a la carpeta de preparación y comprobar el build antes de instalar nada.
  const top = extract(archive.path, join(CACHE_DIR, `staging-${opts.platform}`));
  const build = checkBuild(opts.platform, top);
  info(`licencia detectada: ${build.license}`);

  // 6. Instalar, licencias y BUILDINFO.json.
  const destDir = join(ROOT, 'resources', 'ffmpeg', artifact.dir);
  install(opts.platform, top, destDir);
  copyLicenseTexts(sources.ffmpeg.path, manifest.sources.ffmpeg.commit, build.texts);
  const buildInfo = {
    formatVersion: 1,
    platform: opts.platform,
    version: manifest.version,
    release: manifest.release,
    artifact: artifact.file,
    artifactSha256: artifact.sha256,
    ffmpegCommit: manifest.sources.ffmpeg.commit,
    ffmpegSourceSha256: manifest.sources.ffmpeg.sha256,
    btbnTag: manifest.sources.btbn.tag,
    btbnSourceSha256: manifest.sources.btbn.sha256,
    license: build.license,
    licenseTexts: build.texts,
    licenseStatement: build.licenseStatement,
    versionLine: build.versionLine,
    configuration: build.configuration,
  };
  writeFileSync(join(destDir, 'BUILDINFO.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);
  rmSync(join(CACHE_DIR, `staging-${opts.platform}`), { recursive: true, force: true });
  info(`instalado en resources/ffmpeg/${artifact.dir}/ (${build.versionLine})`);
}

await main();
