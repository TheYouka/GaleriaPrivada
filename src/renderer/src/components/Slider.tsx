// Deslizador sobre Radix Slider (flechas, RePág/AvPág, Inicio/Fin). Lo usarán el volumen y los
// tiempos de la presentación (F3/F4).
import { Slider as RSlider } from 'radix-ui';

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onValueChange(value: number): void;
  /** Texto del valor para el lector de pantalla ("70 %"). */
  valueText?: string;
  disabled?: boolean;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onValueChange,
  valueText,
  disabled,
}: SliderProps) {
  return (
    <RSlider.Root
      className="relative flex h-6 w-full touch-none items-center data-disabled:opacity-50"
      value={[value]}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onValueChange={(v) => onValueChange(v[0] ?? value)}
    >
      <RSlider.Track className="relative h-1 grow rounded-full bg-border-strong">
        <RSlider.Range className="absolute h-full rounded-full bg-accent" />
      </RSlider.Track>
      <RSlider.Thumb
        aria-label={label}
        aria-valuetext={valueText}
        className="block size-4 rounded-full border-2 border-accent bg-bg-elevated shadow-sm"
      />
    </RSlider.Root>
  );
}
