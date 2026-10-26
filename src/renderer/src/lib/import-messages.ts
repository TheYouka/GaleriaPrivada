// Textos en español del resumen de una importación (docs/DESIGN.md §14.6): el motivo de cada archivo
// fallido y de cada original que no se pudo borrar. main solo envía códigos.
import type { ImportFailureCode, ImportProgress, ImportReport } from '@shared/types';

export const IMPORT_FAILURE_MESSAGES: Readonly<Record<ImportFailureCode, string>> = Object.freeze({
  UNSUPPORTED_FORMAT: 'Formato no compatible',
  TOO_LARGE: 'Demasiado grande',
  DISK_FULL: 'No queda espacio en el disco',
  IO: 'No se pudo leer o escribir',
  INTEGRITY: 'La copia cifrada no coincidía con el original',
  FFMPEG_MISSING: 'Falta el componente de vídeo de Galería',
  FFMPEG_FAILED: 'No se pudo procesar el vídeo',
  CANCELLED: 'Importación cancelada',
  CHANGED_DURING_IMPORT: 'El archivo cambió durante la importación',
});

export const NOT_DELETED_MESSAGES: Readonly<
  Record<ImportReport['originalsNotDeleted'][number]['reason'], string>
> = Object.freeze({
  IO: 'No se pudo borrar el original',
  CHANGED_DURING_IMPORT: 'El archivo cambió durante la importación, así que no se tocó',
  CANCELLED: 'Importación cancelada antes de borrarlo',
});

export const PHASE_LABELS: Readonly<Record<ImportProgress['phase'], string>> = Object.freeze({
  scanning: 'Buscando archivos…',
  'awaiting-confirmation': 'Esperando tu confirmación…',
  encrypting: 'Cifrando…',
  converting: 'Convirtiendo vídeo…',
  verifying: 'Comprobando la copia…',
  finalizing: 'Guardando…',
});

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Frase con el recuento del resumen, para el aviso y el lector de pantalla. */
export function importSummaryText(report: ImportReport): string {
  const parts = [plural(report.imported, 'importado', 'importados')];
  if (report.duplicates > 0) parts.push(plural(report.duplicates, 'duplicado', 'duplicados'));
  if (report.skipped > 0) parts.push(plural(report.skipped, 'omitido', 'omitidos'));
  if (report.failed.length > 0) parts.push(plural(report.failed.length, 'fallido', 'fallidos'));
  return `${report.cancelled ? 'Importación cancelada' : 'Importación terminada'}: ${parts.join(', ')}.`;
}
