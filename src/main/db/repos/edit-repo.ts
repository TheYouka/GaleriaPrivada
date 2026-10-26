// Ediciones no destructivas (docs/DESIGN.md §9.2 `media_edits`, §16.3 y §16.5). P6: funciones con
// `db` como primer parámetro; SessionManager.getDb(epoch) es el único sitio que entrega la DB.
//
// El original nunca se toca: las ediciones son filas `media_edits` (una por operación, en orden
// por `seq`) y la miniatura se regenera con un objeto nuevo (vault/thumb-replace.ts). Revertir es
// sustituir la lista por [] (sin filas).
import { isEditOp } from '@shared/edits';
import { ID_PATTERN } from '@shared/constants';
import type { EditOp, Id, MediaKind } from '@shared/types';
import type { Db } from '../database';

function requireId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new RangeError('id inválido');
}

/**
 * Operaciones guardadas de un medio, en orden. Una fila ilegible o que no cumple las reglas de
 * §10.3 se omite (no impide ver ni editar el medio).
 */
export function listEdits(db: Db, mediaId: Id): EditOp[] {
  const rows = db
    .prepare('SELECT op_json FROM media_edits WHERE media_id = ? ORDER BY seq')
    .all(mediaId) as { op_json: string }[];
  const out: EditOp[] = [];
  for (const r of rows) {
    try {
      const op: unknown = JSON.parse(r.op_json);
      if (isEditOp(op)) out.push(op);
    } catch {
      // una operación ilegible se omite
    }
  }
  return out;
}

/** Lo que edits:save necesita de una fila `ready` (§16.5 paso 1), o null. */
export function editTarget(db: Db, mediaId: Id): { kind: MediaKind; thumbId: Id | null } | null {
  const row = db
    .prepare("SELECT kind, thumb_id FROM media WHERE id = ? AND state = 'ready'")
    .get(mediaId) as { kind: MediaKind; thumb_id: string | null } | undefined;
  return row ? { kind: row.kind, thumbId: row.thumb_id } : null;
}

/** Copia canónica de una operación para guardarla (solo sus claves, en orden fijo). */
function opJson(op: EditOp): string {
  switch (op.t) {
    case 'rotate':
      return JSON.stringify({ t: op.t, q: op.q });
    case 'flipH':
    case 'flipV':
      return JSON.stringify({ t: op.t });
    case 'crop':
      return JSON.stringify({ t: op.t, x: op.x, y: op.y, w: op.w, h: op.h });
  }
}

/**
 * §16.5 paso 5, en UNA transacción: sustituye las filas de `media_edits` por `ops`, pone la
 * miniatura nueva y hace `thumb_rev += 1`. Devuelve el `thumb_rev` nuevo y la miniatura anterior
 * (para el borrado criptográfico tras el COMMIT), o null si el medio ya no es una foto `ready`
 * (borrado mientras se renderizaba): en ese caso no cambia nada.
 */
export function saveEdits(
  db: Db,
  mediaId: Id,
  ops: readonly EditOp[],
  thumbId: Id,
  now: number = Date.now(),
): { thumbRev: number; oldThumbId: Id | null } | null {
  requireId(mediaId);
  requireId(thumbId);
  return db.transaction(() => {
    const row = db
      .prepare(
        "SELECT thumb_id, thumb_rev FROM media WHERE id = ? AND state = 'ready' AND kind = 'photo'",
      )
      .get(mediaId) as { thumb_id: string | null; thumb_rev: number } | undefined;
    if (!row) return null;
    db.prepare('DELETE FROM media_edits WHERE media_id = ?').run(mediaId);
    const insert = db.prepare(
      'INSERT INTO media_edits (media_id, seq, op_json, created_at) VALUES (?, ?, ?, ?)',
    );
    ops.forEach((op, seq) => insert.run(mediaId, seq, opJson(op), now));
    db.prepare('UPDATE media SET thumb_id = ?, thumb_rev = thumb_rev + 1 WHERE id = ?').run(
      thumbId,
      mediaId,
    );
    return { thumbRev: row.thumb_rev + 1, oldThumbId: row.thumb_id };
  })();
}
