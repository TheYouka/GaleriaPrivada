// Selector de temas (docs/DESIGN.md §15.8): RadioGroup de tarjetas con su ThemePreview; elegir una
// aplica el tema al momento y las flechas mueven la selección. Muestra los 5 temas (Clásico, Mosaico,
// Ondas, Cristal y Cine; 6.4), cada uno con la maqueta de su shell. Cada tarjeta tiene un id estable para
// devolverle el foco si el cambio de tema cambia el shell.
import { Check } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { isThemeId, type ColorScheme, type ThemeId } from '@shared/themes';
import { THEMES } from '../../themes/registry';
import { ThemePreview } from './ThemePreview';

function themeOptionId(id: ThemeId): string {
  return `theme-option-${id}`;
}

export interface ThemePickerProps {
  value: ThemeId;
  scheme: ColorScheme;
  onChange(id: ThemeId): void;
  labelledBy: string;
}

export function ThemePicker({ value, scheme, onChange, labelledBy }: ThemePickerProps) {
  return (
    <RadioGroup.Root
      aria-labelledby={labelledBy}
      value={value}
      onValueChange={(v) => {
        if (isThemeId(v)) onChange(v);
      }}
      className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-4"
    >
      {THEMES.map((t) => (
        <RadioGroup.Item
          key={t.id}
          id={themeOptionId(t.id)}
          value={t.id}
          className="flex flex-col gap-2 rounded-lg border-2 border-border bg-surface p-2 text-left text-text hover:bg-surface-hover data-[state=checked]:border-accent"
        >
          <ThemePreview theme={t} scheme={scheme} />
          <span className="flex items-center justify-between px-1 pb-0.5 text-sm font-medium">
            {t.displayName}
            <RadioGroup.Indicator className="inline-flex">
              <Check aria-hidden="true" size={16} className="text-accent" />
            </RadioGroup.Indicator>
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
