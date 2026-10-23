// Botón discreto de paleta del selector (§14.2): cambia el tema global (settings.json.pickerThemeId,
// §15.9) al momento. No revela nada de ninguna bóveda.
import { Palette } from 'lucide-react';
import { AVAILABLE_THEME_IDS, getThemeEntry, isThemeId } from '@shared/themes';
import { IconButton } from '../../components/IconButton';
import { Menu } from '../../components/Menu';
import { errorMessage } from '../../lib/errors-es';
import { invoke } from '../../lib/ipc';
import { toast } from '../../lib/toast';
import { useThemeStore } from '../../stores/theme-store';
import { applyTheme } from '../../themes/apply-theme';

const OPTIONS = AVAILABLE_THEME_IDS.map((id) => ({
  value: id,
  label: getThemeEntry(id).displayName,
}));

export function ThemeMenu({ className }: { className?: string }) {
  const pickerThemeId = useThemeStore((s) => s.global.pickerThemeId);

  const change = (value: string): void => {
    if (!isThemeId(value) || value === pickerThemeId) return;
    const previous = pickerThemeId;
    applyTheme(() => useThemeStore.getState().setGlobal({ pickerThemeId: value }));
    void invoke('settings:set', { pickerThemeId: value }).then((res) => {
      if (res.ok) {
        useThemeStore.getState().setGlobal(res.data);
        return;
      }
      applyTheme(() => useThemeStore.getState().setGlobal({ pickerThemeId: previous }));
      toast(errorMessage(res.error), 'error');
    });
  };

  return (
    <div className={className}>
      <Menu
        label="Tema"
        trigger={<IconButton label="Cambiar tema" icon={Palette} />}
        options={OPTIONS}
        value={pickerThemeId}
        onValueChange={change}
      />
    </div>
  );
}
