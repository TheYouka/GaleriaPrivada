// Tema efectivo (definición + esquema) a partir del store, para los componentes.
import { useMemo } from 'react';
import { useThemeStore } from '../stores/theme-store';
import { resolveTheme, type ResolvedTheme } from './registry';

export function currentTheme(): ResolvedTheme {
  const s = useThemeStore.getState();
  return resolveTheme({
    scope: s.scope,
    global: s.global,
    profileTheme: s.profileTheme,
    systemDark: s.systemDark,
  });
}

export function useTheme(): ResolvedTheme {
  const scope = useThemeStore((s) => s.scope);
  const pickerThemeId = useThemeStore((s) => s.global.pickerThemeId);
  const globalScheme = useThemeStore((s) => s.global.colorScheme);
  const profileThemeId = useThemeStore((s) => s.profileTheme.themeId);
  const profileScheme = useThemeStore((s) => s.profileTheme.colorScheme);
  const systemDark = useThemeStore((s) => s.systemDark);
  return useMemo(
    () =>
      resolveTheme({
        scope,
        global: { pickerThemeId, colorScheme: globalScheme },
        profileTheme: { themeId: profileThemeId, colorScheme: profileScheme },
        systemDark,
      }),
    [scope, pickerThemeId, globalScheme, profileThemeId, profileScheme, systemDark],
  );
}
