import type { Consultable } from '../../db/pool.js';

export type FilaProducto = {
  id: string;
  nombre: string;
  descripcion: string | null;
  precio: string;
  foto_url: string | null;
};

const COLUMNAS = 'id, nombre, descripcion, precio, foto_url';

export const listarProductos = async (db: Consultable, empresaId: string) =>
  (
    await db.query<FilaProducto>(`SELECT ${COLUMNAS} FROM productos WHERE empresa_id = $1 ORDER BY nombre`, [
      empresaId,
    ])
  ).rows;

// Catálogo para clientes: undefined si el código no corresponde a ningún negocio
export const listarCatalogoPorCodigo = async (db: Consultable, codigo: string) => {
  const { rows } = await db.query<{ empresa_id: string } & Partial<FilaProducto>>(
    `SELECT e.id AS empresa_id, p.id, p.nombre, p.descripcion, p.precio, p.foto_url
     FROM empresas e
     LEFT JOIN productos p ON p.empresa_id = e.id
     WHERE e.codigo_acceso = $1
     ORDER BY p.nombre`,
    [codigo],
  );
  if (!rows.length) return undefined;
  return rows.filter((r) => r.id) as FilaProducto[];
};

export const crearProducto = async (
  db: Consultable,
  p: { empresaId: string; nombre: string; precio: number; descripcion?: string | null },
) =>
  (
    await db.query<FilaProducto>(
      `INSERT INTO productos (empresa_id, nombre, precio, descripcion)
       VALUES ($1, $2, $3, $4)
       RETURNING ${COLUMNAS}`,
      [p.empresaId, p.nombre, p.precio, p.descripcion ?? null],
    )
  ).rows[0];

// Solo cambia los campos enviados. descripcion: undefined = no cambia, null = se borra.
export const actualizarProducto = async (
  db: Consultable,
  p: { id: string; empresaId: string; nombre?: string; precio?: number; descripcion?: string | null },
) =>
  (
    await db.query<FilaProducto>(
      `UPDATE productos
       SET nombre = COALESCE($3, nombre),
           precio = COALESCE($4, precio),
           descripcion = CASE WHEN $5::boolean THEN $6::varchar ELSE descripcion END
       WHERE id = $1 AND empresa_id = $2
       RETURNING ${COLUMNAS}`,
      [p.id, p.empresaId, p.nombre ?? null, p.precio ?? null, p.descripcion !== undefined, p.descripcion ?? null],
    )
  ).rows[0];

// Devuelve la foto que tenía, para borrar el archivo; undefined si no existía
export const borrarProducto = async (db: Consultable, id: string, empresaId: string) =>
  (
    await db.query<{ foto_url: string | null }>(
      'DELETE FROM productos WHERE id = $1 AND empresa_id = $2 RETURNING foto_url',
      [id, empresaId],
    )
  ).rows[0];

// Cambia (o quita, con null) la foto y devuelve la anterior para borrar el archivo
export const cambiarFotoProducto = async (db: Consultable, id: string, empresaId: string, fotoUrl: string | null) =>
  (
    await db.query<{ foto_anterior: string | null }>(
      `UPDATE productos p SET foto_url = $3
       FROM (SELECT id, foto_url FROM productos WHERE id = $1 AND empresa_id = $2 FOR UPDATE) anterior
       WHERE p.id = anterior.id
       RETURNING anterior.foto_url AS foto_anterior`,
      [id, empresaId, fotoUrl],
    )
  ).rows[0];
