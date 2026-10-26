// Arrastrar y soltar archivos y carpetas (docs/DESIGN.md §12.2 y §14.6): mientras se arrastra algo
// con archivos sobre la ventana, una capa "Suelta para importar"; al soltar, `galeria.importDropped`
// (el preload saca las rutas con webUtils.getPathForFile: el renderer nunca construye rutas). Los
// eventos se escuchan en la ventana para que soltar fuera de la galería tampoco navegue a un archivo.
import { useEffect, useState } from 'react';
import { Upload } from 'lucide-react';
import { announce } from '../../lib/announce';
import { importDropped } from '../../stores/import-store';

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

export function ImportDropZone() {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    // dragenter/dragleave se disparan en cada elemento que se cruza: se cuenta la profundidad.
    let depth = 0;
    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth += 1;
      setDragging(true);
      if (depth === 1) announce('Suelta para importar');
    };
    const onOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) void importDropped(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  if (!dragging) return null;
  return (
    <div
      data-testid="import-drop-overlay"
      className="pointer-events-none fixed inset-0 z-[55] flex items-center justify-center bg-black/60 p-8"
    >
      <div className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-white bg-black/50 px-16 py-12 text-white">
        <Upload aria-hidden="true" size={40} strokeWidth={1.5} />
        <p className="text-2xl font-semibold">Suelta para importar</p>
        <p className="text-sm">Archivos y carpetas. Los originales se borran al terminar.</p>
      </div>
    </div>
  );
}
