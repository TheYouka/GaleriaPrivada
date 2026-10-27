// Diálogo de inicio de la presentación (docs/DESIGN.md §17.1 y §17.2): transición, duración, bucle,
// ventana o pantalla completa, música y modo de audio, con los valores efectivos (los de la playlist
// o los predeterminados). «Iniciar presentación» la lanza con lo que se ve; «Guardar como
// predeterminado» y, si viene de una playlist, «Guardar para esta playlist» los guardan sin empezar.
import { useState } from 'react';
import { Play } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { Button } from '../../components/Button';
import {
  beginPresentation,
  cancelSetup,
  changeSetup,
  saveAsDefaults,
  saveForPlaylist,
  usePresentationStore,
} from '../../stores/presentation-store';
import { plural } from '../../stores/playlists-store';
import { PresentationSettingsForm } from './PresentationSettingsForm';
import type { TransitionSetting } from './transitions';

export function PresentationSetupDialog() {
  const setup = usePresentationStore((s) => s.setup);
  const [last, setLast] = useState<TransitionSetting>('fade');
  const [saving, setSaving] = useState(false);

  const save = async (kind: 'defaults' | 'playlist'): Promise<void> => {
    if (!setup || saving) return;
    setSaving(true);
    if (kind === 'defaults') await saveAsDefaults(setup.settings);
    else if (setup.playlist) await saveForPlaylist(setup.playlist, setup.settings);
    setSaving(false);
  };

  return (
    <Dialog.Root
      open={setup !== null}
      onOpenChange={(open) => {
        if (!open) cancelSetup();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-presentation-setup=""
          aria-describedby="presentation-setup-description"
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-3rem)] w-[min(60rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-bg-elevated text-text shadow-lg"
          // Si empieza la presentación, el foco es de ella; si se cancela, vuelve al control de origen.
          onCloseAutoFocus={(e) => {
            if (usePresentationStore.getState().active) e.preventDefault();
          }}
        >
          <div className="px-6 pt-6 pb-3">
            <Dialog.Title className="text-xl font-semibold">Presentación</Dialog.Title>
            <Dialog.Description
              id="presentation-setup-description"
              className="mt-1 text-sm text-text-muted"
            >
              {setup
                ? `${plural(setup.items.length, 'elemento', 'elementos')}${
                    setup.playlist ? ` de «${setup.playlist.name}»` : ''
                  }. Elige cómo quieres verla.`
                : ''}
            </Dialog.Description>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-2">
            {setup ? (
              <PresentationSettingsForm
                settings={setup.settings}
                context="setup"
                lastTransition={last}
                onChange={(patch) => {
                  if (patch.transition && patch.transition !== 'none') setLast(patch.transition);
                  changeSetup(patch);
                }}
              />
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-6 py-4">
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => void save('defaults')}
            >
              Guardar como predeterminado
            </Button>
            {setup?.playlist ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={() => void save('playlist')}
              >
                Guardar para esta playlist
              </Button>
            ) : null}
            <span className="flex-1" />
            <Button disabled={saving} onClick={cancelSetup}>
              Cancelar
            </Button>
            <Button variant="primary" disabled={saving} onClick={beginPresentation}>
              <Play aria-hidden="true" size={16} strokeWidth={1.75} />
              Iniciar presentación
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
