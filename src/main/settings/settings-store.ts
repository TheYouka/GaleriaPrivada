// Almacenes JSON en claro (docs/DESIGN.md §8.3 y §8.4): escritura atómica, settings.json (global:
// tema del selector) y prefs/<profileId>.json (por perfil). Nada de esto revela contenido de la
// bóveda: el tema y las preferencias de UI se guardan sin cifrar por decisión del usuario.
//
// writeJsonAtomic(path, obj, schema) / writeFileAtomic(path, bytes):
//   1. valida contra su esquema zod y serializa;
//   2. escribe <path>.tmp-<8 hex> con fsync;
//   3. rename sobre <path>, con hasta 5 reintentos (50 ms × 2) si da EPERM/EBUSY (antivirus);
//   4. en Linux, fsync del directorio (en Windows no se puede abrir un directorio para fsync).
// Si falla, se borra el temporal y se lanza IO (o DISK_FULL con ENOSPC); el destino no cambia.
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, type Dirent } from 'node:fs';
import { mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AppErrorException, type ErrorCode } from '@shared/errors';
import { AUTO_LOCK_MINUTES, ID_PATTERN, PRESENTATION_LIMITS } from '@shared/constants';
import { DEFAULT_PRESENTATION } from '@shared/presentation';
import { THEME_IDS } from '@shared/themes';
import type { GlobalSettings, Id, ProfilePrefs } from '@shared/types';
import { log } from '../log';

// ── Escritura atómica (§8.3) ───────────────────────────────────────────────────────────────────

export const TMP_SUFFIX_PATTERN = /\.tmp-[0-9a-f]{8}$/;
export const RENAME_RETRIES = 5;
export const RENAME_BACKOFF_MS = 50;

/** E/S inyectable (tests de reintentos y fallos). */
export interface AtomicIo {
  rename(from: string, to: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export const defaultAtomicIo: AtomicIo = {
  rename: (from, to) => rename(from, to),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function ioError(err: unknown): AppErrorException {
  if (err instanceof AppErrorException) return err;
  return new AppErrorException({ code: errnoOf(err) === 'ENOSPC' ? 'DISK_FULL' : 'IO' });
}

function codeOf(err: unknown): ErrorCode {
  return err instanceof AppErrorException ? err.error.code : 'IO';
}

async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** rename con reintentos EPERM/EBUSY (Windows reemplaza el destino; un antivirus puede bloquearlo). */
export async function renameWithRetry(
  from: string,
  to: string,
  io: AtomicIo = defaultAtomicIo,
): Promise<void> {
  let delay = RENAME_BACKOFF_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await io.rename(from, to);
      return;
    } catch (err) {
      const code = errnoOf(err);
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= RENAME_RETRIES) throw err;
      await io.sleep(delay);
      delay *= 2;
    }
  }
}

/** Escribe `data` en `path` de forma atómica (pasos 2–4). */
export async function writeFileAtomic(
  path: string,
  data: Uint8Array | string,
  io: AtomicIo = defaultAtomicIo,
): Promise<void> {
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await renameWithRetry(tmp, path, io);
    await fsyncDir(dirname(path));
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw ioError(err);
  }
}

/** Valida `value` con `schema` (paso 1) y lo escribe de forma atómica. Devuelve el valor validado. */
export async function writeJsonAtomic<T>(
  path: string,
  value: T,
  schema: z.ZodType<T>,
  io: AtomicIo = defaultAtomicIo,
): Promise<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new AppErrorException({ code: 'INTERNAL', details: { reason: 'json-schema' } });
  }
  await writeFileAtomic(path, `${JSON.stringify(parsed.data, null, 2)}\n`, io);
  return parsed.data;
}

export type JsonRead<T> = { kind: 'ok'; value: T } | { kind: 'missing' } | { kind: 'invalid' };

/** Lee y valida un JSON pequeño. Un error de E/S distinto de ENOENT cuenta como inválido. */
export function readJsonFile<T>(path: string, schema: z.ZodType<T>): JsonRead<T> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    return errnoOf(err) === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' };
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? { kind: 'ok', value: parsed.data } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * Al arrancar se borran los JSON temporales (`*.tmp-*`) que quedaran en GaleriaData (§8.8): la
 * raíz (profiles.json, settings.json), prefs/ y avatars/. Solo archivos regulares con el sufijo.
 */
export function cleanupTmpFiles(dataRoot: string): number {
  let removed = 0;
  for (const dir of [dataRoot, join(dataRoot, PREFS_DIR), join(dataRoot, 'avatars')]) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !TMP_SUFFIX_PATTERN.test(entry.name)) continue;
      try {
        rmSync(join(dir, entry.name));
        removed += 1;
      } catch {
        // se reintenta en el siguiente arranque
      }
    }
  }
  if (removed > 0) log.info('startup.tmp-cleanup', { count: removed });
  return removed;
}

// ── settings.json (§8.4) ───────────────────────────────────────────────────────────────────────

export const SETTINGS_FILE = 'settings.json';

const themeIdSchema = z.enum(THEME_IDS);
const colorSchemePrefSchema = z.enum(['system', 'light', 'dark']);

export const SETTINGS_SCHEMA = z.strictObject({
  formatVersion: z.literal(1),
  pickerThemeId: themeIdSchema,
  colorScheme: colorSchemePrefSchema,
  window: z
    .strictObject({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      maximized: z.boolean(),
    })
    .optional(),
});

export type SettingsFile = z.infer<typeof SETTINGS_SCHEMA>;

export const DEFAULT_SETTINGS: Readonly<SettingsFile> = Object.freeze({
  formatVersion: 1,
  pickerThemeId: 'fotos',
  colorScheme: 'system',
});

/**
 * settings.json con caché en memoria: hay un solo escritor (instancia única) y la ventana necesita
 * el tema global de forma síncrona cada vez que se crea (§15.4). Si el archivo es inválido se usan
 * los valores por defecto, se reescribe y se registra un `warn`.
 */
export class SettingsStore {
  readonly path: string;
  private current: SettingsFile = { ...DEFAULT_SETTINGS };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    dataRoot: string,
    private readonly io: AtomicIo = defaultAtomicIo,
  ) {
    this.path = join(dataRoot, SETTINGS_FILE);
  }

  async load(): Promise<GlobalSettings> {
    const read = readJsonFile(this.path, SETTINGS_SCHEMA);
    if (read.kind === 'ok') {
      this.current = read.value;
    } else {
      this.current = { ...DEFAULT_SETTINGS };
      if (read.kind === 'invalid') {
        log.warn('settings.rewritten', { stage: 'settings' });
        await this.persist(this.current).catch(() => undefined);
      }
    }
    return this.get();
  }

  get(): GlobalSettings {
    return { pickerThemeId: this.current.pickerThemeId, colorScheme: this.current.colorScheme };
  }

  /** Escribe solo los campos presentes; las escrituras se serializan. */
  set(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
    const run = this.queue.then(async () => {
      const next: SettingsFile = { ...this.current, ...definedOnly(patch) };
      await this.persist(next);
      this.current = next;
      return this.get();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persist(value: SettingsFile): Promise<void> {
    try {
      await writeJsonAtomic(this.path, value, SETTINGS_SCHEMA, this.io);
    } catch (err) {
      log.error('settings.write-failed', { stage: 'settings', code: codeOf(err) });
      throw err;
    }
  }
}

// ── prefs/<profileId>.json (§8.4) ──────────────────────────────────────────────────────────────

export const PREFS_DIR = 'prefs';

const transitionKind = z.enum(['fade', 'slide', 'zoom', 'kenburns']);

export const PRESENTATION_PLAIN_SCHEMA = z.strictObject({
  transition: z.union([transitionKind, z.literal('random'), z.literal('none')]),
  randomPool: z
    .array(transitionKind)
    .min(1)
    .refine((pool) => new Set(pool).size === pool.length, { message: 'duplicados' }),
  transitionMs: z
    .number()
    .int()
    .min(PRESENTATION_LIMITS.transitionMsMin)
    .max(PRESENTATION_LIMITS.transitionMsMax),
  slideMs: z
    .number()
    .int()
    .min(PRESENTATION_LIMITS.slideMsMin)
    .max(PRESENTATION_LIMITS.slideMsMax)
    .multipleOf(PRESENTATION_LIMITS.slideMsStep),
  loop: z.boolean(),
  // Con `default`, los ajustes guardados antes de este campo siguen siendo válidos.
  animations: z.boolean().default(true),
  startFullscreen: z.boolean(),
  audioMode: z.enum(['video', 'music', 'both', 'mute']),
  musicEnabled: z.boolean(),
  musicVolume: z.number().min(0).max(1),
  videoVolume: z.number().min(0).max(1),
  musicFadeMs: z
    .number()
    .int()
    .min(PRESENTATION_LIMITS.musicFadeMsMin)
    .max(PRESENTATION_LIMITS.musicFadeMsMax),
});

const autoLockSchema = z.literal([...AUTO_LOCK_MINUTES]);

/** Orden de la galería guardado en prefs: 'position' solo existe con un filtro de playlist. */
export const GALLERY_SORT_SCHEMA = z.strictObject({
  field: z.enum(['captured', 'imported', 'name', 'size', 'duration']),
  dir: z.enum(['asc', 'desc']),
});

/** Campos de ProfilePrefs (sin formatVersion); los usa también `prefs:set` (ipc/schemas.ts). */
export const PROFILE_PREFS_FIELDS = {
  themeId: themeIdSchema.nullable(),
  colorScheme: colorSchemePrefSchema.nullable(),
  autoLockMinutes: autoLockSchema,
  contentProtection: z.boolean(),
  gridSize: z.enum(['small', 'medium', 'large']),
  gallerySort: GALLERY_SORT_SCHEMA,
  presentationDefaults: PRESENTATION_PLAIN_SCHEMA,
};

export const PREFS_SCHEMA = z.strictObject({
  formatVersion: z.literal(1),
  ...PROFILE_PREFS_FIELDS,
});

export type PrefsFile = z.infer<typeof PREFS_SCHEMA>;

export const DEFAULT_PREFS: Readonly<ProfilePrefs> = Object.freeze<ProfilePrefs>({
  themeId: null,
  colorScheme: null,
  autoLockMinutes: 5,
  contentProtection: true,
  gridSize: 'medium',
  gallerySort: { field: 'captured', dir: 'desc' },
  // §8.4 / §17.2 (src/shared/presentation.ts); copia propia para que nadie comparta el array.
  presentationDefaults: {
    ...DEFAULT_PRESENTATION,
    randomPool: [...DEFAULT_PRESENTATION.randomPool],
  },
});

function clonePrefs(p: Readonly<ProfilePrefs>): ProfilePrefs {
  return structuredClone(p) as ProfilePrefs;
}

function definedOnly<T extends object>(patch: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function stripVersion(file: PrefsFile): ProfilePrefs {
  const prefs: Partial<PrefsFile> = { ...file };
  delete prefs.formatVersion;
  return prefs as ProfilePrefs;
}

/** prefs/<profileId>.json. null en themeId/colorScheme = heredar el global (§15.9). */
export class PrefsStore {
  readonly dir: string;
  private readonly queues = new Map<Id, Promise<unknown>>();

  constructor(
    dataRoot: string,
    private readonly io: AtomicIo = defaultAtomicIo,
  ) {
    this.dir = join(dataRoot, PREFS_DIR);
  }

  pathOf(profileId: Id): string {
    if (!ID_PATTERN.test(profileId)) throw new RangeError('profileId inválido');
    return join(this.dir, `${profileId}.json`);
  }

  /** Preferencias del perfil; si el archivo es inválido, valores por defecto, se reescribe y warn. */
  async get(profileId: Id): Promise<ProfilePrefs> {
    const read = readJsonFile(this.pathOf(profileId), PREFS_SCHEMA);
    if (read.kind === 'ok') return stripVersion(read.value);
    const defaults = clonePrefs(DEFAULT_PREFS);
    if (read.kind === 'invalid') {
      log.warn('settings.rewritten', { stage: 'prefs' });
      await this.serialize(profileId, () => this.persist(profileId, defaults)).catch(
        () => undefined,
      );
    }
    return defaults;
  }

  /** Mezcla `patch` con lo guardado y lo escribe de forma atómica. */
  set(profileId: Id, patch: Partial<ProfilePrefs>): Promise<ProfilePrefs> {
    return this.serialize(profileId, async () => {
      const read = readJsonFile(this.pathOf(profileId), PREFS_SCHEMA);
      const base = read.kind === 'ok' ? stripVersion(read.value) : clonePrefs(DEFAULT_PREFS);
      const next: ProfilePrefs = { ...base, ...definedOnly(patch) };
      await this.persist(profileId, next);
      return next;
    });
  }

  /** Borrar el perfil (§14.4, paso 4). */
  async remove(profileId: Id): Promise<void> {
    await this.serialize(profileId, () => rm(this.pathOf(profileId), { force: true }));
  }

  private serialize<T>(profileId: Id, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(profileId) ?? Promise.resolve();
    const run = previous.then(task);
    const settled = run.catch(() => undefined);
    this.queues.set(profileId, settled);
    void settled.then(() => {
      if (this.queues.get(profileId) === settled) this.queues.delete(profileId);
    });
    return run;
  }

  private async persist(profileId: Id, prefs: ProfilePrefs): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeJsonAtomic(
        this.pathOf(profileId),
        { formatVersion: 1, ...prefs } as PrefsFile,
        PREFS_SCHEMA,
        this.io,
      );
    } catch (err) {
      log.error('settings.write-failed', { stage: 'prefs', code: codeOf(err) });
      throw err;
    }
  }
}
