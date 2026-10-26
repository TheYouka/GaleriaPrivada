// Render CSS de una foto con sus ediciones guardadas (docs/DESIGN.md §16.3, "Render en el renderer"),
// para el visor, el editor y, más adelante, la presentación. El original no se toca: se coloca con
// CSS y la miniatura de main se regenera aparte.
//
// El contenedor exterior (`overflow: hidden`, `container-type: size`) mide `width × height` px y tiene
// la proporción (w·W') / (h·H') del recorte. Con k = ancho / (w·W'), el lienzo de W'·k × H'·k se
// desplaza (−x·W'·k, −y·H'·k) y la <img> de W·k × H·k, centrada en el lienzo, lleva
// `scaleX(flip ? −1 : 1) rotate(q·90deg)`. CSS aplica las funciones de derecha a izquierda: primero
// rota y luego voltea, igual que T = F ∘ R^q. Con unidades de contenedor, W y H no hacen falta:
// k·W' = 100cqw / w y k·H' = 100cqh / h.
import type { CSSProperties, SyntheticEvent } from 'react';
import type { EditState } from '@shared/edits';

export interface EditedImageProps {
  src: string;
  /** Estado de las ediciones (foldEdits). */
  state: EditState;
  /** Tamaño en px de la caja que ocupa el recorte; su proporción tiene que ser la del recorte. */
  width: number;
  height: number;
  /** La <img> está oculta hasta que el padre confirme que la miniatura ya no hace falta. */
  hidden?: boolean;
  onLoad?: (event: SyntheticEvent<HTMLImageElement>) => void;
  onError?: () => void;
  className?: string;
  /** Marca para los tests (nombre del medio, nunca datos). */
  testId?: string;
}

export function EditedImage({
  src,
  state,
  width,
  height,
  hidden = false,
  onLoad,
  onError,
  className,
  testId,
}: EditedImageProps) {
  const { q, flip, crop } = state;
  const canvasW = `calc(100cqw / ${crop.w})`;
  const canvasH = `calc(100cqh / ${crop.h})`;
  const odd = q % 2 === 1;
  const imgStyle: CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    display: 'block',
    maxWidth: 'none',
    maxHeight: 'none',
    // Con un cuarto de vuelta impar el ancho de la imagen es el alto del lienzo, y al revés.
    width: odd ? canvasH : canvasW,
    height: odd ? canvasW : canvasH,
    transform: `translate(-50%, -50%) scaleX(${flip ? -1 : 1}) rotate(${q * 90}deg)`,
    visibility: hidden ? 'hidden' : 'visible',
  };
  return (
    <div
      className={className}
      data-edited-image={testId ?? ''}
      data-q={q}
      data-flip={flip ? 'true' : 'false'}
      style={{
        position: 'relative',
        overflow: 'hidden',
        containerType: 'size',
        width,
        height,
      }}
    >
      <div
        style={{
          position: 'absolute',
          width: canvasW,
          height: canvasH,
          left: `calc(-100cqw * ${crop.x} / ${crop.w})`,
          top: `calc(-100cqh * ${crop.y} / ${crop.h})`,
        }}
      >
        <img alt="" src={src} decoding="async" onLoad={onLoad} onError={onError} style={imgStyle} />
      </div>
    </div>
  );
}
