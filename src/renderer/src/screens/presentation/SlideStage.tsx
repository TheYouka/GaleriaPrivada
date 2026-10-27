// Escenario de la presentación (docs/DESIGN.md §17.3 y §17.5): las capas de las diapositivas sobre
// fondo negro. Una capa por diapositiva cargada (la actual, la que entra o sale y la precargada,
// oculta con la imagen ya decodificada); la animación la hace `StageAnimator` con Motion. El
// contenido no depende del tema: es negro con la foto o el vídeo `contain`.
//
// - Foto: `<img>` (o `EditedImage` si tiene ediciones de la Fase 3, la misma versión que el visor);
//   al cargar se espera a `decode()` y se avisa al anfitrión.
// - Vídeo: uno de los 3 `<video crossOrigin="anonymous">` del pool, creados al empezar y conectados
//   a Web Audio una sola vez (`PresentationRuntime`); aquí solo se coloca en la capa y se le da el
//   `src`. Al salir se libera con pause(), removeAttribute('src') y load() (§17.5).
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { mediaUrl } from '../../lib/vault-url';
import { EditedImage } from '../viewer/EditedImage';
import { useElementSize } from '../viewer/use-element-size';
import type { Size } from '../viewer/zoom-math';
import type { PresentationRuntime } from './presentation-runtime';
import { slideBox } from './slide-source';
import type { StageEntry } from './stage-model';

function PhotoContent({
  runtime,
  entry,
  stage,
}: {
  runtime: PresentationRuntime;
  entry: StageEntry;
  stage: Size;
}) {
  const slide = entry.slide;
  if (!slide) return null;
  const onLoad = (img: HTMLImageElement): void => {
    // La foto se considera lista cuando ya está decodificada: así la transición no la pinta a medias.
    void img
      .decode()
      .catch(() => undefined)
      .then(() => runtime.photoReady(entry.index));
  };
  if (slide.edited && slide.aspect !== null) {
    const box = slideBox(slide, stage);
    return (
      <EditedImage
        src={mediaUrl(slide.id)}
        state={slide.editState}
        width={box.w}
        height={box.h}
        testId="presentation"
        onLoad={(e) => onLoad(e.currentTarget)}
        onError={() => runtime.photoFailed(entry.index)}
      />
    );
  }
  return (
    <img
      alt=""
      src={mediaUrl(slide.id)}
      decoding="async"
      draggable={false}
      className="size-full object-contain"
      onLoad={(e) => onLoad(e.currentTarget)}
      onError={() => runtime.photoFailed(entry.index)}
    />
  );
}

function VideoMount({ runtime, entry }: { runtime: PresentationRuntime; entry: StageEntry }) {
  const mount = useRef<HTMLDivElement>(null);
  const { index, slot, slide } = entry;
  useLayoutEffect(() => {
    const host = mount.current;
    if (!host || slot === null || !slide) return;
    // El anfitrión pone el <video> del pool en la capa, le da el `src` y lo suelta al salir.
    return runtime.attachVideo(index, slot, slide, host);
  }, [runtime, index, slot, slide]);
  return <div ref={mount} className="size-full" />;
}

function SlideLayer({
  runtime,
  entry,
  stage,
}: {
  runtime: PresentationRuntime;
  entry: StageEntry;
  stage: Size;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { index } = entry;
  useLayoutEffect(() => {
    const l = layer.current;
    const c = content.current;
    if (!l || !c) return;
    runtime.animator.register(index, { layer: l, content: c });
    return () => runtime.animator.register(index, null);
  }, [runtime, index]);
  return (
    <div
      ref={layer}
      data-slide-layer={index}
      data-slide-role={entry.role}
      data-slide-ready={entry.ready ? 'true' : 'false'}
      className="pointer-events-none absolute inset-0 opacity-0"
    >
      <div ref={content} className="absolute inset-0 flex items-center justify-center">
        {entry.item.kind === 'photo' ? (
          <PhotoContent runtime={runtime} entry={entry} stage={stage} />
        ) : (
          <VideoMount runtime={runtime} entry={entry} />
        )}
      </div>
    </div>
  );
}

export function SlideStage({ runtime }: { runtime: PresentationRuntime }) {
  const entries = useSyncExternalStore(runtime.model.subscribe, runtime.model.getSnapshot);
  const [stageRef, size] = useElementSize();
  return (
    <div
      ref={stageRef}
      data-slide-stage=""
      className="absolute inset-0 overflow-hidden bg-black"
      aria-hidden="true"
    >
      {size
        ? entries.map((entry) => (
            <SlideLayer key={entry.index} runtime={runtime} entry={entry} stage={size} />
          ))
        : null}
    </div>
  );
}
