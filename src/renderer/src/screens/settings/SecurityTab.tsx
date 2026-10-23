// Ajustes → Seguridad (docs/DESIGN.md §14.9): bloqueo por inactividad, texto fijo por plataforma
// (§13.2), "Ocultar Galería en capturas de pantalla y grabaciones" (D15) y "Cambiar contraseña".
import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Select, Switch } from 'radix-ui';
import { AUTO_LOCK_MINUTES } from '@shared/constants';
import type { AutoLockMinutes, ProfilePrefs } from '@shared/types';
import { Button } from '../../components/Button';
import { errorMessage } from '../../lib/errors-es';
import { invoke } from '../../lib/ipc';
import { toast } from '../../lib/toast';
import { useSessionStore } from '../../stores/session-store';
import { ChangePasswordDialog } from '../profiles/ChangePasswordDialog';

function minutesLabel(m: AutoLockMinutes): string {
  if (m === 0) return 'Nunca';
  return m === 1 ? '1 minuto' : `${m} minutos`;
}

async function setPref(patch: Partial<ProfilePrefs>): Promise<void> {
  const res = await invoke('prefs:set', patch);
  if (res.ok) useSessionStore.getState().setPrefs(res.data);
  else toast(errorMessage(res.error), 'error');
}

export function SecurityTab() {
  const prefs = useSessionStore((s) => s.prefs);
  const profile = useSessionStore((s) => s.profile);
  const linux = useSessionStore((s) => s.appInfo?.platform === 'linux');
  const [changing, setChanging] = useState(false);
  if (!prefs || !profile) return null;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-text">Bloqueo</h2>
        <div className="flex flex-col gap-1.5">
          <span id="autolock-label" className="text-sm font-medium text-text">
            Bloquear por inactividad
          </span>
          <Select.Root
            value={String(prefs.autoLockMinutes)}
            onValueChange={(v) => {
              const minutes = AUTO_LOCK_MINUTES.find((m) => String(m) === v);
              if (minutes !== undefined) void setPref({ autoLockMinutes: minutes });
            }}
          >
            <Select.Trigger
              aria-labelledby="autolock-label"
              className="inline-flex h-10 w-56 items-center justify-between rounded-md border border-border-strong bg-surface px-3 text-sm text-text"
            >
              <Select.Value />
              <Select.Icon>
                <ChevronDown aria-hidden="true" size={16} />
              </Select.Icon>
            </Select.Trigger>
            <Select.Portal>
              <Select.Content
                position="popper"
                sideOffset={4}
                className="z-50 w-56 rounded-md border border-border bg-bg-elevated p-1 text-text shadow-md"
              >
                <Select.Viewport>
                  {AUTO_LOCK_MINUTES.map((m) => (
                    <Select.Item
                      key={m}
                      value={String(m)}
                      className="relative flex h-9 cursor-default items-center rounded-sm pr-3 pl-8 text-sm outline-none data-highlighted:bg-surface-hover data-highlighted:outline-2 data-highlighted:outline-focus-ring"
                    >
                      <Select.ItemIndicator className="absolute left-2 inline-flex">
                        <Check aria-hidden="true" size={16} />
                      </Select.ItemIndicator>
                      <Select.ItemText>{minutesLabel(m)}</Select.ItemText>
                    </Select.Item>
                  ))}
                </Select.Viewport>
              </Select.Content>
            </Select.Portal>
          </Select.Root>
        </div>
        <p className="max-w-prose text-sm text-text-muted">
          {linux
            ? 'Galería se bloquea siempre al suspender el equipo y, si tu escritorio lo informa, al bloquear la sesión.'
            : 'Galería se bloquea siempre al suspender el equipo y al bloquear la sesión.'}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-text">Capturas de pantalla</h2>
        <div className="flex items-start gap-3">
          <Switch.Root
            id="content-protection"
            checked={!linux && prefs.contentProtection}
            disabled={linux}
            onCheckedChange={(checked) => void setPref({ contentProtection: checked })}
            aria-describedby="content-protection-note"
            className="relative mt-0.5 h-6 w-11 shrink-0 rounded-full border-2 border-border-strong bg-surface transition-colors data-disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent"
          >
            <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-text transition-transform data-[state=checked]:translate-x-5 data-[state=checked]:bg-on-accent" />
          </Switch.Root>
          <div className="flex flex-col gap-1">
            <label htmlFor="content-protection" className="text-sm font-medium text-text">
              Ocultar Galería en capturas de pantalla y grabaciones
            </label>
            <p id="content-protection-note" className="max-w-prose text-sm text-text-muted">
              {linux
                ? 'No disponible en Linux'
                : 'Solo en Windows. Mientras esté activado, tampoco podrás hacer capturas de Galería ni compartir su ventana.'}
            </p>
          </div>
        </div>
      </section>

      <section className="flex flex-col items-start gap-3">
        <h2 className="text-lg font-semibold text-text">Contraseña</h2>
        <Button onClick={() => setChanging(true)}>Cambiar contraseña</Button>
      </section>

      <ChangePasswordDialog
        profile={changing ? profile : null}
        onClose={() => setChanging(false)}
      />
    </div>
  );
}
