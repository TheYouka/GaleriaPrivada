'use strict';
// Spike de módulos nativos (docs/PLAN.md, tarea 0.8; docs/DESIGN.md §26.2, punto 12).
// Carga @node-rs/argon2, better-sqlite3-multiple-ciphers y sharp y comprueba que funcionan.
//   npm.cmd run spike:native        → dentro del proceso main de Electron (Node de Electron)
//   node scripts/native-spike.cjs   → en el Node del sistema (el que usa Vitest)
// Trabaja en tests/.tmp/spike/ (dentro de la ruta no ASCII del repo, a propósito) y lo borra al
// terminar. Imprime un JSON y sale con 0 si los tres módulos van bien o 1 si alguno falla.
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const isElectron = Boolean(process.versions.electron);
const repoRoot = path.resolve(__dirname, '..');
const tmpRoot = path.join(repoRoot, 'tests', '.tmp');
const workDir = path.join(tmpRoot, 'spike');
// userData de Chromium para el spike (si no, Electron crearía %APPDATA%\Electron). Se limpia al
// empezar la siguiente ejecución, porque Chromium mantiene archivos abiertos hasta salir.
const electronUserData = path.join(tmpRoot, 'spike-electron-userdata');

function errorInfo(err) {
  return {
    error: err && err.message ? String(err.message) : String(err),
    code: err && err.code ? String(err.code) : null,
  };
}

async function step(fn) {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return errorInfo(err);
  }
}

function assert(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: 'SPIKE_ASSERT' });
}

function packageVersion(name) {
  // Sin require('<pkg>/package.json'): sharp no lo expone en "exports".
  try {
    const file = path.join(repoRoot, 'node_modules', ...name.split('/'), 'package.json');
    return JSON.parse(fs.readFileSync(file, 'utf8')).version;
  } catch {
    return null;
  }
}

async function spikeArgon2(details) {
  const { hashRaw } = require('@node-rs/argon2');
  const salt = randomBytes(16);
  const opts = {
    memoryCost: 8 * 1024, // 8 MiB (en KiB)
    timeCost: 1,
    parallelism: 1,
    outputLen: 32,
    algorithm: 2, // Argon2id
    version: 1, // 0x13
    salt,
  };
  const a = await hashRaw(Buffer.from('contraseña-de-prueba', 'utf8'), opts);
  const b = await hashRaw(Buffer.from('contraseña-de-prueba', 'utf8'), opts);
  const c = await hashRaw(Buffer.from('otra-contraseña', 'utf8'), opts);
  assert(
    Buffer.isBuffer(a) && a.length === 32,
    `salida de ${a && a.length} bytes, se esperaban 32`,
  );
  assert(a.equals(b), 'mismo input y sal dan hashes distintos');
  assert(!a.equals(c), 'contraseñas distintas dan el mismo hash');
  details.argon2 = { version: packageVersion('@node-rs/argon2'), outputBytes: a.length };
}

function openDb(Database, dbPath, keyArg, extraPragmas = []) {
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma("cipher = 'sqlcipher'");
  db.pragma('legacy = 4');
  for (const p of extraPragmas) db.pragma(p);
  if (keyArg) db.key(keyArg);
  return db;
}

function expectNotADb(fn, label) {
  try {
    fn();
  } catch (err) {
    assert(err.code === 'SQLITE_NOTADB', `${label}: código ${err.code}, se esperaba SQLITE_NOTADB`);
    return;
  }
  throw Object.assign(new Error(`${label}: la DB se abrió`), { code: 'SPIKE_ASSERT' });
}

async function spikeSqlcipher(details) {
  const Database = require('better-sqlite3-multiple-ciphers');
  const dbPath = path.join(workDir, 'spike.db');
  const rawKey = (bytes) => Buffer.from(`x'${bytes.toString('hex')}'`, 'ascii'); // 67 bytes
  const keyArg = rawKey(randomBytes(32));
  const wrongKeyArg = rawKey(randomBytes(32));
  const marker = `GALERIA_SPIKE_MARKER_${randomBytes(8).toString('hex')}`;

  // Crear, escribir y cerrar.
  let db = new Database(dbPath);
  db.pragma("cipher = 'sqlcipher'");
  db.pragma('legacy = 4');
  db.key(keyArg);
  db.exec('CREATE TABLE t (v TEXT NOT NULL)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run(marker);
  const mcVersion = db.prepare('SELECT sqlite3mc_version() AS v').get().v;
  const sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v;
  db.close();

  // Reabrir con la clave y leer el marcador.
  db = openDb(Database, dbPath, keyArg);
  const row = db.prepare('SELECT v FROM t').get();
  db.close();
  assert(row && row.v === marker, 'el marcador no se lee tras reabrir con la clave');

  // Clave cruda: con otro kdf_iter sigue abriendo, porque x'…' no pasa por el KDF de SQLCipher (R5).
  db = openDb(Database, dbPath, keyArg, ['kdf_iter = 1']);
  const rowRaw = db.prepare('SELECT v FROM t').get();
  db.close();
  assert(rowRaw && rowRaw.v === marker, "x'…' no se interpreta como clave cruda");

  // Clave incorrecta y sin clave → SQLITE_NOTADB.
  db = openDb(Database, dbPath, wrongKeyArg);
  expectNotADb(() => db.prepare('SELECT count(*) FROM sqlite_master').get(), 'clave incorrecta');
  db.close();
  db = openDb(Database, dbPath, null);
  expectNotADb(() => db.prepare('SELECT count(*) FROM sqlite_master').get(), 'sin clave');
  db.close();

  // El archivo no es un SQLite en claro y el marcador no aparece en sus bytes.
  const bytes = fs.readFileSync(dbPath);
  assert(
    bytes.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0',
    'la cabecera es SQLite en claro',
  );
  assert(bytes.indexOf(Buffer.from(marker, 'utf8')) === -1, 'el marcador aparece en claro');

  details.sqlcipher = {
    version: packageVersion('better-sqlite3-multiple-ciphers'),
    sqlite3mc: mcVersion,
    sqlite: sqliteVersion,
    keyForm: "db.key(Buffer x'<64 hex>')",
    rawKeyConfirmed: true,
    fileBytes: bytes.length,
  };
}

async function spikeSharp(details) {
  const sharp = require('sharp');
  const png = await sharp({
    create: { width: 64, height: 64, channels: 4, background: '#1b1b1f' },
  })
    .png()
    .toBuffer();
  const webp = await sharp(png).resize(32, 32).webp().toBuffer();
  const meta = await sharp(webp).metadata();
  assert(meta.format === 'webp', `formato ${meta.format}, se esperaba webp`);
  assert(meta.width === 32 && meta.height === 32, `tamaño ${meta.width}×${meta.height}`);
  details.sharp = {
    version: packageVersion('sharp'),
    libvips: sharp.versions && sharp.versions.vips,
    webpBytes: webp.length,
  };
}

async function run() {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  const details = {};
  const result = {
    runtime: {
      electron: process.versions.electron || null,
      node: process.versions.node,
      modules: process.versions.modules,
      napi: process.versions.napi,
      platform: process.platform,
      arch: process.arch,
      workDir,
    },
    argon2: await step(() => spikeArgon2(details)),
    sqlcipher: await step(() => spikeSqlcipher(details)),
    sharp: await step(() => spikeSharp(details)),
    details,
  };
  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    result.runtime.cleanup = !fs.existsSync(workDir);
  } catch (err) {
    result.runtime.cleanup = errorInfo(err);
  }
  const ok = result.argon2 === 'ok' && result.sqlcipher === 'ok' && result.sharp === 'ok';
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return ok ? 0 : 1;
}

if (isElectron) {
  const { app } = require('electron');
  fs.rmSync(electronUserData, { recursive: true, force: true });
  app.setPath('userData', electronUserData);
  app
    .whenReady()
    .then(run)
    .then(
      (code) => app.exit(code),
      (err) => {
        process.stderr.write(`${JSON.stringify(errorInfo(err))}\n`);
        app.exit(1);
      },
    );
} else {
  run().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${JSON.stringify(errorInfo(err))}\n`);
      process.exit(1);
    },
  );
}
