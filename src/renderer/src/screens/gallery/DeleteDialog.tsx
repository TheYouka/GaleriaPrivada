// Confirmación de borrado (docs/DESIGN.md §14.6, §12.10): el foco inicial está en "Cancelar" (lo
// pone ConfirmDialog) y el texto dice que el borrado es permanente: no hay papelera ni copia.
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { cancelDelete, confirmDelete, useLibraryStore } from '../../stores/library-store';
import { focusGalleryCell } from './gallery-focus';

export function DeleteDialog() {
  const ids = useLibraryStore((s) => s.deleteIds);
  const deleting = useLibraryStore((s) => s.deleting);
  const items = useLibraryStore((s) => s.items);
  const count = ids?.length ?? 0;
  const only = count === 1 ? items.find((i) => i.id === ids?.[0]) : undefined;
  const title =
    count === 1
      ? only
        ? `¿Eliminar «${only.name}»?`
        : '¿Eliminar este elemento?'
      : `¿Eliminar ${count} elementos?`;
  return (
    <ConfirmDialog
      open={ids !== null}
      onOpenChange={(open) => {
        if (!open) cancelDelete();
      }}
      title={title}
      description={
        count === 1
          ? 'Esta acción es permanente: el elemento se borra de la bóveda y no se puede recuperar.'
          : 'Esta acción es permanente: los elementos se borran de la bóveda y no se pueden recuperar.'
      }
      confirmLabel="Eliminar"
      onCloseAutoFocus={(e) => {
        if (focusGalleryCell()) e.preventDefault();
      }}
      danger
      busy={deleting}
      onConfirm={() => void confirmDelete()}
    >
      <p className="text-sm text-text-muted">No hay papelera ni copia de seguridad.</p>
    </ConfirmDialog>
  );
}
