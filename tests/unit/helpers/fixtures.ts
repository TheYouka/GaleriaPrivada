// Fixtures generados (P12, PLAN.md 2.8) para los unitarios. Si ya están, solo se lee el
// manifiesto; si no, se lanza tests/fixtures/generate.mjs en un proceso aparte con un cerrojo
// (mkdir) para que dos archivos de test en paralelo no regeneren a la vez.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const FIXTURES_DIR = join(ROOT, 'tests', '.tmp', 'fixtures');
const MANIFEST = join(FIXTURES_DIR, 'fixtures.json');
const LOCK = join(ROOT, 'tests', '.tmp', 'fixtures.lock');
const STALE_MS = 15 * 60 * 1000;

export interface FixtureFile {
  file: string;
  kind: 'photo' | 'video' | 'rejected';
  action?: 'as-is' | 'remux' | 'convert';
  seconds?: number;
  bytes: number;
  sha256: string;
  first64Hex: string;
}

export interface FixtureManifest {
  marker: string;
  ffmpeg: boolean;
  h264Encoder: string | null;
  videoSeconds: number;
  files: Record<string, FixtureFile>;
}

function readComplete(): FixtureManifest | null {
  if (!existsSync(MANIFEST)) return null;
  try {
    const m = JSON.parse(readFileSync(MANIFEST, 'utf8')) as FixtureManifest;
    for (const f of Object.values(m.files)) {
      const p = join(FIXTURES_DIR, f.file);
      if (!existsSync(p) || statSync(p).size !== f.bytes) return null;
    }
    return m;
  } catch {
    return null;
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Manifiesto de los fixtures, generándolos si faltan. */
export function ensureFixtures(): FixtureManifest {
  const ready = readComplete();
  if (ready) return ready;
  const deadline = Date.now() + STALE_MS;
  for (;;) {
    try {
      mkdirSync(LOCK, { recursive: false });
      break;
    } catch {
      const done = readComplete();
      if (done) return done;
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) rmSync(LOCK, { recursive: true });
      } catch {
        // otro proceso lo soltó
      }
      if (Date.now() > deadline) throw new Error('fixtures: cerrojo ocupado demasiado tiempo');
      sleep(250);
    }
  }
  try {
    const again = readComplete();
    if (again) return again;
    execFileSync(process.execPath, [join(ROOT, 'tests', 'fixtures', 'generate.mjs')], {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
    });
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
  const generated = readComplete();
  if (!generated) throw new Error('fixtures: el generador no dejó un manifiesto completo');
  return generated;
}

export function fixturePath(manifest: FixtureManifest, key: string): string | null {
  const f = manifest.files[key];
  return f ? join(FIXTURES_DIR, f.file) : null;
}
