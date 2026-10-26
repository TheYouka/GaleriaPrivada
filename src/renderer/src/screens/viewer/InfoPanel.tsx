// Panel de información del visor (docs/DESIGN.md §16.1, tecla `I`): nombre, fecha, tamaño,
// dimensiones, duración y un resumen del EXIF. Es parte del cromo del visor, así que usa los tokens
// del tema; la foto no.
import type { ExifSummary, MediaDetail, MediaListItem } from '@shared/types';
import { formatBytes, formatDate, formatDuration, formatNaiveDate } from '../../lib/format';

export interface InfoPanelProps {
  item: MediaListItem;
  /** media:get del medio; null mientras llega (o si falló). */
  detail: MediaDetail | null;
}

const NUMBER = new Intl.NumberFormat('es', { maximumFractionDigits: 1 });

function exposure(seconds: number): string {
  if (seconds >= 1) return `${NUMBER.format(seconds)} s`;
  return `1/${Math.round(1 / seconds)} s`;
}

function exifRows(exif: ExifSummary | null | undefined): [string, string][] {
  if (!exif) return [];
  const rows: [string, string][] = [];
  const camera = [exif.cameraMake, exif.cameraModel].filter(Boolean).join(' ');
  if (camera) rows.push(['Cámara', camera]);
  if (exif.lensModel) rows.push(['Objetivo', exif.lensModel]);
  if (exif.fNumber !== undefined) rows.push(['Apertura', `f/${NUMBER.format(exif.fNumber)}`]);
  if (exif.exposureS !== undefined && exif.exposureS > 0) {
    rows.push(['Exposición', exposure(exif.exposureS)]);
  }
  if (exif.iso !== undefined) rows.push(['ISO', String(exif.iso)]);
  if (exif.focalMm !== undefined)
    rows.push(['Distancia focal', `${NUMBER.format(exif.focalMm)} mm`]);
  return rows;
}

export function InfoPanel({ item, detail }: InfoPanelProps) {
  const rows: [string, string][] = [
    ['Nombre', item.ext ? `${item.name}.${item.ext}` : item.name],
    ['Tipo', detail?.mime ?? (item.kind === 'photo' ? 'Foto' : 'Vídeo')],
    ['Fecha de captura', formatNaiveDate(item.capturedAt)],
    ['Importado', formatDate(item.importedAt)],
    ['Tamaño', formatBytes(item.sizeBytes)],
  ];
  if (item.width !== null && item.height !== null) {
    rows.push(['Dimensiones', `${item.width} × ${item.height} px`]);
  }
  if (item.durationMs !== null) rows.push(['Duración', formatDuration(item.durationMs)]);
  if (detail && detail.edits.length > 0) rows.push(['Ediciones', 'Esta foto está editada']);
  rows.push(...exifRows(detail?.exif));
  return (
    <aside
      aria-label="Información"
      data-viewer-info=""
      className="flex w-80 shrink-0 flex-col gap-3 overflow-auto border-l border-border bg-bg-elevated p-4 text-text"
    >
      <h2 className="text-lg font-semibold">Información</h2>
      <dl className="flex flex-col gap-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-xs text-text-muted">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
