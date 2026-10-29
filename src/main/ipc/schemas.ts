// Esquemas zod del IPC [H3-2] con las reglas de docs/DESIGN.md §10.3. Es el único sitio con esquemas
// del IPC: el preload y src/shared no importan zod. El tipo obliga a declarar un esquema por cada
// canal de INVOKE_CHANNELS. Todos los objetos son estrictos (sin claves extra).
//
// Cadenas: text(min, max) normaliza a NFC, recorta y cuenta code points. Las rutas son la excepción
// [H3-3]: rawPath() NO normaliza ni recorta (una ruta con NFD o con un espacio final es otro archivo,
// y se borra el original importado: normalizarla podría borrar otro archivo). La usa import:paths.
// SCHEMAS cubre también los canales privados del preload (PRIVATE_INVOKE_CHANNELS).
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  AUTO_LOCK_MINUTES,
  AVATAR_TOKEN_PATTERN,
  BUILTIN_AVATAR_IDS,
  CROP_MIN_SIZE,
  CROP_TOLERANCE,
  DATE_MAX_MS,
  EDIT_OPS_MAX,
  ID_PATTERN,
  IDS_MAX,
  IMPORT_PATHS_MAX,
  MEDIA_NAME_MAX,
  MERGE_NAME_MAX,
  MUSIC_TITLE_MAX,
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_BYTES,
  PATH_MAX_UTF16,
  PLAYLIST_MAX_ITEMS,
  PLAYLIST_NAME_MAX,
  PRESENTATION_LIMITS,
  PROFILE_NAME_MAX,
  PROFILE_NAME_MIN,
  SEARCH_MAX,
} from '@shared/constants';
import type { AnyInvokeChannel, ReqOf } from '@shared/ipc-contract';
import { AVAILABLE_THEME_IDS, THEME_IDS, type ThemeId } from '@shared/themes';
import type {
  AvatarInput,
  EditOp,
  MediaQuery,
  MergeRequest,
  PresentationSettings,
} from '@shared/types';
import { GALLERY_SORT_SCHEMA, PRESENTATION_PLAIN_SCHEMA } from '../settings/settings-store';

// ── Ayudantes ──────────────────────────────────────────────────────────────────────────────────

const CONTROL = /\p{Cc}/u;

/** NFC + trim; entre `min` y `max` code points y sin caracteres de control (\p{Cc}). */
export function text(min: number, max: number) {
  return z
    .string()
    .transform((s) => s.normalize('NFC').trim())
    .refine(
      (s) => {
        const n = [...s].length;
        return n >= min && n <= max;
      },
      { message: 'length' },
    )
    .refine((s) => !CONTROL.test(s), { message: 'control' });
}

/**
 * [H3-3] Ruta tal cual la envió el usuario: sin normalizar ni recortar. No vacía, ≤ 32 767 unidades
 * UTF-16, absoluta (path.isAbsolute de la plataforma) y sin NUL.
 */
export function rawPath() {
  return z
    .string()
    .min(1)
    .max(PATH_MAX_UTF16)
    .refine((p) => !p.includes('\0'), { message: 'nul' })
    .refine((p) => isAbsolute(p), { message: 'absolute' });
}

export const idSchema = z.string().regex(ID_PATTERN);

/** Contraseña: bytes UTF-8 de NFC(texto), 8–1024 bytes (la UI exige además ≥ 8 code points). */
export const passwordSchema = z
  .instanceof(Uint8Array)
  .refine((b) => b.length >= PASSWORD_MIN_BYTES && b.length <= PASSWORD_MAX_BYTES, {
    message: 'length',
  });

export const profileNameSchema = text(PROFILE_NAME_MIN, PROFILE_NAME_MAX);

export const avatarInputSchema: z.ZodType<AvatarInput> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('builtin'), id: z.enum(BUILTIN_AVATAR_IDS) }),
  z.strictObject({ type: z.literal('custom'), token: z.string().regex(AVATAR_TOKEN_PATTERN) }),
]);

/** Solo los temas implementados en esta versión (F1: `fotos` y `ps3`). */
export const themeIdSchema: z.ZodType<ThemeId> = z
  .enum(THEME_IDS)
  .refine((id) => AVAILABLE_THEME_IDS.includes(id), { message: 'unavailable' });

const colorSchemePref = z.enum(['system', 'light', 'dark']);

/** ids de media:delete (y playlists:addItems/removeItems en F4): 1–100 000, sin duplicados. */
export const idListSchema = z
  .array(idSchema)
  .min(1)
  .max(IDS_MAX)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'duplicates' });

const dateMs = z.number().int().min(0).max(DATE_MAX_MS);

/** MediaQuery (§10.3): search ≤ 200; dateFrom ≤ dateTo; 'position' solo con playlistId. */
export const mediaQuerySchema: z.ZodType<MediaQuery> = z
  .strictObject({
    kind: z.enum(['all', 'photo', 'video']),
    search: text(0, SEARCH_MAX).optional(),
    dateFrom: dateMs.optional(),
    dateTo: dateMs.optional(),
    playlistId: idSchema.optional(),
    sort: z.strictObject({
      field: z.enum(['captured', 'imported', 'name', 'size', 'duration', 'position']),
      dir: z.enum(['asc', 'desc']),
    }),
  })
  .refine((q) => q.dateFrom === undefined || q.dateTo === undefined || q.dateFrom <= q.dateTo, {
    message: 'date-range',
    path: ['dateTo'],
  })
  .refine((q) => q.sort.field !== 'position' || q.playlistId !== undefined, {
    message: 'position-needs-playlist',
    path: ['sort', 'field'],
  });

/** playlists:reorder (§10.3): permutación de los elementos actuales, ≤ 2000 y sin duplicados. */
export const reorderIdsSchema = z
  .array(idSchema)
  .max(PLAYLIST_MAX_ITEMS)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'duplicates' });

/**
 * PresentationSettings (§10.3): los campos en claro de prefs (PRESENTATION_PLAIN_SCHEMA: slideMs en
 * pasos de 500, volúmenes en [0, 1], randomPool sin duplicados…) y `trackIds` ≤ 100 sin duplicados.
 * Que las pistas existan (NOT_FOUND) lo comprueba el handler en la DB.
 */
export const presentationSettingsSchema: z.ZodType<PresentationSettings> = z.strictObject({
  ...PRESENTATION_PLAIN_SCHEMA.shape,
  trackIds: z
    .array(idSchema)
    .max(PRESENTATION_LIMITS.trackIdsMax)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'duplicates' }),
});

/** Valor normalizado de un recorte: número finito en [0, 1] (zod 4 rechaza NaN e ±Infinity). */
const unitSchema = z.number().min(0).max(1);

/**
 * Una operación de edición (§10.3, §16.3): `crop` con w, h ≥ 0,01, x + w ≤ 1 e y + h ≤ 1
 * (tolerancia 1e-9). Objetos estrictos.
 */
export const editOpSchema: z.ZodType<EditOp> = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('rotate'), q: z.literal([1, 2, 3]) }),
  z.strictObject({ t: z.literal('flipH') }),
  z.strictObject({ t: z.literal('flipV') }),
  z
    .strictObject({
      t: z.literal('crop'),
      x: unitSchema,
      y: unitSchema,
      w: unitSchema.min(CROP_MIN_SIZE),
      h: unitSchema.min(CROP_MIN_SIZE),
    })
    .refine((c) => c.x + c.w <= 1 + CROP_TOLERANCE, { message: 'crop-x', path: ['w'] })
    .refine((c) => c.y + c.h <= 1 + CROP_TOLERANCE, { message: 'crop-y', path: ['h'] }),
]);

/** MergeRequest (§10.3): dos ids distintos, opciones cerradas y nombre de 1–255 code points. */
export const mergeRequestSchema: z.ZodType<MergeRequest> = z
  .strictObject({
    leftId: idSchema,
    rightId: idSchema,
    audio: z.enum(['left', 'right', 'mix', 'none']),
    duration: z.enum(['shortest', 'longest']),
    name: text(1, MERGE_NAME_MAX),
  })
  .refine((r) => r.leftId !== r.rightId, { message: 'same-video', path: ['rightId'] });

// ── Canales ────────────────────────────────────────────────────────────────────────────────────

export const SCHEMAS: { [C in AnyInvokeChannel]: z.ZodType<ReqOf<C>> } = {
  'app:getInfo': z.undefined(),

  'window:minimize': z.undefined(),
  'window:toggleMaximize': z.undefined(),
  'window:close': z.undefined(),
  'window:setFullScreen': z.strictObject({ on: z.boolean() }),
  'window:getState': z.undefined(),

  'settings:get': z.undefined(),
  'settings:set': z.strictObject({
    pickerThemeId: themeIdSchema.optional(),
    colorScheme: colorSchemePref.optional(),
  }),

  'profiles:list': z.undefined(),
  'profiles:pickAvatarPhoto': z.undefined(),
  'profiles:create': z.strictObject({
    name: profileNameSchema,
    avatar: avatarInputSchema,
    password: passwordSchema,
    acknowledgeNoRecovery: z.literal(true),
  }),
  'profiles:update': z.strictObject({
    profileId: idSchema,
    password: passwordSchema,
    name: profileNameSchema.optional(),
    avatar: avatarInputSchema.optional(),
  }),
  'profiles:changePassword': z.strictObject({
    profileId: idSchema,
    currentPassword: passwordSchema,
    newPassword: passwordSchema,
  }),
  // confirmName se compara por pliegue de mayúsculas y diacríticos en profile-service.
  'profiles:delete': z.strictObject({
    profileId: idSchema,
    password: passwordSchema,
    confirmName: profileNameSchema,
  }),

  'session:unlock': z.strictObject({ profileId: idSchema, password: passwordSchema }),
  'session:lock': z.undefined(),
  'session:getState': z.undefined(),
  'session:activity': z.undefined(),
  'session:setPlayback': z.strictObject({ active: z.boolean() }),

  'prefs:get': z.undefined(),
  'prefs:set': z.strictObject({
    themeId: themeIdSchema.nullable().optional(),
    colorScheme: colorSchemePref.nullable().optional(),
    autoLockMinutes: z.literal([...AUTO_LOCK_MINUTES]).optional(),
    contentProtection: z.boolean().optional(),
    gridSize: z.enum(['small', 'medium', 'large']).optional(),
    gallerySort: GALLERY_SORT_SCHEMA.optional(),
    presentationDefaults: PRESENTATION_PLAIN_SCHEMA.optional(),
  }),

  'media:list': mediaQuerySchema,
  'media:get': z.strictObject({ id: idSchema }),
  'media:rename': z.strictObject({ id: idSchema, name: text(1, MEDIA_NAME_MAX) }),
  'media:delete': z.strictObject({ ids: idListSchema }),

  'import:chooseFiles': z.undefined(),
  'import:chooseFolder': z.undefined(),
  // [H3-3] Cada ruta tal cual llegó de webUtils.getPathForFile: sin NFC ni trim.
  'import:paths': z.strictObject({
    paths: z.array(rawPath()).min(1).max(IMPORT_PATHS_MAX),
  }),
  'import:confirm': z.strictObject({ jobId: idSchema, convert: z.boolean() }),
  'import:cancel': z.strictObject({ jobId: idSchema }),

  'vault:getInfo': z.undefined(),
  // [H3-8] Sin rutas: el destino sale del diálogo de main o es la ubicación predeterminada.
  'vault:relocate': z.strictObject({ target: z.enum(['choose', 'default']) }),
  'vault:relocateCancel': z.strictObject({ jobId: idSchema }),
  'vault:locate': z.strictObject({ profileId: idSchema }),

  // ≤ 64 operaciones ([] = revertir); el editor colapsa antes a la forma canónica (§16.4).
  'edits:save': z.strictObject({
    mediaId: idSchema,
    ops: z.array(editOpSchema).max(EDIT_OPS_MAX),
  }),

  'playlists:list': z.undefined(),
  'playlists:create': z.strictObject({ name: text(1, PLAYLIST_NAME_MAX) }),
  'playlists:rename': z.strictObject({ id: idSchema, name: text(1, PLAYLIST_NAME_MAX) }),
  'playlists:delete': z.strictObject({ id: idSchema }),
  // [H3-4] Hasta 100 000 ids: el repo los pasa en un único parámetro JSON (json_each(?)).
  'playlists:addItems': z.strictObject({ id: idSchema, mediaIds: idListSchema }),
  'playlists:removeItems': z.strictObject({ id: idSchema, mediaIds: idListSchema }),
  // La permutación exacta la comprueba el repo contra los elementos actuales.
  'playlists:reorder': z.strictObject({ id: idSchema, mediaIds: reorderIdsSchema }),
  'playlists:setPresentation': z.strictObject({
    id: idSchema,
    settings: presentationSettingsSchema.nullable(),
  }),

  'music:import': z.undefined(),
  'music:list': z.undefined(),
  'music:rename': z.strictObject({ id: idSchema, title: text(1, MUSIC_TITLE_MAX) }),
  'music:delete': z.strictObject({ id: idSchema }),

  'presentation:getConfig': z.strictObject({ playlistId: idSchema.optional() }),
  'presentation:saveDefaults': z.strictObject({ settings: presentationSettingsSchema }),

  // §10.3: leftId ≠ rightId; que los dos sean vídeos `ready` lo comprueba merge-service en la DB.
  'merge:start': mergeRequestSchema,
  'merge:cancel': z.strictObject({ jobId: idSchema }),
};
