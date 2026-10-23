// Ajustes → Apariencia (docs/DESIGN.md §14.9): tema (ThemePicker), esquema Claro/Oscuro/Sistema
// (solo si el tema lo admite) y "Aplicar a: solo mi perfil / toda la app" (§15.9).
import { RadioGroup } from 'radix-ui';
import type { ColorSchemePref } from '@shared/types';
import { useSessionStore } from '../../stores/session-store';
import { useTheme } from '../../themes/use-theme';
import { changeApplyTo, selectScheme, selectTheme, type ApplyTo } from './appearance-actions';
import { ThemePicker } from './ThemePicker';

const SCHEMES: { value: ColorSchemePref; label: string }[] = [
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Oscuro' },
  { value: 'system', label: 'Sistema' },
];

const SCOPES: { value: ApplyTo; label: string }[] = [
  { value: 'profile', label: 'Solo mi perfil' },
  { value: 'app', label: 'Toda la app' },
];

function Radios<T extends string>({
  labelledBy,
  value,
  options,
  onChange,
}: {
  labelledBy: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
}) {
  return (
    <RadioGroup.Root
      aria-labelledby={labelledBy}
      value={value}
      onValueChange={(v) => {
        const option = options.find((o) => o.value === v);
        if (option) onChange(option.value);
      }}
      className="flex flex-wrap gap-x-6 gap-y-2"
    >
      {options.map((o) => (
        <div key={o.value} className="flex items-center gap-2">
          <RadioGroup.Item
            id={`${labelledBy}-${o.value}`}
            value={o.value}
            className="flex size-5 items-center justify-center rounded-full border-2 border-border-strong bg-surface data-[state=checked]:border-accent"
          >
            <RadioGroup.Indicator className="block size-2.5 rounded-full bg-accent" />
          </RadioGroup.Item>
          <label htmlFor={`${labelledBy}-${o.value}`} className="text-sm text-text">
            {o.label}
          </label>
        </div>
      ))}
    </RadioGroup.Root>
  );
}

export function AppearanceTab() {
  const prefs = useSessionStore((s) => s.prefs);
  const { def, scheme, schemePref } = useTheme();
  const applyTo: ApplyTo =
    prefs && (prefs.themeId !== null || prefs.colorScheme !== null) ? 'profile' : 'app';

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 id="appearance-theme" className="text-lg font-semibold text-text">
          Tema
        </h2>
        <ThemePicker
          labelledBy="appearance-theme"
          value={def.id}
          scheme={scheme}
          onChange={(id) => void selectTheme(id, applyTo)}
        />
      </section>
      <section className="flex flex-col gap-3">
        <h2 id="appearance-scheme" className="text-lg font-semibold text-text">
          Modo de color
        </h2>
        {def.schemes.length > 1 ? (
          <Radios
            labelledBy="appearance-scheme"
            value={schemePref}
            options={SCHEMES}
            onChange={(v) => void selectScheme(v, applyTo)}
          />
        ) : (
          <p className="text-sm text-text-muted">
            «{def.displayName}» solo tiene modo {def.schemes[0] === 'light' ? 'claro' : 'oscuro'}.
          </p>
        )}
      </section>
      <section className="flex flex-col gap-3">
        <h2 id="appearance-scope" className="text-lg font-semibold text-text">
          Aplicar a
        </h2>
        <Radios
          labelledBy="appearance-scope"
          value={applyTo}
          options={SCOPES}
          onChange={(v) => void changeApplyTo(v, { themeId: def.id, schemePref })}
        />
        <p className="text-sm text-text-muted">
          «Toda la app» también cambia el tema del selector de perfiles.
        </p>
      </section>
    </div>
  );
}
