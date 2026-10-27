// Ajustes → Presentación (docs/DESIGN.md §14.9 y §17.2): los valores por defecto de las
// presentaciones que no tienen ajustes propios (los de una playlist se guardan desde su
// presentación). Se editan con el mismo formulario que el diálogo de inicio y se guardan con
// `presentation:saveDefaults` (la parte en claro en prefs; las pistas, en la DB cifrada).
import { useEffect, useState } from 'react';
import type { AppError } from '@shared/errors';
import type { PresentationSettings } from '@shared/types';
import { Button } from '../../components/Button';
import { errorMessage } from '../../lib/errors-es';
import { invoke } from '../../lib/ipc';
import { saveAsDefaults } from '../../stores/presentation-store';
import { PresentationSettingsForm } from '../presentation/PresentationSettingsForm';
import { cloneSettings } from '../presentation/presentation-form-model';
import type { TransitionSetting } from '../presentation/transitions';

export function PresentationTab() {
  const [settings, setSettings] = useState<PresentationSettings | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [last, setLast] = useState<TransitionSetting>('fade');

  useEffect(() => {
    let alive = true;
    void invoke('presentation:getConfig', {}).then((res) => {
      if (!alive) return;
      if (res.ok) setSettings(cloneSettings(res.data.settings));
      else setError(res.error);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return (
      <p role="alert" className="text-sm text-danger-text">
        {errorMessage(error)}
      </p>
    );
  }
  if (!settings) {
    return (
      <p role="status" className="text-sm text-text-muted">
        Cargando…
      </p>
    );
  }

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    if (await saveAsDefaults(settings)) setDirty(false);
    setSaving(false);
  };

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <section className="flex flex-col gap-1" aria-labelledby="presentation-defaults-heading">
        <h2 id="presentation-defaults-heading" className="text-lg font-semibold text-text">
          Valores predeterminados
        </h2>
        <p className="max-w-prose text-sm text-text-muted">
          Se usan en las presentaciones que no tienen ajustes propios. Los ajustes de una playlist
          se guardan desde su presentación («Guardar para esta playlist»).
        </p>
      </section>
      <PresentationSettingsForm
        settings={settings}
        context="defaults"
        lastTransition={last}
        onChange={(patch) => {
          if (patch.transition && patch.transition !== 'none') setLast(patch.transition);
          setSettings({ ...settings, ...patch });
          setDirty(true);
        }}
      />
      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={saving || !dirty} onClick={() => void save()}>
          Guardar
        </Button>
        {dirty ? <p className="text-sm text-text-muted">Hay cambios sin guardar.</p> : null}
      </div>
    </div>
  );
}
