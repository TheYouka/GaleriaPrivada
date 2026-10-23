// Persistencia del tema desde Ajustes (docs/DESIGN.md §15.9), todo en claro:
//   - "toda la app": settings.json (pickerThemeId, colorScheme) y prefs.themeId/colorScheme = null;
//   - "solo mi perfil": prefs/<id>.json (themeId, colorScheme).
// El cambio visual es inmediato (applyTheme); si main rechaza el cambio, se vuelve al anterior.
import type { ThemeId } from '@shared/themes';
import type { AppError } from '@shared/errors';
import type { ColorSchemePref } from '@shared/types';
import { errorMessage } from '../../lib/errors-es';
import { invoke } from '../../lib/ipc';
import { toast } from '../../lib/toast';
import { useSessionStore } from '../../stores/session-store';
import { useThemeStore } from '../../stores/theme-store';
import { applyTheme } from '../../themes/apply-theme';

export type ApplyTo = 'profile' | 'app';

function snapshot() {
  const s = useThemeStore.getState();
  return { global: { ...s.global }, profileTheme: { ...s.profileTheme } };
}

function revert(previous: ReturnType<typeof snapshot>, error: AppError): void {
  applyTheme(() => {
    const store = useThemeStore.getState();
    store.setGlobal(previous.global);
    store.setProfileTheme(previous.profileTheme);
  });
  toast(errorMessage(error), 'error');
}

async function clearProfileTheme(): Promise<AppError | null> {
  const prefs = useSessionStore.getState().prefs;
  if (!prefs || (prefs.themeId === null && prefs.colorScheme === null)) return null;
  const res = await invoke('prefs:set', { themeId: null, colorScheme: null });
  if (!res.ok) return res.error;
  useSessionStore.getState().setPrefs(res.data);
  return null;
}

export async function selectTheme(themeId: ThemeId, applyTo: ApplyTo): Promise<void> {
  const previous = snapshot();
  if (applyTo === 'app') {
    applyTheme(() => useThemeStore.getState().setGlobal({ pickerThemeId: themeId }));
    const res = await invoke('settings:set', { pickerThemeId: themeId });
    if (!res.ok) return revert(previous, res.error);
    useThemeStore.getState().setGlobal(res.data);
    return;
  }
  applyTheme(() => useThemeStore.getState().setProfileTheme({ themeId }));
  const res = await invoke('prefs:set', { themeId });
  if (!res.ok) return revert(previous, res.error);
  useSessionStore.getState().setPrefs(res.data);
}

export async function selectScheme(colorScheme: ColorSchemePref, applyTo: ApplyTo): Promise<void> {
  const previous = snapshot();
  if (applyTo === 'app') {
    applyTheme(() => useThemeStore.getState().setGlobal({ colorScheme }));
    const res = await invoke('settings:set', { colorScheme });
    if (!res.ok) return revert(previous, res.error);
    useThemeStore.getState().setGlobal(res.data);
    return;
  }
  applyTheme(() => useThemeStore.getState().setProfileTheme({ colorScheme }));
  const res = await invoke('prefs:set', { colorScheme });
  if (!res.ok) return revert(previous, res.error);
  useSessionStore.getState().setPrefs(res.data);
}

/**
 * Cambia a quién se aplica el tema sin cambiar lo que se ve: el tema y el esquema efectivos pasan al
 * perfil, o al global (y el perfil vuelve a heredar).
 */
export async function changeApplyTo(
  applyTo: ApplyTo,
  current: { themeId: ThemeId; schemePref: ColorSchemePref },
): Promise<void> {
  if (applyTo === 'profile') {
    const res = await invoke('prefs:set', {
      themeId: current.themeId,
      colorScheme: current.schemePref,
    });
    if (!res.ok) return void toast(errorMessage(res.error), 'error');
    useSessionStore.getState().setPrefs(res.data);
    return;
  }
  const res = await invoke('settings:set', {
    pickerThemeId: current.themeId,
    colorScheme: current.schemePref,
  });
  if (!res.ok) return void toast(errorMessage(res.error), 'error');
  useThemeStore.getState().setGlobal(res.data);
  const err = await clearProfileTheme();
  if (err) toast(errorMessage(err), 'error');
}
