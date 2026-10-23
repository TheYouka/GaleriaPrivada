// Servicio de perfiles (docs/DESIGN.md §6.6, §14.4 y §21.1): listar, crear, editar, cambiar la
// contraseña y borrar, más la limpieza de arranque.
//
// Borrar exige SIEMPRE la contraseña (anexo §1, §22): lo primero que hace deleteProfile es
// desenvolver la MK; no existe ninguna otra ruta de código que borre o restablezca un perfil o su
// bóveda. La limpieza de arranque solo borra `vaults/<id>.creating` (que solo crea createProfile y
// nunca está en profiles.json) y solo registra las carpetas huérfanas (`vault.orphan-dir`).
//
// Las operaciones que leen y reescriben profiles.json se serializan. Todas ponen a cero las
// contraseñas, la KEK, la MK y las claves derivadas al terminar, también en las rutas de error.
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AppErrorException } from '@shared/errors';
import {
  BUILTIN_AVATAR_IDS,
  ID_PATTERN,
  MAX_PROFILES,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_BYTES,
  PROFILE_NAME_MAX,
  PROFILE_NAME_MIN,
} from '@shared/constants';
import type { AvatarInput, Id, ProfileSummary } from '@shared/types';
import {
  chooseKdfParams,
  deriveKek as defaultDeriveKek,
  newSalt,
  type KdfParams,
} from '../crypto/kdf';
import {
  deriveKeys,
  generateMasterKey,
  rewrapMasterKey,
  unwrapMasterKey,
  wrapMasterKey,
  type DerivedKeys,
} from '../crypto/keys';
import { zeroize } from '../crypto/secure-buffer';
import { closeDatabase, openDatabase } from '../db/database';
import { migrate } from '../db/migrate';
import { log } from '../log';
import type { PrefsStore } from '../settings/settings-store';
import { renameWithRetry, writeJsonAtomic } from '../settings/settings-store';
import {
  CREATING_SUFFIX,
  VAULTS_DIR,
  VAULT_JSON_SCHEMA,
  VAULT_SUBDIRS,
  creatingVaultDir,
  defaultVaultDir,
  removeVaultDir,
  vaultPaths,
} from '../vault/vault-layout';
import { removeAvatar, writeAvatar, type AvatarTokens } from './avatars';
import {
  encodeKdf,
  encodeMasterKeyWrap,
  foldName,
  kdfParamsOf,
  masterKeyWrapOf,
  saltOf,
  vaultDirOf,
  type ProfileStore,
  type ProfilesFile,
  type StoredProfile,
} from './profile-store';

/** profiles:list marca la bóveda como no disponible si vault.json no responde en este tiempo. */
export const VAULT_STATUS_TIMEOUT_MS = 1500;

/** Lo que el servicio necesita de la sesión (borrar un perfil desbloqueado lo bloquea antes). */
export interface ProfileSessionView {
  readonly currentProfileId: Id | null;
  lock(reason: 'manual'): Promise<void>;
}

export interface ProfileServiceDeps {
  dataRoot: string;
  store: ProfileStore;
  prefs: PrefsStore;
  tokens: AvatarTokens;
  session: ProfileSessionView;
  /** Parámetros rápidos de test solo sin empaquetar y con GALERIA_TEST_FAST_KDF=1 (kdf.ts). */
  isPackaged: boolean;
  chooseKdfParams?: () => Promise<KdfParams>;
  deriveKek?: typeof defaultDeriveKek;
  now?: () => Date;
  /**
   * Solo tests: se llama antes de los pasos 2–7 de createProfile (inyección de fallos y caídas
   * simuladas, §14.4). En producción no se pasa.
   */
  beforeCreateStep?: (step: 2 | 3 | 4 | 5 | 6 | 7) => void | Promise<void>;
}

export interface CreateProfileRequest {
  name: string;
  avatar: AvatarInput;
  password: Uint8Array;
  acknowledgeNoRecovery: true;
}

export interface UpdateProfileRequest {
  profileId: Id;
  password: Uint8Array;
  name?: string;
  avatar?: AvatarInput;
}

export interface ChangePasswordRequest {
  profileId: Id;
  currentPassword: Uint8Array;
  newPassword: Uint8Array;
}

export interface DeleteProfileRequest {
  profileId: Id;
  password: Uint8Array;
  confirmName: string;
}

const validation = (reason: string): AppErrorException =>
  new AppErrorException({ code: 'VALIDATION', details: { reason } });

/** NFC + trim; 1–40 code points sin \p{Cc} (§10.3). Si no, VALIDATION. */
export function normalizeProfileName(name: string): string {
  const n = name.normalize('NFC').trim();
  const len = [...n].length;
  if (len < PROFILE_NAME_MIN || len > PROFILE_NAME_MAX || /\p{Cc}/u.test(n)) {
    throw validation('name');
  }
  return n;
}

function checkPassword(password: Uint8Array): void {
  if (
    !(password instanceof Uint8Array) ||
    password.length < PASSWORD_MIN_BYTES ||
    password.length > PASSWORD_MAX_BYTES
  ) {
    throw validation('password');
  }
}

function checkAvatarInput(avatar: AvatarInput): void {
  if (avatar.type === 'builtin') {
    if (!(BUILTIN_AVATAR_IDS as readonly string[]).includes(avatar.id)) throw validation('avatar');
  } else if (avatar.type !== 'custom') {
    throw validation('avatar');
  }
}

/** Lo que ve el renderer de un perfil: nunca la KDF, la sal ni la envoltura. */
export function toSummary(
  profile: StoredProfile,
  vaultStatus: ProfileSummary['vaultStatus'],
  themeId: ProfileSummary['themeId'],
): ProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    avatar: { ...profile.avatar },
    vaultStatus,
    themeId,
  };
}

function zeroKeys(keys: DerivedKeys | null): void {
  if (keys) zeroize(keys.kDb, keys.kWrap, keys.kDedup);
}

/** Errores que no son AppError: ENOSPC → DISK_FULL; el resto → IO (nunca err.message). */
function asAppError(err: unknown): AppErrorException {
  if (err instanceof AppErrorException) return err;
  const code = (err as { code?: unknown } | null)?.code;
  return new AppErrorException({ code: code === 'ENOSPC' ? 'DISK_FULL' : 'IO' });
}

export class ProfileService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly derive: typeof defaultDeriveKek;
  private readonly now: () => Date;

  constructor(private readonly deps: ProfileServiceDeps) {
    this.derive = deps.deriveKek ?? defaultDeriveKek;
    this.now = deps.now ?? (() => new Date());
  }

  private get dataRoot(): string {
    return this.deps.dataRoot;
  }

  /** Serializa las operaciones que leen y reescriben profiles.json. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private chooseParams(): Promise<KdfParams> {
    return this.deps.chooseKdfParams
      ? this.deps.chooseKdfParams()
      : chooseKdfParams({ isPackaged: this.deps.isPackaged });
  }

  // ── Lectura ──────────────────────────────────────────────────────────────────────────────────

  /** `ok` si vault.json responde en 1,5 s; si no, `unavailable` (disco no conectado, §8.7). */
  async vaultStatus(profile: StoredProfile): Promise<ProfileSummary['vaultStatus']> {
    const file = vaultPaths(vaultDirOf(this.dataRoot, profile)).vaultJson;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const status = await Promise.race([
      stat(file).then(
        () => 'ok' as const,
        () => 'unavailable' as const,
      ),
      new Promise<'unavailable'>((resolve) => {
        timer = setTimeout(() => resolve('unavailable'), VAULT_STATUS_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return status;
  }

  async summarize(
    profile: StoredProfile,
    vaultStatus?: ProfileSummary['vaultStatus'],
  ): Promise<ProfileSummary> {
    const [status, prefs] = await Promise.all([
      vaultStatus ?? this.vaultStatus(profile),
      this.deps.prefs.get(profile.id),
    ]);
    return toSummary(profile, status, prefs.themeId);
  }

  /** profiles:list. Con profiles.json y su .bak dañados, VAULT_CORRUPT. */
  async list(): Promise<ProfileSummary[]> {
    const file = await this.deps.store.read();
    return Promise.all(file.profiles.map((p) => this.summarize(p)));
  }

  private async requireProfile(
    profileId: Id,
  ): Promise<{ file: ProfilesFile; profile: StoredProfile }> {
    const file = await this.deps.store.read();
    const profile = file.profiles.find((p) => p.id === profileId);
    if (!profile) {
      log.warn('profile.not-found');
      throw new AppErrorException({ code: 'PROFILE_NOT_FOUND' });
    }
    return { file, profile };
  }

  /** Perfil y carpeta de su bóveda para el desbloqueo (SessionManager, §13.1 paso 1). */
  async unlockTarget(profileId: Id): Promise<{ profile: StoredProfile; vaultDir: string }> {
    const { profile } = await this.requireProfile(profileId);
    return { profile, vaultDir: vaultDirOf(this.dataRoot, profile) };
  }

  /** Comprueba la contraseña desenvolviendo la MK (§6.5) y la pone a cero. */
  private async verifyPassword(profile: StoredProfile, password: Uint8Array): Promise<void> {
    checkPassword(password);
    let kek: Buffer | null = null;
    let mk: Buffer | null = null;
    try {
      const params = kdfParamsOf(profile);
      const salt = saltOf(profile);
      kek = await this.derive(password, salt, params);
      mk = unwrapMasterKey(masterKeyWrapOf(profile), kek, profile.id, params, salt);
    } catch (err) {
      if (err instanceof AppErrorException && err.error.code === 'WRONG_PASSWORD') {
        log.info('profile.wrong-password');
      }
      throw err;
    } finally {
      zeroize(kek, mk);
    }
  }

  private nameTaken(file: ProfilesFile, name: string, exceptId?: Id): boolean {
    const folded = foldName(name);
    return file.profiles.some((p) => p.id !== exceptId && foldName(p.name) === folded);
  }

  // ── Crear (§14.4) ────────────────────────────────────────────────────────────────────────────

  createProfile(req: CreateProfileRequest): Promise<ProfileSummary> {
    return this.exclusive(() => this.runCreate(req));
  }

  private async runCreate(req: CreateProfileRequest): Promise<ProfileSummary> {
    const step = async (n: 2 | 3 | 4 | 5 | 6 | 7): Promise<void> => {
      await this.deps.beforeCreateStep?.(n);
    };
    const { password } = req;
    let kek: Buffer | null = null;
    let mk: Buffer | null = null;
    let keys: DerivedKeys | null = null;
    let id: Id | null = null;
    let creatingDir: string | null = null;
    let finalDir: string | null = null;
    let avatarWritten = false;
    let committed = false;
    try {
      // 1. Validar: nombre único, ≤ 10 perfiles, contraseña, aviso y token del avatar.
      if (req.acknowledgeNoRecovery !== true) throw validation('acknowledge');
      checkPassword(password);
      checkAvatarInput(req.avatar);
      const name = normalizeProfileName(req.name);
      const file = await this.deps.store.read();
      if (file.profiles.length >= MAX_PROFILES) {
        throw new AppErrorException({ code: 'PROFILE_LIMIT' });
      }
      if (this.nameTaken(file, name)) throw new AppErrorException({ code: 'PROFILE_NAME_TAKEN' });
      const avatarWebp =
        req.avatar.type === 'custom' ? this.deps.tokens.peek(req.avatar.token) : null;
      if (req.avatar.type === 'custom' && !avatarWebp) throw validation('avatar-token');

      // 2. id, calibración, sal, KEK, MK aleatoria y envoltura.
      await step(2);
      const profileId = randomBytes(16).toString('hex');
      id = profileId;
      const params = await this.chooseParams();
      const salt = newSalt();
      kek = await this.derive(password, salt, params);
      mk = generateMasterKey();
      const wrap = wrapMasterKey(mk, kek, profileId, params, salt);
      zeroize(kek);
      kek = null;

      // 3. vaults/<id>.creating con vault.json (lo primero) y las subcarpetas.
      await step(3);
      await mkdir(join(this.dataRoot, VAULTS_DIR), { recursive: true });
      const creating = creatingVaultDir(this.dataRoot, profileId);
      await mkdir(creating); // falla si ya existe
      creatingDir = creating;
      const createdAt = this.now().toISOString();
      await writeJsonAtomic(
        vaultPaths(creating).vaultJson,
        { formatVersion: 1 as const, profileId, createdAt },
        VAULT_JSON_SCHEMA,
      );
      for (const sub of VAULT_SUBDIRS) await mkdir(join(creating, sub));

      // 4. HKDF → K_db; crear library.db, migrar y cerrar.
      await step(4);
      keys = deriveKeys(mk, profileId);
      const dbPath = vaultPaths(creating).db;
      const db = openDatabase(dbPath, keys.kDb, { creating: true });
      try {
        migrate(db, dbPath);
      } finally {
        closeDatabase(db);
      }
      zeroKeys(keys);
      keys = null;
      zeroize(mk);
      mk = null;

      // 5. Avatar personalizado (ya procesado: 256×256, sin metadatos).
      await step(5);
      if (avatarWebp) {
        avatarWritten = true;
        await writeAvatar(this.dataRoot, profileId, avatarWebp);
      }

      // 6. vaults/<id>.creating → vaults/<id>.
      await step(6);
      const target = defaultVaultDir(this.dataRoot, profileId);
      await renameWithRetry(creating, target);
      creatingDir = null;
      finalDir = target;

      // 7. Punto de confirmación: profiles.json y su .bak.
      await step(7);
      const profile: StoredProfile = {
        id: profileId,
        name,
        avatar:
          req.avatar.type === 'builtin'
            ? { type: 'builtin', id: req.avatar.id }
            : { type: 'custom', rev: 1 },
        createdAt,
        vault: { location: 'default' },
        kdf: encodeKdf(params, salt),
        masterKeyWrap: encodeMasterKeyWrap(wrap),
      };
      await this.deps.store.write({ formatVersion: 1, profiles: [...file.profiles, profile] });
      committed = true;
      if (req.avatar.type === 'custom') this.deps.tokens.take(req.avatar.token);
      log.info('profile.created');
      // 8. El perfil queda bloqueado: crear no lo desbloquea.
      return await this.summarize(profile, 'ok');
    } catch (err) {
      // Fallo antes del punto de confirmación: no queda carpeta ni avatar y profiles.json no
      // cambia (la escritura atómica de profiles.json deja el archivo como estaba). Después del
      // punto de confirmación nunca se deshace nada.
      if (id && !committed) {
        if (finalDir) await removeVaultDir(finalDir, id, 'vault');
        else if (creatingDir) await removeVaultDir(creatingDir, id, 'creating');
        if (avatarWritten) await removeAvatar(this.dataRoot, id).catch(() => undefined);
      }
      const mapped = asAppError(err);
      log.error('profile.create-failed', { code: mapped.error.code });
      throw mapped;
    } finally {
      // 8. Claves y contraseña a cero, también en las rutas de error.
      zeroize(kek, mk, password);
      zeroKeys(keys);
    }
  }

  // ── Editar (D14: exige la contraseña) ────────────────────────────────────────────────────────

  updateProfile(req: UpdateProfileRequest): Promise<ProfileSummary> {
    return this.exclusive(async () => {
      try {
        const { file, profile } = await this.requireProfile(req.profileId);
        await this.verifyPassword(profile, req.password);
        let name = profile.name;
        if (req.name !== undefined) {
          name = normalizeProfileName(req.name);
          if (this.nameTaken(file, name, profile.id)) {
            throw new AppErrorException({ code: 'PROFILE_NAME_TAKEN' });
          }
        }
        let avatar: StoredProfile['avatar'] = profile.avatar;
        let webp: Buffer | null = null;
        if (req.avatar) {
          checkAvatarInput(req.avatar);
          if (req.avatar.type === 'builtin') {
            avatar = { type: 'builtin', id: req.avatar.id };
          } else {
            webp = this.deps.tokens.peek(req.avatar.token);
            if (!webp) throw validation('avatar-token');
            const rev = profile.avatar.type === 'custom' ? profile.avatar.rev + 1 : 1;
            avatar = { type: 'custom', rev };
          }
        }
        if (webp) await writeAvatar(this.dataRoot, profile.id, webp);
        const updated: StoredProfile = { ...profile, name, avatar };
        await this.deps.store.write({
          ...file,
          profiles: file.profiles.map((p) => (p.id === profile.id ? updated : p)),
        });
        if (req.avatar?.type === 'custom') this.deps.tokens.take(req.avatar.token);
        if (avatar.type === 'builtin' && profile.avatar.type === 'custom') {
          await removeAvatar(this.dataRoot, profile.id).catch(() => undefined);
        }
        log.info('profile.updated');
        return await this.summarize(updated);
      } catch (err) {
        throw asAppError(err);
      } finally {
        zeroize(req.password);
      }
    });
  }

  // ── Cambiar la contraseña (§6.6: solo se vuelve a envolver la MK) ────────────────────────────

  changePassword(req: ChangePasswordRequest): Promise<void> {
    return this.exclusive(async () => {
      let kek: Buffer | null = null;
      let nextKek: Buffer | null = null;
      try {
        checkPassword(req.currentPassword);
        checkPassword(req.newPassword);
        const { file, profile } = await this.requireProfile(req.profileId);
        // 1. Desenvolver la MK con la contraseña actual (WRONG_PASSWORD).
        const params = kdfParamsOf(profile);
        const salt = saltOf(profile);
        kek = await this.derive(req.currentPassword, salt, params);
        try {
          zeroize(unwrapMasterKey(masterKeyWrapOf(profile), kek, profile.id, params, salt));
        } catch (err) {
          log.info('profile.wrong-password');
          throw err;
        }
        // 2. Calibrar, sal nueva y KEK'.
        const nextParams = await this.chooseParams();
        const nextSalt = newSalt();
        nextKek = await this.derive(req.newPassword, nextSalt, nextParams);
        // 3. Envolver la MK con KEK' y un nonce nuevo (la MK intermedia se pone a cero).
        const wrap = rewrapMasterKey(
          profile.id,
          { wrap: masterKeyWrapOf(profile), kek, params, salt },
          { kek: nextKek, params: nextParams, salt: nextSalt },
        );
        // 4. profiles.json y su .bak con la envoltura nueva: la DB y los objetos no se tocan.
        const updated: StoredProfile = {
          ...profile,
          kdf: encodeKdf(nextParams, nextSalt),
          masterKeyWrap: encodeMasterKeyWrap(wrap),
        };
        await this.deps.store.write({
          ...file,
          profiles: file.profiles.map((p) => (p.id === profile.id ? updated : p)),
        });
        log.info('profile.password-changed');
      } catch (err) {
        throw asAppError(err);
      } finally {
        // 5. KEK, KEK' y las dos contraseñas a cero.
        zeroize(kek, nextKek, req.currentPassword, req.newPassword);
      }
    });
  }

  // ── Borrar (§14.4: siempre con la contraseña) ────────────────────────────────────────────────

  deleteProfile(req: DeleteProfileRequest): Promise<{ leftoverPath: string | null }> {
    return this.exclusive(async () => {
      try {
        const { file, profile } = await this.requireProfile(req.profileId);
        // 1. Desenvolver la MK con la contraseña (WRONG_PASSWORD). No se toca nada antes.
        await this.verifyPassword(profile, req.password);
        let confirm: string;
        try {
          confirm = normalizeProfileName(req.confirmName);
        } catch {
          throw validation('confirm-name');
        }
        if (foldName(confirm) !== foldName(profile.name)) throw validation('confirm-name');

        // 2. Si el perfil estuviera desbloqueado (o desbloqueándose), bloquearlo.
        if (this.deps.session.currentProfileId === profile.id) {
          await this.deps.session.lock('manual');
        }

        // 3. Quitar la entrada: desde aquí la bóveda es criptográficamente inaccesible.
        await this.deps.store.write({
          ...file,
          profiles: file.profiles.filter((p) => p.id !== profile.id),
        });

        // 4. prefs/<id>.json y avatars/<id>.webp.
        await this.deps.prefs.remove(profile.id).catch(() => undefined);
        await removeAvatar(this.dataRoot, profile.id).catch(() => undefined);

        // 5. La bóveda, solo con removeVaultDir (y pendingCleanup si existía).
        const removed = await removeVaultDir(vaultDirOf(this.dataRoot, profile), profile.id);
        let leftoverPath = removed.leftoverPath;
        if (profile.vault.pendingCleanup) {
          const old = await removeVaultDir(profile.vault.pendingCleanup, profile.id);
          leftoverPath ??= old.leftoverPath;
        }
        if (leftoverPath) log.warn('profile.delete-leftover');
        log.info('profile.deleted');
        return { leftoverPath };
      } catch (err) {
        throw asAppError(err);
      } finally {
        zeroize(req.password);
      }
    });
  }

  // ── Arranque (§14.4) ─────────────────────────────────────────────────────────────────────────

  /**
   * Antes de mostrar el selector: borra los `vaults/<id>.creating` (solo los crea createProfile y
   * nunca están en profiles.json) con removeVaultDir(…, 'creating') y registra un `warn`
   * `vault.orphan-dir` (sin la ruta) por cada `vaults/<id>` sin perfil, que nunca se borra.
   */
  async startupCleanup(): Promise<void> {
    const vaultsDir = join(this.dataRoot, VAULTS_DIR);
    let names: string[];
    try {
      names = await readdir(vaultsDir);
    } catch {
      return; // primer arranque
    }
    let known: Set<Id> | null = null;
    try {
      known = new Set((await this.deps.store.read()).profiles.map((p) => p.id));
    } catch {
      known = null; // profiles.json dañado: no se sabe qué carpetas son huérfanas
    }
    for (const name of names) {
      const dir = join(vaultsDir, name);
      const creating = name.endsWith(CREATING_SUFFIX)
        ? name.slice(0, -CREATING_SUFFIX.length)
        : null;
      if (creating !== null && ID_PATTERN.test(creating)) {
        if (known?.has(creating)) {
          log.warn('vault.orphan-dir', { stage: 'creating-with-profile' });
          continue;
        }
        const result = await removeVaultDir(dir, creating, 'creating');
        if (result.removed) log.info('vault.creating-removed');
        continue;
      }
      if (known && ID_PATTERN.test(name) && !known.has(name)) {
        const st = await lstat(dir).catch(() => null);
        if (st?.isDirectory()) log.warn('vault.orphan-dir');
      }
    }
  }
}
