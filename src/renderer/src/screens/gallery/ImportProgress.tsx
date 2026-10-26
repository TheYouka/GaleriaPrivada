// Importación en la UI (docs/DESIGN.md §12.5.1 y §14.6): panel no modal abajo a la derecha con la barra,
// "12 de 40", la fase y "Cancelar"; el AlertDialog de conversión de D8 ("Omitir esos vídeos" con el
// foco inicial; Esc equivale a "Cancelar importación") y, al terminar, el resumen con los fallos y las
// rutas de los originales que no se pudieron borrar, seleccionables para borrarlos a mano. [H3-8] Es el
// único sitio donde el renderer ve rutas de disco, y son las de los originales del usuario.
import { useEffect, useMemo, useRef } from 'react';
import { AlertDialog } from 'radix-ui';
import { Button } from '../../components/Button';
import { announce } from '../../lib/announce';
import { formatBytes } from '../../lib/format';
import {
  IMPORT_FAILURE_MESSAGES,
  NOT_DELETED_MESSAGES,
  PHASE_LABELS,
  importSummaryText,
} from '../../lib/import-messages';
import {
  answerConfirm,
  cancelImport,
  closeImportReport,
  subscribeImport,
  useImportStore,
} from '../../stores/import-store';
import type { ImportReport } from '@shared/types';

/** Cuántos fallos y originales se listan; el resto se resume ("y 12 más"). */
const LIST_LIMIT = 8;

function ReportLists({ report }: { report: ImportReport }) {
  const { failed, originalsNotDeleted } = report;
  return (
    <>
      {failed.length > 0 ? (
        <section aria-labelledby="import-failed" className="mt-3">
          <h3 id="import-failed" className="text-sm font-semibold">
            No se importaron
          </h3>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {failed.slice(0, LIST_LIMIT).map((f, i) => (
              <li key={`${f.name}-${i}`} className="break-all">
                <span className="font-medium">{f.name}</span>
                <span className="text-text-muted"> · {IMPORT_FAILURE_MESSAGES[f.code]}</span>
              </li>
            ))}
            {failed.length > LIST_LIMIT ? (
              <li className="text-text-muted">y {failed.length - LIST_LIMIT} más</li>
            ) : null}
          </ul>
        </section>
      ) : null}
      {originalsNotDeleted.length > 0 ? (
        <section aria-labelledby="import-not-deleted" className="mt-3">
          <h3 id="import-not-deleted" className="text-sm font-semibold">
            Originales que no se pudieron borrar
          </h3>
          <p className="mt-1 text-xs text-text-muted">
            Su copia ya está en la bóveda. Puedes borrarlos tú desde el explorador de archivos.
          </p>
          <ul className="mt-1 flex flex-col gap-1.5 text-sm">
            {originalsNotDeleted.slice(0, LIST_LIMIT).map((o, i) => (
              <li key={`${o.path}-${i}`}>
                <code className="font-mono text-xs break-all select-all">{o.path}</code>
                <span className="block text-xs text-text-muted">
                  {NOT_DELETED_MESSAGES[o.reason]}
                </span>
              </li>
            ))}
            {originalsNotDeleted.length > LIST_LIMIT ? (
              <li className="text-text-muted">y {originalsNotDeleted.length - LIST_LIMIT} más</li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function Summary({ report }: { report: ImportReport }) {
  const rows: [string, number][] = [
    ['Importados', report.imported],
    ['Duplicados (ya estaban en la bóveda)', report.duplicates],
    ['Omitidos', report.skipped],
    ['Fallidos', report.failed.length],
  ];
  return (
    <>
      <h2 className="text-base font-semibold">
        {report.cancelled ? 'Importación cancelada' : 'Importación terminada'}
      </h2>
      <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-text-muted">{label}</dt>
            <dd className="text-right font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      <ReportLists report={report} />
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={closeImportReport}>
          Cerrar
        </Button>
      </div>
    </>
  );
}

export function ImportProgress() {
  const job = useImportStore((s) => s.job);
  const report = useImportStore((s) => s.report);
  const panelRef = useRef<HTMLDivElement>(null);
  const skipRef = useRef<HTMLButtonElement>(null);

  useEffect(() => subscribeImport(), []);

  // El resumen se anuncia una vez, con los recuentos.
  useEffect(() => {
    if (!report) return;
    announce(importSummaryText(report));
    // El botón "Cancelar" desaparece con el panel de progreso: que el foco no se pierda en el <body>.
    const focused = document.activeElement;
    if (!focused || focused === document.body) panelRef.current?.focus();
  }, [report]);

  const progress = job?.progress ?? null;
  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
  const phase = progress?.phase ?? 'scanning';
  const phaseLabel = job?.cancelling ? 'Cancelando…' : PHASE_LABELS[phase];
  // Texto para el lector de pantalla: cambia por fase y cada 10 %, no con cada actualización.
  const bucket = Math.floor(percent / 10);
  const live = useMemo(
    () => `${phaseLabel} ${total > 0 ? `${bucket * 10} %` : ''}`.trim(),
    [phaseLabel, bucket, total],
  );

  const confirm = job?.confirm ?? null;

  return (
    <>
      {job || report ? (
        <div
          ref={panelRef}
          role="region"
          aria-label="Importación"
          tabIndex={-1}
          className="fixed right-4 bottom-4 z-30 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-bg-elevated p-4 text-text shadow-lg"
        >
          {job ? (
            <>
              <h2 className="text-base font-semibold">Importando</h2>
              <p className="sr-only" aria-live="polite">
                {live}
              </p>
              <p className="mt-1 text-sm text-text-muted" aria-hidden="true">
                {phaseLabel}
              </p>
              <div
                role="progressbar"
                aria-label="Progreso de la importación"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={total > 0 ? `${done} de ${total}` : phaseLabel}
                className="mt-3 h-2 w-full overflow-hidden rounded-full bg-border-strong"
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-(--g-dur-fast)"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="mt-2 text-sm tabular-nums">
                {total > 0 ? `${done} de ${total}` : 'Preparando…'}
              </p>
              {progress?.currentName ? (
                <p className="mt-1 truncate text-xs text-text-muted" aria-hidden="true">
                  {progress.currentName}
                </p>
              ) : null}
              <div className="mt-4 flex justify-end">
                <Button disabled={job.cancelling} onClick={() => void cancelImport()}>
                  {job.cancelling ? 'Cancelando…' : 'Cancelar'}
                </Button>
              </div>
            </>
          ) : report ? (
            <Summary report={report} />
          ) : null}
        </div>
      ) : null}

      {/* D8 (§12.5.1): el foco inicial está en la opción que no pierde nada. */}
      <AlertDialog.Root open={confirm !== null}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
          <AlertDialog.Content
            className="fixed top-1/2 left-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-bg-elevated p-6 text-text shadow-lg"
            onEscapeKeyDown={(e) => {
              e.preventDefault();
              void cancelImport();
            }}
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              skipRef.current?.focus();
            }}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              panelRef.current?.focus();
            }}
          >
            <AlertDialog.Title className="text-xl font-semibold">
              Convertir vídeos
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-text">
              {confirm
                ? `${confirm.toConvert === 1 ? '1 vídeo' : `${confirm.toConvert} vídeos`} (${formatBytes(confirm.toConvertBytes)}) se ${confirm.toConvert === 1 ? 'convertirá' : 'convertirán'} a un formato compatible, con pérdida de calidad, y su original se borrará al terminar.`
                : null}
            </AlertDialog.Description>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <Button variant="primary" onClick={() => void answerConfirm(true)}>
                Convertir y borrar originales
              </Button>
              <Button ref={skipRef} onClick={() => void answerConfirm(false)}>
                Omitir esos vídeos
              </Button>
              <Button variant="ghost" onClick={() => void cancelImport()}>
                Cancelar importación
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}
