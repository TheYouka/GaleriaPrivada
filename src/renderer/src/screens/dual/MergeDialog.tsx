// «Crear vídeo fusionado» (docs/DESIGN.md §18.1, §18.2 y §18.7): dos vídeos lado a lado en uno nuevo,
// con audio izquierdo, derecho, mezcla o ninguno y la duración del más corto o del más largo. La
// resolución de salida la calcula main (altura común, §18.2): aquí solo se muestra. Mientras se crea
// se ve el progreso con «Cancelar fusión» (ni Esc ni un clic fuera cierran el diálogo). Los errores se
// muestran con el mensaje de su código (merge-model.ts). Se monta en UnlockedApp para que
// `merge:progress` y `merge:done` no se pierdan al cambiar de pantalla.
import { useEffect, useId, useState } from 'react';
import { Check } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { MERGE_NAME_MAX } from '@shared/constants';
import type { MediaDetail } from '@shared/types';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { TextField } from '../../components/TextField';
import { cx } from '../../lib/cx';
import {
  cancelMerge,
  closeMergeDialog,
  startMerge,
  subscribeMerge,
  useDualStore,
} from '../../stores/dual-store';
import { useNavStore } from '../../stores/nav-store';
import {
  defaultMergeAudio,
  defaultMergeName,
  formatSize,
  isMergeAudioAvailable,
  MERGE_AUDIO_OPTIONS,
  MERGE_DURATION_OPTIONS,
  mergeOutputSize,
  percentOf,
  type MergeAudio,
  type MergeDuration,
} from './merge-model';

const EXISTED_MESSAGE = 'Ya existía un vídeo idéntico';

function Choices<T extends string>({
  legend,
  value,
  options,
  onChange,
  disabled,
  isDisabled,
  columns = 2,
}: {
  legend: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  disabled?: boolean;
  isDisabled?(value: T): boolean;
  columns?: 1 | 2;
}) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={labelId} className="text-sm font-medium text-text">
        {legend}
      </span>
      <RadioGroup.Root
        aria-labelledby={labelId}
        value={value}
        onValueChange={(v) => onChange(v as T)}
        disabled={disabled}
        className={cx('grid gap-x-4 gap-y-1.5', columns === 2 ? 'grid-cols-2' : 'grid-cols-1')}
      >
        {options.map((o) => {
          const id = `${labelId}-${o.value}`;
          const off = disabled === true || isDisabled?.(o.value) === true;
          return (
            <div key={o.value} className="flex items-center gap-2">
              <RadioGroup.Item
                id={id}
                value={o.value}
                disabled={off}
                className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-border-strong bg-surface disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent"
              >
                <RadioGroup.Indicator className="block size-2.5 rounded-full bg-accent" />
              </RadioGroup.Item>
              <label
                htmlFor={id}
                className={cx('text-sm', off ? 'text-text-muted opacity-60' : 'text-text')}
              >
                {o.label}
              </label>
            </div>
          );
        })}
      </RadioGroup.Root>
    </div>
  );
}

function MergeBody({ left, right }: { left: MediaDetail; right: MediaDetail }) {
  const merge = useDualStore((s) => s.merge);
  const [audio, setAudio] = useState<MergeAudio>(() =>
    defaultMergeAudio(left.hasAudio, right.hasAudio),
  );
  const [duration, setDuration] = useState<MergeDuration>('shortest');
  const [name, setName] = useState(() => defaultMergeName(new Date()));
  const [nameTouched, setNameTouched] = useState(false);

  const size = mergeOutputSize(left, right);
  const trimmed = name.trim();
  const nameError =
    trimmed.length === 0
      ? 'Escribe un nombre.'
      : trimmed.length > MERGE_NAME_MAX
        ? `El nombre no puede pasar de ${MERGE_NAME_MAX} caracteres.`
        : null;

  const submit = (): void => {
    setNameTouched(true);
    if (nameError) return;
    void startMerge({ leftId: left.id, rightId: right.id, audio, duration, name: trimmed });
  };

  const inputs = (
    <p className="mt-1 text-sm text-text-muted">
      <span className="font-medium text-text">Izquierdo:</span> {left.name}
      <br />
      <span className="font-medium text-text">Derecho:</span> {right.name}
    </p>
  );

  if (merge.name === 'running') {
    const percent = percentOf(merge.fraction);
    return (
      <div className="mt-3 flex flex-col gap-4" data-merge-phase="running">
        {inputs}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between text-sm">
            <span id="merge-progress-label" className="font-medium text-text">
              {merge.cancelling ? 'Cancelando…' : 'Creando el vídeo fusionado…'}
            </span>
            <span className="text-text-muted tabular-nums">{percent} %</span>
          </div>
          <div
            role="progressbar"
            aria-labelledby="merge-progress-label"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            data-merge-progress={percent}
            className="h-2 overflow-hidden rounded-full bg-border-strong"
          >
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200 motion-reduce:transition-none"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="text-xs text-text-muted">
            La inactividad no bloquea la bóveda mientras se crea. Bloquear a mano o suspender el
            equipo la cancelan.
          </p>
        </div>
        <div className="flex justify-end">
          <Button
            variant="secondary"
            aria-disabled={merge.cancelling ? 'true' : undefined}
            onClick={() => {
              if (!merge.cancelling) void cancelMerge();
            }}
          >
            {merge.cancelling ? 'Cancelando…' : 'Cancelar fusión'}
          </Button>
        </div>
      </div>
    );
  }

  if (merge.name === 'done') {
    return (
      <div className="mt-3 flex flex-col gap-4" data-merge-phase="done">
        <div role="status" className="flex items-start gap-2 text-text">
          <Check aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-accent" />
          <div className="flex flex-col gap-1">
            <p className="font-medium" data-merge-result={merge.existed ? 'existed' : 'created'}>
              {merge.existed ? EXISTED_MESSAGE : 'Vídeo fusionado creado'}
            </p>
            <p className="text-sm text-text-muted">
              {merge.existed
                ? 'No se ha creado un vídeo nuevo: el que ya existía sigue en la galería.'
                : 'Ya está en la galería, cifrado como el resto.'}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={closeMergeDialog}>
            Cerrar
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              closeMergeDialog();
              useNavStore.getState().navigate('gallery-videos');
            }}
          >
            Ver en la galería
          </Button>
        </div>
      </div>
    );
  }

  if (merge.name === 'failed') {
    return (
      <div className="mt-3 flex flex-col gap-4" data-merge-phase="failed">
        {inputs}
        <p role="alert" className="text-sm text-danger-text">
          {merge.message}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={closeMergeDialog}>
            Cerrar
          </Button>
          <Button
            variant="primary"
            onClick={() => useDualStore.setState({ merge: { name: 'form', error: null } })}
          >
            Volver a intentarlo
          </Button>
        </div>
      </div>
    );
  }

  // Formulario.
  return (
    <form
      className="mt-3 flex flex-col gap-4"
      data-merge-phase="form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {inputs}
      <Choices<MergeAudio>
        legend="Audio"
        value={audio}
        options={MERGE_AUDIO_OPTIONS}
        onChange={setAudio}
        isDisabled={(v) => !isMergeAudioAvailable(v, left.hasAudio, right.hasAudio)}
      />
      <Choices<MergeDuration>
        legend="Duración"
        value={duration}
        options={MERGE_DURATION_OPTIONS}
        onChange={setDuration}
        columns={1}
      />
      {size ? (
        <p className="text-sm text-text-muted" data-merge-size={formatSize(size)}>
          <span className="font-medium text-text">Resolución de salida:</span> {formatSize(size)}{' '}
          px. Los dos vídeos se escalan a la misma altura (la del más bajo, hasta 1080 px).
        </p>
      ) : null}
      <TextField
        label="Nombre"
        value={name}
        maxLength={MERGE_NAME_MAX}
        error={nameTouched ? nameError : null}
        onChange={(e) => setName(e.target.value)}
        autoComplete="off"
      />
      {merge.name === 'form' && merge.error ? (
        <p role="alert" className="text-sm text-danger-text">
          {merge.error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={closeMergeDialog}>
          Cancelar
        </Button>
        <Button type="submit" variant="primary">
          Crear vídeo fusionado
        </Button>
      </div>
    </form>
  );
}

export function MergeDialog() {
  const merge = useDualStore((s) => s.merge);
  const left = useDualStore((s) => s.left);
  const right = useDualStore((s) => s.right);
  useEffect(() => subscribeMerge(), []);

  // `done` sigue mostrándose aunque ya no estén los vídeos de la pantalla; el resto los necesita.
  const open = merge.name !== 'idle' && left !== null && right !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeMergeDialog();
      }}
      title="Crear vídeo fusionado"
      busy={merge.name === 'running'}
    >
      {left && right ? <MergeBody left={left} right={right} /> : null}
    </Dialog>
  );
}
