import type { Consultable } from '../../db/pool.js';

export type FilaServicio = { id: string; nombre: string; duracion_min: number; precio: string };

const COLUMNAS = 'id, nombre, duracion_min, precio';

// Solo los servicios activos: los borrados se conservan para las citas pasadas
export const listarServicios = async (db: Consultable, empresaId: string) =>
  (
    await db.query<FilaServicio>(
      `SELECT ${COLUMNAS} FROM servicios WHERE empresa_id = $1 AND activo ORDER BY nombre`,
      [empresaId],
    )
  ).rows;

export const crearServicio = async (
  db: Consultable,
  s: { id: string; empresaId: string; nombre: string; duracionMin: number; precio: number },
) =>
  (
    await db.query<FilaServicio>(
      `INSERT INTO servicios (id, empresa_id, nombre, duracion_min, precio)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${COLUMNAS}`,
      [s.id, s.empresaId, s.nombre, s.duracionMin, s.precio],
    )
  ).rows[0];

// Solo cambia los campos enviados. Las citas ya agendadas guardan su propio
// precio y duración, así que no cambian.
export const actualizarServicio = async (
  db: Consultable,
  p: { id: string; empresaId: string; nombre?: string; duracionMin?: number; precio?: number },
) =>
  (
    await db.query<FilaServicio>(
      `UPDATE servicios
       SET nombre = COALESCE($3, nombre),
           duracion_min = COALESCE($4, duracion_min),
           precio = COALESCE($5, precio)
       WHERE id = $1 AND empresa_id = $2 AND activo
       RETURNING ${COLUMNAS}`,
      [p.id, p.empresaId, p.nombre ?? null, p.duracionMin ?? null, p.precio ?? null],
    )
  ).rows[0];

// Borrado lógico: deja de ofrecerse, pero las citas pasadas lo siguen mostrando
export const desactivarServicio = async (db: Consultable, id: string, empresaId: string) =>
  ((await db.query('UPDATE servicios SET activo = false WHERE id = $1 AND empresa_id = $2 AND activo', [id, empresaId]))
    .rowCount ?? 0) > 0;
