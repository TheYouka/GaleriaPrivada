// Panel de ajustes de la presentación en curso (docs/DESIGN.md §17.2): se abre con el engranaje y
// cambia los ajustes en vivo (la transición y la duración desde la diapositiva siguiente; el audio,
// al momento). «Guardar como predeterminado» y, si viene de una playlist, «Guardar para esta
// playlist». Esc lo cierra antes de salir de la presentación.
import { useState } from 'react';
import { X } from 'lucide-react';
import type { PresentationSettings } from '@shared/types';
import { Button } from '../../components/Button';
import { IconButton } from '../../components/IconButton';
import {
  saveAsDefaults,
  saveForPlaylist,
  type ActivePresentation,
} from '../../stores/presentation-store';
import { PresentationSettingsForm } from './PresentationSettingsForm';
import type { TransitionSetting } from './transitions';

export interface PresentationSettingsPanelProps {
  settings: PresentationSettings;
  playlist: ActivePresentation['playlist'];
  onChange(patch: Partial<PresentationSettings>): void;
  onClose(): void;
}

export function PresentationSettingsPanel({
  settings,
  playlist,
  onChange,
  onClose,
}: PresentationSettingsPanelProps) {
  const [last, setLast] = useState<TransitionSetting>('fade');
  const [saving, setSaving] = useState(false);

  const save = async (kind: 'defaults' | 'playlist'): Promise<void> => {
    if (saving) return;
    setSaving(true);
    if (kind === 'defaults') await saveAsDefaults(settings);
    else if (playlist) await saveForPlaylist(playlist, settings);
    setSaving(false);
  };

  return (
    <section
      aria-label="Ajustes de la presentación"
      data-presentation-panel=""
      className="absolute top-3 right-3 bottom-24 z-20 flex w-[min(24rem,calc(100%-1.5rem))] flex-col rounded-lg border border-border bg-bg-elevated/95 text-text shadow-lg backdrop-blur-sm"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-2">
        <h2 className="min-w-0 flex-1 text-base font-semibold">Ajustes</h2>
        <IconButton label="Cerrar los ajustes (Esc)" icon={X} onClick={onClose} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <PresentationSettingsForm
          settings={settings}
          context="live"
          lastTransition={last}
          onChange={(patch) => {
            if (patch.transition && patch.transition !== 'none') setLast(patch.transition);
            onChange(patch);
          }}
        />
      </div>
      <footer className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
        <Button size="sm" disabled={saving} onClick={() => void save('defaults')}>
          Guardar como predeterminado
        </Button>
        {playlist ? (
          <Button size="sm" disabled={saving} onClick={() => void save('playlist')}>
            Guardar para esta playlist
          </Button>
        ) : null}
      </footer>
    </section>
  );
}
